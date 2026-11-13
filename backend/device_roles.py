"""第六版：「角色」模块（角色字典）。

设备表单的「角色」恢复为纯下拉，选项只来自本字典：8 个预置角色 +
管理员在「角色」模块中新增的自定义角色。字典也是后端写入校验的
唯一来源，避免页面下拉与库内值不一致。

规则：
- 预置角色由 seed_roles 幂等灌入，不可删除、不可改名，但可停用；
- 自定义角色可改名，改名时在同一 BEGIN IMMEDIATE 事务内级联同步 asset_devices.role；
- 删除仅允许「未被任何设备引用」的自定义角色，被引用的角色建议先停用；
- 上一版允许自由输入留下的历史角色会在启动时自动收录，设备下拉不会丢失当前值；
- 所有写操作统一写审计日志与 Webhook 事件，只读用户由 01 层中间件直接拒绝。
"""
from __future__ import annotations

import re
import sqlite3

from . import db, extended

# (角色值, 说明)。顺序即下拉顺序，与前端 ASSET_ROLE_LABEL 的中文名一一对应。
BUILTIN_ROLES: list[tuple[str, str]] = [
    ("core_switch", "核心层交换设备"),
    ("access_switch", "接入层交换设备"),
    ("router", "路由器 / 广域网出口"),
    ("firewall", "防火墙 / 边界安全"),
    ("load_balancer", "负载均衡设备"),
    ("server", "服务器 / 计算节点"),
    ("storage", "集中存储设备"),
    ("other", "其它未分类设备"),
]

KEY_MAX = 64
DESC_MAX = 128
KEY_RE = re.compile(r"[\w.\- ]+", re.UNICODE)
WRITE_FIELDS = {"key", "description", "enabled"}


def _clean_key(raw: object) -> str:
    """角色名称同时是保存到 asset_devices.role 的值；折叠空白后做长度与字符校验。"""
    key = " ".join(str(raw if raw is not None else "").split())
    if not 2 <= len(key) <= KEY_MAX:
        raise ValueError(f"角色名称需为 2–{KEY_MAX} 个字符")
    if not KEY_RE.fullmatch(key):
        raise ValueError("角色名称仅支持中英文、数字、. _ - 与空格")
    return key


def _clean_desc(raw: object) -> str:
    value = " ".join(str(raw if raw is not None else "").split())
    if len(value) > DESC_MAX:
        raise ValueError(f"角色说明不能超过 {DESC_MAX} 个字符")
    return value


def _clean_enabled(payload: dict, default: bool = True) -> bool:
    if "enabled" not in payload:
        return default
    value = payload["enabled"]
    if isinstance(value, str):
        return value.strip().lower() not in ("", "0", "false", "off", "no")
    return bool(value)


def _public(row: dict, usage: int = 0) -> dict:
    return {
        "key": row["key"],
        "description": row["description"] or "",
        "builtin": bool(row["builtin"]),
        "enabled": bool(row["enabled"]),
        "sort_order": row["sort_order"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "usage": usage,
    }


def _record(conn: sqlite3.Connection, action: str, key: str, detail: str,
            payload: dict, actor: str | None) -> None:
    who = f"（操作人 {actor}）" if actor else ""
    db.audit(conn, f"asset.role.{action}", None, detail + who)
    extended.emit(conn, f"asset.role.{action}", key,
                  {"key": key, "actor": actor, **payload})


# ---------------------------------------------------------------- 种子 / 兼容


def seed_roles(conn: sqlite3.Connection) -> None:
    """INSERT OR IGNORE 幂等：预置角色 + 吸收历史自由输入过的角色值。

    在 assets.seed_assets 之后调用，保证上一版允许自由输入写下的角色不会
    在新版下拉里消失；用户删除 / 停用过的角色不会被重新覆盖。
    """
    now = db.now()
    for idx, (key, desc) in enumerate(BUILTIN_ROLES, 1):
        conn.execute(
            "INSERT OR IGNORE INTO asset_device_roles"
            "(key,description,builtin,enabled,sort_order,created_at,updated_at) "
            "VALUES(?,?,?,?,?,?,NULL)",
            (key, desc, 1, 1, idx, now),
        )
    legacy = conn.execute(
        "SELECT DISTINCT TRIM(role) AS role FROM asset_devices "
        "WHERE role IS NOT NULL AND TRIM(role)<>''").fetchall()
    order = conn.execute(
        "SELECT COALESCE(MAX(sort_order),0) FROM asset_device_roles").fetchone()[0]
    for row in legacy:
        key = str(row["role"]).strip()
        if not key or conn.execute(
                "SELECT 1 FROM asset_device_roles WHERE key=?", (key,)).fetchone():
            continue
        order += 1
        conn.execute(
            "INSERT OR IGNORE INTO asset_device_roles"
            "(key,description,builtin,enabled,sort_order,created_at,updated_at) "
            "VALUES(?,?,?,?,?,?,NULL)",
            (key, "由历史设备数据自动收录", 0, 1, order, now),
        )


def role_options(conn: sqlite3.Connection) -> list[dict]:
    """给设备清单 / 机柜二级页的角色下拉使用；禁用角色也返回，由前端过滤。"""
    return [
        {"id": r["key"], "name": r["key"],
         "enabled": bool(r["enabled"]), "builtin": bool(r["builtin"])}
        for r in conn.execute(
            "SELECT * FROM asset_device_roles ORDER BY builtin DESC, sort_order, key")
    ]


def role_keys(conn: sqlite3.Connection) -> set[str]:
    return {r["key"] for r in conn.execute("SELECT key FROM asset_device_roles")}


# ---------------------------------------------------------------- 读取


def list_roles(conn: sqlite3.Connection) -> dict:
    usage = {r["role"]: r["n"] for r in conn.execute(
        "SELECT role, COUNT(*) n FROM asset_devices "
        "WHERE role IS NOT NULL GROUP BY role")}
    items = [_public(dict(r), usage.get(r["key"], 0)) for r in conn.execute(
        "SELECT * FROM asset_device_roles ORDER BY builtin DESC, sort_order, key")]
    return {
        "items": items,
        "stats": {
            "total": len(items),
            "builtin": sum(1 for x in items if x["builtin"]),
            "custom": sum(1 for x in items if not x["builtin"]),
            "enabled": sum(1 for x in items if x["enabled"]),
            "in_use": sum(1 for x in items if x["usage"] > 0),
            "devices": sum(usage.values()),
        },
        "options": {"roles": role_options(conn)},
    }


# ---------------------------------------------------------------- 写入


def _check_payload(payload: dict) -> None:
    unknown = set(payload) - WRITE_FIELDS
    if unknown:
        raise ValueError("不支持的字段：" + "、".join(sorted(unknown)))


def create_role(conn: sqlite3.Connection, payload: dict,
                actor: str | None = None) -> dict:
    _check_payload(payload)
    key = _clean_key(payload.get("key"))
    desc = _clean_desc(payload.get("description"))
    enabled = _clean_enabled(payload, True)
    conn.execute("BEGIN IMMEDIATE")
    try:
        if conn.execute("SELECT 1 FROM asset_device_roles WHERE key=?", (key,)).fetchone():
            raise ValueError(f"角色「{key}」已存在")
        sort_order = conn.execute(
            "SELECT COALESCE(MAX(sort_order),0)+1 FROM asset_device_roles").fetchone()[0]
        now = db.now()
        conn.execute(
            "INSERT INTO asset_device_roles"
            "(key,description,builtin,enabled,sort_order,created_at,updated_at) "
            "VALUES(?,?,?,?,?,?,NULL)",
            (key, desc, 0, int(enabled), sort_order, now),
        )
        _record(conn, "create", key,
                f"CREATE 角色 {key} · {'启用' if enabled else '停用'}",
                {"description": desc, "enabled": enabled}, actor)
        conn.commit()
        return {**_public({"key": key, "description": desc, "builtin": 0,
                           "enabled": int(enabled), "sort_order": sort_order,
                           "created_at": now, "updated_at": None}),
                "created": True}
    except Exception:
        conn.rollback()
        raise


def update_role(conn: sqlite3.Connection, key: str, payload: dict,
                actor: str | None = None) -> dict:
    """编辑角色：说明 / 启用状态可改；自定义角色还可改名并级联同步设备。"""
    _check_payload(payload)
    conn.execute("BEGIN IMMEDIATE")
    try:
        row = conn.execute("SELECT * FROM asset_device_roles WHERE key=?",
                           (key,)).fetchone()
        if not row:
            raise LookupError(f"角色「{key}」不存在")
        before = dict(row)
        new_key = _clean_key(payload.get("key")) if "key" in payload else key
        if new_key != key and before["builtin"]:
            raise ValueError("预置角色名称不可修改；如需其它名称请新建自定义角色")
        desc = (_clean_desc(payload["description"]) if "description" in payload
                else before["description"])
        enabled = _clean_enabled(payload, bool(before["enabled"]))
        renamed = new_key != key
        if renamed and conn.execute(
                "SELECT 1 FROM asset_device_roles WHERE key=?", (new_key,)).fetchone():
            raise ValueError(f"角色「{new_key}」已存在")
        changes = [name for name, value in
                   (("key", new_key), ("description", desc), ("enabled", int(enabled)))
                   if before[name] != value]
        if not changes:
            conn.rollback()
            return {**_public(before), "unchanged": True, "changes": [],
                    "previous_key": None, "references_updated": 0}

        refs = 0
        if renamed:
            refs = conn.execute(
                "UPDATE asset_devices SET role=? WHERE role=?", (new_key, key)).rowcount
        stamp = db.now()
        conn.execute(
            "UPDATE asset_device_roles SET key=?,description=?,enabled=?,updated_at=? "
            "WHERE key=?",
            (new_key, desc, int(enabled), stamp, key),
        )
        detail = (f"UPDATE 角色 {key}"
                  + (f" → {new_key}（同步 {refs} 台设备）" if renamed else "")
                  + f" · {', '.join(changes)}")
        _record(conn, "update", new_key, detail,
                {"previous_key": key if renamed else None,
                 "references_updated": refs, "changes": changes,
                 "enabled": enabled}, actor)
        conn.commit()
        return {**_public({"key": new_key, "description": desc,
                           "builtin": before["builtin"], "enabled": int(enabled),
                           "sort_order": before["sort_order"],
                           "created_at": before["created_at"], "updated_at": stamp}),
                "previous_key": key if renamed else None,
                "references_updated": refs, "changes": changes}
    except Exception:
        conn.rollback()
        raise


def delete_role(conn: sqlite3.Connection, key: str,
                actor: str | None = None) -> dict:
    conn.execute("BEGIN IMMEDIATE")
    try:
        row = conn.execute("SELECT * FROM asset_device_roles WHERE key=?",
                           (key,)).fetchone()
        if not row:
            raise LookupError(f"角色「{key}」不存在")
        if row["builtin"]:
            raise ValueError("预置角色不可删除；如不再使用可改为「停用」")
        usage = conn.execute(
            "SELECT COUNT(*) FROM asset_devices WHERE role=?", (key,)).fetchone()[0]
        if usage:
            raise ValueError(f"角色「{key}」已被 {usage} 台设备引用，"
                             "请先修改这些设备的角色，或改为「停用」")
        conn.execute("DELETE FROM asset_device_roles WHERE key=?", (key,))
        _record(conn, "delete", key, f"DELETE 角色 {key}", {}, actor)
        conn.commit()
        return {"key": key, "deleted": True}
    except Exception:
        conn.rollback()
        raise
