"""地址记录行操作：IP 登记信息编辑。

状态变更仍只允许通过领域核心层状态机（db.transition）执行，本模块只负责
主机名 / 业务系统 / 负责人 / VLAN 这类描述性字段，所有写入统一落审计与 Webhook。
"""
from __future__ import annotations

from . import db, domain, extended

EDITABLE = {
    "hostname": "主机名",
    "business": "业务系统",
    "owner": "负责人",
    "vlan": "VLAN",
}
TEXT_MAX = 64


def _clean_text(field: str, value) -> str:
    if value is None:
        raise ValueError(f"{EDITABLE[field]}不能为空")
    text = str(value).strip()
    if not text:
        raise ValueError(f"{EDITABLE[field]}不能为空")
    if len(text) > TEXT_MAX:
        raise ValueError(f"{EDITABLE[field]}长度不能超过 {TEXT_MAX} 个字符")
    return text


def _clean_vlan(value) -> int | None:
    if value is None or str(value).strip() == "":
        return None
    try:
        vlan = int(str(value).strip())
    except (TypeError, ValueError) as exc:
        raise ValueError("VLAN 必须是 1–4094 的整数，留空表示清除") from exc
    if not 1 <= vlan <= 4094:
        raise ValueError("VLAN 必须是 1–4094 的整数，留空表示清除")
    return vlan


def update_ip(conn, addr: str, payload: dict, vrf=None) -> dict:
    """按 (vrf, IP) 编辑已登记 IP 的描述性字段，返回更新后的完整记录与变更明细。"""
    plane = db.current_vrf() if vrf is None else vrf
    if plane == db.ALL_VRFS:
        raise ValueError("请先选择具体的 VRF 地址平面，不能在汇总视图下编辑地址")
    value = domain.parse_ipv4(addr)
    canonical = domain.to_ip(value)
    unknown = set(payload) - set(EDITABLE)
    if unknown:
        raise ValueError("不支持修改的字段：" + ", ".join(sorted(unknown)))
    if not payload:
        raise ValueError("没有需要修改的字段")
    cond, extra = db.vrf_sql(plane, joiner="AND")

    conn.execute("BEGIN IMMEDIATE")
    try:
        row = conn.execute("SELECT * FROM ip_addresses WHERE addr_int=?" + cond,
                           [value] + extra).fetchone()
        if row is None:
            raise LookupError(f"{canonical} 在 {plane} 平面未登记占用，无法编辑登记信息")

        fields: dict = {}
        labels: list[str] = []
        for key, label in EDITABLE.items():
            if key not in payload:
                continue
            new = _clean_vlan(payload[key]) if key == "vlan" else _clean_text(key, payload[key])
            old = row[key]
            if old == new:
                continue
            fields[key] = new
            labels.append(f"{label} {old if old not in (None, '') else '—'} → "
                          f"{new if new not in (None, '') else '—'}")

        if not fields:
            conn.rollback()   # 未产生写入时也要结束事务，避免连接残留打开的事务
            return {"item": dict(row), "changes": [], "unchanged": True}

        fields["updated_at"] = db.now()   # 更新过的记录排到地址记录表最前
        clause = ", ".join(f"{k}=?" for k in fields)
        conn.execute(f"UPDATE ip_addresses SET {clause} WHERE addr_int=?" + cond,
                     [*fields.values(), value] + extra)
        fresh = conn.execute("SELECT * FROM ip_addresses WHERE addr_int=?" + cond,
                             [value] + extra).fetchone()
        db.audit(conn, "ip.update", canonical,
                 f"[{plane}] 编辑登记信息：" + "；".join(labels), plane)
        extended.emit(conn, "ip.updated", canonical,
                      {"vrf": plane,
                       "changes": {k: v for k, v in fields.items() if k != "updated_at"}})
        conn.commit()
        return {"item": dict(fresh), "changes": labels, "unchanged": False}
    except Exception:
        conn.rollback()
        raise
    # 连接生命周期由 app._run 统一管理
