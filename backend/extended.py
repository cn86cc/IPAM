"""第二版业务模块（对应架构图 02 / 04 层）。

闭环：集成数据源同步 → 发现记录 → 对账引擎生成差异 → 人工处理差异
     → 审批工单 → 通过后调用 03 层状态机/分配锁 → 审计日志 + Webhook。
所有写操作都收敛到领域核心层，前端不能直接改 IP 状态。
"""
from __future__ import annotations

import csv
import datetime
import io
import ipaddress
import json
import random
import re
import sqlite3

from . import db, domain

DIFF_TYPES = {
    "unregistered": ("未登记使用", "high"),
    "conflict": ("地址冲突", "high"),
    "zombie": ("僵尸 IP", "medium"),
    "dns_mismatch": ("DNS 不一致", "medium"),
}

TICKET_TYPES = {
    "allocate": "地址分配申请",
    "release": "地址回收申请",
    "expand": "网段扩容申请",
}

SOURCES = [
    ("dhcp", "DHCP 租约同步", "DHCP", "dhcp://10.0.0.10/leases", 1, "同步活跃租约与 MAC 绑定"),
    ("dns", "DNS 正反向解析", "DNS", "dns://10.0.0.11/zones", 1, "比对 A / PTR 与 IPAM 主机名"),
    ("cmdb", "CMDB 资产台账", "CMDB", "https://cmdb.internal/api/v1", 1, "资产序列号与负责人对齐"),
    ("snmp", "接入交换机 ARP / SNMP", "SNMP", "snmp://core-sw-01", 1, "读取 ARP 表与端口 MAC"),
    ("netflow", "NetFlow 流量对账", "NetFlow", "udp://10.0.0.12:2055", 1, "识别长期无流量僵尸 IP"),
    ("webhook", "告警 Webhook", "Webhook", "https://alert.internal/hooks/ipam", 0, "容量预警与冲突告警外发"),
]

# 安装完成后默认进入「全部 VRF · 跨平面对比」只读汇总视图。
# 'all' 是视图标识，不是 vrfs 表里的真实地址平面；要直接写数据需先切到具体平面。
DEFAULT_VRF_NOTE = (
    "登录后默认进入的视图：all = 全部 VRF 跨平面对比（只读），"
    "填具体平面名则默认进入该平面；用户手动切换后以手动选择为准")
LEGACY_DEFAULT_VRF_NOTES = (
    "登录后默认进入的 VRF 地址平面（用户手动切换后以手动选择为准）",
    "登录后默认进入的 VRF 地址平面",
    "新建地址空间 / 设备时默认选用的 VRF 分类标签",
    "新建地址空间时使用的地址平面",
)

SETTINGS = [
    ("warn_threshold", "80", "容量预警阈值 (%)", "利用率达到该值进入预警，取值范围 0–99"),
    ("crit_threshold", "90", "容量告警阈值 (%)", "利用率达到该值进入告警，需大于预警阈值"),
    ("reservation_ttl_hours", "24", "预留有效期 (小时)", "超时的预留地址由维护任务自动释放回可用池"),
    ("default_vrf", db.ALL_VRFS, "默认 VRF", DEFAULT_VRF_NOTE),
    ("gateway_offset", "1", "网关偏移", "每个网段第 N 个地址保留为默认网关"),
]

# 自定义页面的初始内容：首次访问返回该默认值，用户编辑后以 JSON 覆盖保存。
# 本系统 VRF 是真正隔离的地址平面：(vrf, cidr) / (vrf, addr) 才是唯一键。
PAGE_TONES = {"blue", "teal", "amber", "neutral"}
DEFAULT_PAGES = {
    "vrf": {
        "title": "VRF 地址平面",
        "subtitle": "按租户与业务划分的 IPv4 独立地址平面总览。本页标题、说明与内容块均可自由编辑，保存后持久化到数据库；每个 VRF 拥有彼此隔离的地址空间。",
        "blocks": [
            {
                "id": "principle", "tone": "blue", "title": "隔离原则",
                "body": "每个 VRF 是一张独立地址平面：CIDR 与 IP 可以在不同 VRF 内重复登记而互不冲突。\n"
                        "前缀重叠校验、IP 唯一性、容量与利用率统计都只在所属平面内进行。",
            },
            {
                "id": "convention", "tone": "teal", "title": "使用约定",
                "body": "命名使用小写字母、数字、- 或 _，例如 vrf-finance。\n"
                        "先用顶部「当前地址平面」切换器选定 VRF，再进行建前缀、划子网、分配与回收；"
                        "VRF 改名会在同一事务同步全部地址记录与引用，删除前需清空该平面。",
            },
            {
                "id": "boundary", "tone": "amber", "title": "术语与边界",
                "body": "地址空间树里的「汇聚前缀」是 kind=aggregate 的层级节点，与 VRF 地址平面无关。\n"
                        "IPAM 只登记地址，不配置网络设备转发表；只读用户可按「VRF:CIDR」授予可见范围。",
            },
        ],
    },
}


def emit(conn, event: str, target: str | None, payload: dict, vrf: str | None = None) -> None:
    """04 层告警外发：本地落一条 Webhook 事件，生产环境替换为 HTTP 投递。

    事件默认归属产生它的地址平面；汇总视图下产生的全局事件归入 default，
    避免把 'all' 这个视图标识当成真实平面写进数据。
    """
    plane = db.current_vrf() if vrf is None else (vrf or "default")
    if plane == db.ALL_VRFS:
        plane = "default"
    body = dict(payload)
    body.setdefault("vrf", plane)
    conn.execute(
        "INSERT INTO webhook_events(ts,event,target,payload,vrf) VALUES(?,?,?,?,?)",
        (db.now(), event, target, json.dumps(body, ensure_ascii=False), plane),
    )


def seed_config(conn: sqlite3.Connection) -> None:
    """配置类种子，INSERT OR IGNORE 幂等，且不会重新生成 IP 地址记录。"""
    now = db.now()
    conn.executemany(
        "INSERT OR IGNORE INTO vrfs(name,tenant,description,created_at) VALUES(?,?,?,?)",
        [
            ("default", "企业内网", "生产 / 办公 / DMZ 共用的默认地址平面", now),
            ("vrf-prod", "生产租户", "生产业务独立地址平面", now),
            ("vrf-lab", "研发租户", "研发与集成测试独立地址平面", now),
        ],
    )
    conn.executemany(
        "INSERT OR IGNORE INTO integration_sources"
        "(id,name,kind,endpoint,enabled,last_sync,sync_count,note) VALUES(?,?,?,?,?,?,?,?)",
        [(i, n, k, e, en, None, 0, note) for i, n, k, e, en, note in SOURCES],
    )
    conn.executemany(
        "INSERT OR IGNORE INTO settings(key,value,label,note) VALUES(?,?,?,?)", SETTINGS,
    )

    # 生产封版模式：只保留必需配置字典，跳过全部演示业务数据（重启后不再灌回）
    if not db.demo_seed_enabled():
        conn.commit()
        return

    if conn.execute("SELECT COUNT(*) FROM discovery_records").fetchone()[0] == 0:
        observations = [
            ("10.1.1.5", "3c:22:fb:10:01:05", "app-core-05", "snmp", "ARP 在线"),
            ("10.1.2.21", "3c:22:fb:10:02:21", "db-mysql-21", "dhcp", "活跃租约"),
            ("10.1.10.41", "3c:22:fb:10:10:41", "pc-office-41", "netflow", "30 天无流量"),
            ("10.9.2.7", "3c:22:fb:10:90:07", "dmz-proxy-07", "dns", "A 记录存在"),
            ("10.2.1.33", "3c:22:fb:10:21:33", "k8s-node-33", "cmdb", "资产在册"),
            ("10.8.1.12", "3c:22:fb:10:81:12", "app-test", "dns", "A 记录主机名不一致"),
            ("10.1.20.9", "3c:22:fb:10:12:09", "sw-access-09", "snmp", "ARP 在线"),
            ("10.2.3.18", "3c:22:fb:10:23:18", "spark-worker-18", "netflow", "近 7 天有流量"),
        ]
        for addr, mac, host, source, signal in observations:
            conn.execute(
                "INSERT INTO discovery_records(addr,prefix_cidr,mac,hostname,source,signal,observed_at) "
                "VALUES(?,?,?,?,?,?,?)",
                (addr, prefix_for(conn, addr), mac, host, source, signal, now),
            )

    if conn.execute("SELECT COUNT(*) FROM reconciliation_diffs").fetchone()[0] == 0:
        # 与「已清空 IP 地址」状态一致：全部来自外部观测、IPAM 尚无登记
        diffs = [
            ("10.1.1.5", "unregistered", "snmp", "ARP 表发现该地址在线，但 IPAM 无登记记录"),
            ("10.1.2.21", "unregistered", "dhcp", "DHCP 存在活跃租约，IPAM 未登记"),
            ("10.9.2.7", "unregistered", "dns", "DNS 存在 A 记录 dmz-proxy-07，IPAM 未登记"),
            ("10.2.1.33", "unregistered", "cmdb", "CMDB 资产在册并使用该地址，IPAM 未登记"),
            ("10.8.1.12", "dns_mismatch", "dns", "DNS A 记录指向 app-test，与 IPAM 登记不一致"),
        ]
        for addr, dtype, source, detail in diffs:
            label, severity = DIFF_TYPES[dtype]
            conn.execute(
                "INSERT INTO reconciliation_diffs"
                "(addr,prefix_cidr,type,severity,source,detail,status,discovered_at) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (addr, prefix_for(conn, addr), dtype, severity, source, detail, "open", now),
            )

    if conn.execute("SELECT COUNT(*) FROM tickets").fetchone()[0] == 0:
        tickets = [
            ("TK-20261109-001", "allocate", "核心交易平台扩容 3 个地址", "张伟", "核心交易平台",
             "10.1.1.0/24", None, 3, "新上线 3 个应用节点，需同网段地址", "pending"),
            ("TK-20261109-002", "allocate", "容器节点扩容 2 个地址", "刘洋", "容器平台",
             "10.2.1.0/24", None, 2, "K8s 节点扩容", "pending"),
            ("TK-20261109-003", "expand", "DMZ 区新增一个 /24 网段", "吴昊", "公网映射",
             "10.9.0.0/16", None, 1, "现有 10.9.2.0/24 即将耗尽，申请扩容", "pending"),
            ("TK-20261108-004", "allocate", "办公终端临时地址", "李娜", "办公终端",
             "10.1.10.0/24", None, 1, "临时工位", "rejected"),
        ]
        for tid, typ, title, applicant, business, prefix, addr, count, reason, status in tickets:
            conn.execute(
                "INSERT INTO tickets"
                "(id,type,title,applicant,business,prefix_cidr,addr,count,reason,status,created_at,updated_at,approver,decision_note,result) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (tid, typ, title, applicant, business, prefix, addr, count, reason, status,
                 "2026-11-09 09:20:00", "2026-11-09 09:20:00",
                 "王磊" if status == "rejected" else None,
                 "预算未审批" if status == "rejected" else None, None),
            )
        emit(conn, "ticket.created", "TK-20261109-001", {"type": "allocate", "count": 3})
    conn.commit()


def prefix_for(conn: sqlite3.Connection, addr: str, vrf=None) -> str:
    """在当前 VRF 地址平面内反查地址所属的最细可分配子网。"""
    plane = db.current_vrf() if vrf is None else vrf
    ip = ipaddress.ip_address(addr)
    cond, args = db.vrf_sql(plane, joiner="AND")
    subs = [r[0] for r in conn.execute(
        "SELECT cidr FROM prefixes WHERE kind='subnet'" + cond + " ORDER BY cidr DESC", args)]
    for cidr in subs:
        if ip in domain.net(cidr):
            return cidr
    return "未归属"


# ---------------------------- 自定义页面 / VRF / 集成源 ----------------------------

def _default_page(key: str) -> dict:
    base = DEFAULT_PAGES.get(key, {"title": "自定义页面", "subtitle": "", "blocks": []})
    return {
        "key": key, "title": base["title"], "subtitle": base["subtitle"],
        "blocks": [dict(b) for b in base["blocks"]],
        "updated_at": None, "updated_by": None,
    }


def get_page(conn, key: str) -> dict:
    """读取自定义页面；未保存过时返回内置默认内容。"""
    page = _default_page(key)
    row = conn.execute("SELECT * FROM custom_pages WHERE page_key=?", (key,)).fetchone()
    if row:
        try:
            saved = json.loads(row["content"])
            for field in ("title", "subtitle", "blocks"):
                if field in saved:
                    page[field] = saved[field]
        except (ValueError, TypeError):
            pass  # 内容损坏时回退到默认页面，避免整页不可用
        page["updated_at"] = row["updated_at"]
        page["updated_by"] = row["updated_by"]
    return page


def save_page(conn, key: str, payload: dict) -> dict:
    """保存用户自定义内容：标题 / 简介 / 内容块列表，统一在领域层做结构校验。"""
    if not re.fullmatch(r"[a-z0-9_-]{1,40}", key or ""):
        raise ValueError("页面标识只能包含小写字母、数字、- 或 _")
    title = str(payload.get("title") or "").strip()
    if not title:
        raise ValueError("页面标题不能为空")
    if len(title) > 80:
        raise ValueError("页面标题不能超过 80 个字符")
    subtitle = str(payload.get("subtitle") or "").strip()[:300]
    raw = payload.get("blocks") if isinstance(payload.get("blocks"), list) else []
    if len(raw) > 12:
        raise ValueError("自定义内容块最多 12 个")
    blocks, seen = [], set()
    for i, block in enumerate(raw):
        if not isinstance(block, dict):
            raise ValueError(f"第 {i + 1} 个内容块格式不合法")
        bid = str(block.get("id") or "").strip()[:60] or f"block-{i + 1}"
        if bid in seen:
            raise ValueError("内容块 ID 重复")
        seen.add(bid)
        btitle = str(block.get("title") or "").strip()
        body = str(block.get("body") or "").strip()
        if not btitle and not body:
            raise ValueError(f"第 {i + 1} 个内容块的标题与正文不能同时为空")
        if len(btitle) > 80 or len(body) > 2000:
            raise ValueError("内容块标题不超过 80 字、正文不超过 2000 字")
        tone = str(block.get("tone") or "neutral")
        blocks.append({"id": bid, "title": btitle, "body": body,
                       "tone": tone if tone in PAGE_TONES else "neutral"})
    content = json.dumps({"title": title, "subtitle": subtitle, "blocks": blocks},
                         ensure_ascii=False)
    # 保存人由服务端会话用户注入（见 app.save_page），前端不再硬编码「管理员」
    author = str(payload.get("updated_by") or "—").strip()[:40]
    conn.execute(
        "INSERT INTO custom_pages(page_key,content,updated_at,updated_by) VALUES(?,?,?,?) "
        "ON CONFLICT(page_key) DO UPDATE SET content=excluded.content, "
        "updated_at=excluded.updated_at, updated_by=excluded.updated_by",
        (key, content, db.now(), author),
    )
    db.audit(conn, "page.update", key,
             f"更新自定义页面「{title}」：{len(blocks)} 个内容块")
    emit(conn, "page.updated", key, {"title": title, "blocks": len(blocks)})
    conn.commit()
    return get_page(conn, key)


# 路线 2 发布迁移：把路线 1「分类标签 / 全站唯一」的旧内置文案翻转为真隔离口径。
# 只匹配值完全等于旧内置文案的字段，用户自行改写的内容块原样保留。
_R1_SUBTITLE = ("按租户与业务给 IPv4 地址空间打分类标签的总览页。本页标题、说明与内容块均可自由编辑，"
                "保存后持久化到数据库；VRF 是分类标签，不是彼此隔离的地址平面。")
_R1_PRINCIPLE_TITLE = "标签定位（不是隔离平面）"
_R1_PRINCIPLE = ("本系统把 VRF 作为前缀与设备的分类标签，用于筛选、分组与统计，不创建独立的路由 / 转发表。\n"
                 "全站地址空间全局唯一：同一 CIDR / IP 不可跨 VRF 复用，前缀重叠校验按全局地址空间执行；"
                 "用户可见范围仍按 CIDR 授权，VRF 不参与权限隔离。")
_R1_PRINCIPLE_SHORT = ("本系统把 VRF 作为前缀与设备的分类标签，用于筛选、分组与统计，不创建独立的路由 / 转发表。\n"
                       "全站地址空间唯一：同一 CIDR 或 IP 不能跨 VRF 复用，前缀重叠校验按全局地址空间执行。")
_R1_CONVENTION = ("命名使用小写字母、数字、- 或 _，例如 vrf-finance。\n"
                  "新建前缀 / 划入子网 / 登记设备时选择 VRF；改名会同步前缀、设备与默认 VRF；"
                  "删除前需先迁移前缀与设备归属。")
_R1_BOUNDARY = ("地址空间树里的「汇聚前缀」是 kind=aggregate 的层级节点，与 VRF 分类标签无关。\n"
                "IPAM 只登记地址，不配置网络设备转发；用户可见范围仍按 CIDR 授权，VRF 不参与权限隔离。")
_R1_BOUNDARY_TITLE = "术语与边界"


def migrate_vrf_page(conn) -> bool:
    """把已保存的 VRF 页面从「分类标签」口径翻转为「独立地址平面」口径（幂等）。"""
    row = conn.execute("SELECT content FROM custom_pages WHERE page_key='vrf'").fetchone()
    if row is None:
        return False
    try:
        saved = json.loads(row["content"])
    except (ValueError, TypeError):
        return False
    defaults = DEFAULT_PAGES["vrf"]
    changed = False
    if saved.get("subtitle") in (_R1_SUBTITLE,):
        saved["subtitle"] = defaults["subtitle"]
        changed = True
    blocks = saved.get("blocks")
    if isinstance(blocks, list):
        for block in blocks:
            if not isinstance(block, dict):
                continue
            body = block.get("body") or ""
            if "在「VRF 分类标签清单」中新建 / 编辑 / 删除标签" in body:
                block["body"] = body.replace(
                    "在「VRF 分类标签清单」中新建 / 编辑 / 删除标签",
                    "在「VRF 地址平面清单」中新建 / 编辑 / 删除平面")
                changed = True
                body = block["body"]
            if block.get("id") == "principle":
                if body in (_R1_PRINCIPLE, _R1_PRINCIPLE_SHORT):
                    block["body"] = defaults["blocks"][0]["body"]
                    changed = True
                if block.get("title") in (_R1_PRINCIPLE_TITLE, "平面划分原则"):
                    block["title"] = defaults["blocks"][0]["title"]
                    changed = True
            if block.get("id") == "convention" and body == _R1_CONVENTION:
                block["body"] = defaults["blocks"][1]["body"]
                changed = True
            if block.get("id") == "boundary" and body == _R1_BOUNDARY:
                block["body"] = defaults["blocks"][2]["body"]
                changed = True
    if changed:
        conn.execute("UPDATE custom_pages SET content=? WHERE page_key='vrf'",
                     (json.dumps(saved, ensure_ascii=False),))
    return changed


def migrate_vrf_content(conn) -> None:
    """发布迁移：把设置 / VRF 描述 / 页面文案统一翻转为真隔离口径。

    只在值/文案等于历史内置内容时更新，用户自行编辑过的内容不受影响。
    其中「默认 VRF」一次性从 default 翻转为 all（全部 VRF 跨平面对比）：
    仅命中「历史内置 value + 历史内置 note」的行才改写；管理员后来在
    系统设置里主动设回 default 的行（note 已是新文案）不会被覆盖。
    """
    conn.execute(
        "UPDATE settings SET value=?, note=? WHERE key='default_vrf' "
        "AND value='default' AND note IN (?,?,?,?)",
        (db.ALL_VRFS, DEFAULT_VRF_NOTE, *LEGACY_DEFAULT_VRF_NOTES))
    conn.execute(
        "UPDATE settings SET note=? WHERE key='default_vrf' AND note IN (?,?,?,?)",
        (DEFAULT_VRF_NOTE, *LEGACY_DEFAULT_VRF_NOTES))
    for name, old, new in (
        ("default", "生产 / 办公 / DMZ 共用的分类标签", "生产 / 办公 / DMZ 共用的默认地址平面"),
        ("vrf-prod", "生产业务网段分类标签", "生产业务独立地址平面"),
        ("vrf-lab", "研发与集成测试网段分类标签", "研发与集成测试独立地址平面"),
    ):
        conn.execute("UPDATE vrfs SET description=? WHERE name=? AND description=?",
                     (new, name, old))
    migrate_vrf_page(conn)


def normalize_vrf_refs(conn) -> int:
    """把前缀 / 设备 / 默认设置里字典外的历史 VRF 值吸收进地址平面字典（幂等）。

    历史版本允许设备写入字典外的 VRF，改名或删除后会留下孤儿引用；
    这里与角色字典的做法一致：保留数据、自动补建平面，而不是改写引用。
    """
    known = {r[0] for r in conn.execute("SELECT name FROM vrfs")}
    used = {r[0] for r in conn.execute(
        "SELECT DISTINCT vrf FROM prefixes WHERE vrf IS NOT NULL AND vrf<>''")}
    used |= {r[0] for r in conn.execute(
        "SELECT DISTINCT vrf FROM asset_devices WHERE vrf IS NOT NULL AND vrf<>''")}
    configured = str(db.thresholds(conn)["default_vrf"] or "").strip()
    # 'all' 是跨平面对比视图标识，不是真实地址平面，绝不能被补建进 vrfs 字典
    if configured and configured != db.ALL_VRFS:
        used.add(configured)
    added = 0
    for value in sorted(used - known):
        try:
            name = _vrf_name(value)
        except ValueError:
            continue
        conn.execute(
            "INSERT OR IGNORE INTO vrfs(name,tenant,description,created_at) VALUES(?,?,?,?)",
            (name, "历史数据", "由历史引用自动补建的 VRF 地址平面", db.now()))
        added += 1
    return added


def _vrf_name(value) -> str:
    name = str(value or "").strip()
    if not name or not name.replace("-", "").replace("_", "").isalnum():
        raise ValueError("VRF 名称只能包含字母、数字、- 或 _")
    return name


def protected_vrf(conn) -> str:
    """不可删除的地址平面：默认具体平面；默认视图为 'all' 时保护内置主平面 default。

    'all' 只是汇总视图，不对应 vrfs 表里的行。若不加保护，默认视图改成 all
    后所有平面（含审计 / Webhook 在汇总视图下的兜底落点 default）都能被删掉。
    """
    configured = str(db.thresholds(conn)["default_vrf"] or "").strip()
    return "default" if configured == db.ALL_VRFS else configured


def list_vrfs(conn) -> list[dict]:
    """VRF 地址平面清单：每个平面的前缀 / 子网 / 设备 / 已登记 IP / 容量统计。"""
    global_th = db.thresholds(conn)
    protected = protected_vrf(conn)
    rows = [dict(r) for r in conn.execute("SELECT * FROM vrfs ORDER BY name")]
    for r in rows:
        name = r["name"]
        # 有效阈值：VRF 自定义优先，未配置则回落系统全局设置
        r["effective_warn"] = (float(r["warn_threshold"])
                               if r.get("warn_threshold") is not None else global_th["warn"])
        r["effective_crit"] = (float(r["crit_threshold"])
                               if r.get("crit_threshold") is not None else global_th["crit"])
        refs = [dict(x) for x in conn.execute(
            "SELECT cidr,name,kind FROM prefixes WHERE vrf=? ORDER BY cidr", (name,))]
        devices = [dict(x) for x in conn.execute(
            "SELECT id,name FROM asset_devices WHERE vrf=? ORDER BY id", (name,))]
        r["prefix_count"] = len(refs)
        r["subnet_count"] = sum(1 for x in refs if x["kind"] == "subnet")
        r["root_count"] = sum(1 for x in refs if x["kind"] == "root")
        r["prefixes"] = [x["cidr"] for x in refs]
        r["prefix_names"] = {x["cidr"]: x["name"] for x in refs}
        r["device_count"] = len(devices)
        r["devices"] = [x["id"] for x in devices]
        r["device_names"] = {x["id"]: x["name"] for x in devices}
        r["ip_count"] = conn.execute(
            "SELECT COUNT(*) FROM ip_addresses WHERE vrf=?", (name,)).fetchone()[0]
        # 容量只累计该平面内的可分配子网，避免根 / 汇聚前缀重复计数
        subs = db.list_prefixes(conn, name)
        nets = [p for p in subs if p["kind"] == "subnet"]
        r["total"] = sum(p["total"] for p in nets)
        r["occupied"] = sum(p["occupied"] for p in nets)
        r["free"] = sum(p["free"] for p in nets)
        r["util"] = round(r["occupied"] / r["total"] * 100, 1) if r["total"] else 0
        r["reference_count"] = r["prefix_count"] + r["device_count"] + r["ip_count"]
        # is_default 同时承载「默认进入的平面」与「受删除保护的内置主平面」
        r["is_default"] = name == protected
    return rows


def cross_vrf_overlap(conn) -> dict:
    """地址复用全景：列出在多个 VRF 平面重复登记的 CIDR / IP。

    真隔离下复用是合法且被预期的，这里提供可审计清单，方便核对
    「同一网段被哪些平面同时使用」以及跨平面路由的泄漏风险。
    """
    prefixes = [dict(r) for r in conn.execute(
        "SELECT cidr, COUNT(*) AS plane_count, GROUP_CONCAT(vrf, '、') AS vrfs "
        "FROM prefixes GROUP BY cidr HAVING COUNT(*) > 1 "
        "ORDER BY plane_count DESC, cidr")]
    ips = [dict(r) for r in conn.execute(
        "SELECT addr, COUNT(*) AS plane_count, GROUP_CONCAT(vrf, '、') AS vrfs, "
        "GROUP_CONCAT(status, '、') AS statuses "
        "FROM ip_addresses GROUP BY addr HAVING COUNT(*) > 1 "
        "ORDER BY plane_count DESC, addr")]
    return {
        "planes": [r[0] for r in conn.execute("SELECT name FROM vrfs ORDER BY name")],
        "prefix_overlap": prefixes, "ip_overlap": ips,
        "prefix_count": len(prefixes), "ip_count": len(ips),
    }


def _vrf_thresholds(conn, payload: dict, row=None) -> tuple[float | None, float | None]:
    """解析 VRF 级容量阈值；返回 None 表示沿用系统全局阈值。

    校验会把「本平面自定义值」与「另一项回落到的全局值」放在一起比较，
    避免出现 warn=85 而全局 crit=80 这类倒挂组合。
    """
    base = db.thresholds(conn)

    def pick(key: str) -> float | None:
        if key in payload:
            raw = payload.get(key)
            if raw is None or raw == "":
                return None
            try:
                return float(raw)
            except (TypeError, ValueError) as exc:
                raise ValueError(f"{key} 必须是数字或留空") from exc
        if row is None:
            return None
        try:
            value = row[key]
        except (IndexError, KeyError):
            return None
        return float(value) if value is not None else None

    warn, crit = pick("warn_threshold"), pick("crit_threshold")
    for label, value in (("预警", warn), ("告警", crit)):
        if value is not None and not 0 <= value <= 100:
            raise ValueError(f"{label}阈值需在 0–100 之间")
    eff_warn = base["warn"] if warn is None else warn
    eff_crit = base["crit"] if crit is None else crit
    if eff_warn >= eff_crit:
        raise ValueError("预警阈值必须小于告警阈值（含与全局阈值混合后的结果）")
    return warn, crit


def create_vrf(conn, payload: dict) -> dict:
    name = _vrf_name(payload.get("name"))
    if conn.execute("SELECT 1 FROM vrfs WHERE name=?", (name,)).fetchone():
        raise ValueError("VRF 已存在")
    tenant = str(payload.get("tenant") or "未指定").strip()[:40]
    description = str(payload.get("description") or "").strip()[:200]
    warn, crit = _vrf_thresholds(conn, payload)
    conn.execute(
        "INSERT INTO vrfs(name,tenant,description,created_at,warn_threshold,crit_threshold) "
        "VALUES(?,?,?,?,?,?)",
        (name, tenant, description, db.now(), warn, crit),
    )
    db.audit(conn, "vrf.create", None, f"新建 VRF 地址平面 {name}")
    emit(conn, "vrf.created", name, {"tenant": tenant, "description": description})
    conn.commit()
    return {"name": name, "warn_threshold": warn, "crit_threshold": crit}


# VRF 改名时必须同步的所有业务表（审计 / 快照属历史记录，改名同步但不阻止删除）
VRF_TABLES = ("prefixes", "ip_addresses", "asset_devices", "discovery_records",
              "reconciliation_diffs", "tickets", "audit_logs", "utilization_snapshots")
PHANTOM_PLANE_TABLES = VRF_TABLES + ("webhook_events",)


def drop_phantom_all_plane(conn) -> int:
    """自愈：清理把视图标识 'all' 误当成真实 VRF 补建进字典的历史脏数据。

    早期 normalize_vrf_refs() 会把 settings.default_vrf 的值补建为平面，
    默认视图改成 all 后就会多出一张空的 'all' 平面，让顶栏出现重复选项。
    只有在全部带 vrf 的表里都查不到引用时才删除；有引用一律原样保留，
    由管理员在界面上决定迁移或删除，绝不自动丢数据。返回删除行数 0/1。
    """
    if conn.execute("SELECT 1 FROM vrfs WHERE name=?", (db.ALL_VRFS,)).fetchone() is None:
        return 0
    for table in PHANTOM_PLANE_TABLES:
        if conn.execute(f"SELECT 1 FROM {table} WHERE vrf=? LIMIT 1",
                        (db.ALL_VRFS,)).fetchone():
            return 0
    conn.execute("DELETE FROM vrfs WHERE name=?", (db.ALL_VRFS,))
    return 1


def update_vrf(conn, name: str, payload: dict) -> dict:
    """编辑 VRF 地址平面：改名时同一事务同步全部业务表与默认 VRF 设置。"""
    row = conn.execute("SELECT * FROM vrfs WHERE name=?", (name,)).fetchone()
    if row is None:
        raise LookupError("VRF 地址平面不存在")
    new_name = _vrf_name(payload.get("name") or name)
    if new_name != name and conn.execute(
            "SELECT 1 FROM vrfs WHERE name=?", (new_name,)).fetchone():
        raise ValueError(f"VRF「{new_name}」已存在")
    tenant = str(payload.get("tenant") if payload.get("tenant") is not None
                 else row["tenant"]).strip()[:40] or "未指定"
    description = str(payload.get("description") if payload.get("description") is not None
                      else row["description"]).strip()[:200]
    warn, crit = _vrf_thresholds(conn, payload, row)

    def old(key: str):
        return row[key] if key in row.keys() else None

    changes = []
    if new_name != name:
        changes.append(f"名称：{name} → {new_name}")
    if tenant != row["tenant"]:
        changes.append(f"租户：{row['tenant']} → {tenant}")
    if description != row["description"]:
        changes.append(f"说明：{row['description'] or '—'} → {description or '—'}")
    if warn != old("warn_threshold") or crit != old("crit_threshold"):
        fmt = lambda v: '全局' if v is None else f'{float(v):g}%'
        changes.append(f"容量阈值：预警 {fmt(old('warn_threshold'))} / 告警 {fmt(old('crit_threshold'))}"
                       f" → {fmt(warn)} / {fmt(crit)}")
    synced_prefixes = synced_devices = synced_ips = 0
    conn.execute("BEGIN IMMEDIATE")
    try:
        if new_name != name:
            # 目标名若已被孤儿数据占用，主键会冲突，先明确拦截
            for table in VRF_TABLES:
                if conn.execute(f"SELECT 1 FROM {table} WHERE vrf=? LIMIT 1",
                                (new_name,)).fetchone():
                    raise ValueError(f"「{new_name}」已存在历史地址数据，请换一个名称")
            synced_prefixes = conn.execute(
                "SELECT COUNT(*) FROM prefixes WHERE vrf=?", (name,)).fetchone()[0]
            synced_devices = conn.execute(
                "SELECT COUNT(*) FROM asset_devices WHERE vrf=?", (name,)).fetchone()[0]
            synced_ips = conn.execute(
                "SELECT COUNT(*) FROM ip_addresses WHERE vrf=?", (name,)).fetchone()[0]
            for table in VRF_TABLES:
                conn.execute(f"UPDATE {table} SET vrf=? WHERE vrf=?", (new_name, name))
            conn.execute("UPDATE settings SET value=? WHERE key='default_vrf' AND value=?",
                         (new_name, name))
            changes.append(f"同步 {synced_prefixes} 个前缀 / {synced_ips} 条地址 / "
                           f"{synced_devices} 台设备")
        conn.execute(
            "UPDATE vrfs SET name=?,tenant=?,description=?,warn_threshold=?,crit_threshold=? "
            "WHERE name=?",
            (new_name, tenant, description, warn, crit, name))
        db.audit(conn, "vrf.update", new_name,
                 "编辑 VRF 地址平面 " + name + "：" + ("；".join(changes) if changes else "无字段变更"),
                 new_name)
        emit(conn, "vrf.updated", new_name,
             {"previous": name, "changes": changes, "prefixes": synced_prefixes,
              "ips": synced_ips, "devices": synced_devices})
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return {"name": new_name, "previous_name": name, "changes": changes,
            "synced_prefixes": synced_prefixes, "synced_devices": synced_devices,
            "synced_ips": synced_ips}


def _migrate_plane_data(conn, src: str, dst: str) -> dict:
    """把 src 平面的业务数据整体迁到 dst，先做 (vrf, ...) 复合唯一键冲突预检。"""
    dup_cidrs = [r[0] for r in conn.execute(
        "SELECT s.cidr FROM prefixes s JOIN prefixes d ON d.cidr=s.cidr AND d.vrf=? "
        "WHERE s.vrf=? ORDER BY s.cidr", (dst, src))]
    dup_ips = [r[0] for r in conn.execute(
        "SELECT s.addr FROM ip_addresses s JOIN ip_addresses d ON d.addr=s.addr AND d.vrf=? "
        "WHERE s.vrf=? ORDER BY s.addr", (dst, src))]
    dup_mgmt = [r[0] for r in conn.execute(
        "SELECT s.id FROM asset_devices s JOIN asset_devices d "
        "ON d.mgmt_ip=s.mgmt_ip AND d.vrf=? "
        "WHERE s.vrf=? AND s.mgmt_ip IS NOT NULL AND s.mgmt_ip<>'' ORDER BY s.id",
        (dst, src))]
    problems = []
    if dup_cidrs:
        problems.append(f"{len(dup_cidrs)} 个前缀重复（{'、'.join(dup_cidrs[:5])}）")
    if dup_ips:
        problems.append(f"{len(dup_ips)} 个地址重复（{'、'.join(dup_ips[:5])}）")
    if dup_mgmt:
        problems.append(f"{len(dup_mgmt)} 台设备管理 IP 重复（{'、'.join(dup_mgmt[:5])}）")
    if problems:
        raise ValueError(f"目标平面 {dst} 已存在相同数据，无法迁移：{'；'.join(problems)}；"
                         "请先清理冲突或选择其它目标平面")
    # 快照主键为 (vrf, day)：目标平面同日记录先让位，保留源平面的历史曲线
    conn.execute("DELETE FROM utilization_snapshots WHERE vrf=? AND day IN "
                 "(SELECT day FROM utilization_snapshots WHERE vrf=?)", (dst, src))
    moved: dict[str, int] = {}
    for table in VRF_TABLES:
        n = conn.execute(f"SELECT COUNT(*) FROM {table} WHERE vrf=?", (src,)).fetchone()[0]
        if n:
            conn.execute(f"UPDATE {table} SET vrf=? WHERE vrf=?", (dst, src))
        moved[table] = n
    return moved


def delete_vrf(conn, name: str, target_vrf: str | None = None) -> dict:
    """删除地址平面；指定 target_vrf 时把该平面全部业务数据迁移过去再删除。

    默认 / 内置主平面永远不可删除。未指定迁移目标且平面仍有数据时拒绝删除，
    避免整张地址空间凭空消失。
    """
    row = conn.execute("SELECT * FROM vrfs WHERE name=?", (name,)).fetchone()
    if row is None:
        raise LookupError("VRF 地址平面不存在")
    if name == protected_vrf(conn):
        raise ValueError("默认 VRF 不可删除（默认视图为 all 时内置主平面 default 同样受保护），"
                         "请先在「系统设置」中更换默认地址平面")
    target = str(target_vrf or "").strip()
    if target:
        if target == name:
            raise ValueError("迁移目标不能是待删除的平面本身")
        if not conn.execute("SELECT 1 FROM vrfs WHERE name=?", (target,)).fetchone():
            raise LookupError(f"目标地址平面 {target} 不存在")
    counts = {
        "前缀": ("prefixes",), "地址记录": ("ip_addresses",), "设备": ("asset_devices",),
        "发现记录": ("discovery_records",), "对账差异": ("reconciliation_diffs",),
        "工单": ("tickets",),
    }
    parts = []
    for label, (table,) in counts.items():
        n = conn.execute(f"SELECT COUNT(*) FROM {table} WHERE vrf=?", (name,)).fetchone()[0]
        if n:
            parts.append(f"{n} 条{label}")
    if parts and not target:
        raise ValueError(f"该地址平面仍有 {'、'.join(parts)}，"
                         "请选择迁移目标平面，或先切换到该平面清空数据后再删除")
    conn.execute("BEGIN IMMEDIATE")
    try:
        moved = _migrate_plane_data(conn, name, target) if target else {}
        conn.execute("DELETE FROM vrfs WHERE name=?", (name,))
        detail = f"删除 VRF 地址平面 {name}"
        if target:
            detail += f"，数据已迁移到 {target}"
        db.audit(conn, "vrf.delete", None, detail, target or "default")
        emit(conn, "vrf.deleted", name,
             {"name": name, "migrated_to": target or None, "moved": moved})
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return {"name": name, "deleted": True, "migrated_to": target or None, "moved": moved}


def list_sources(conn) -> list[dict]:
    return [dict(r) for r in conn.execute("SELECT * FROM integration_sources ORDER BY id")]


def set_source(conn, source_id: str, enabled: bool) -> dict:
    if conn.execute("SELECT 1 FROM integration_sources WHERE id=?", (source_id,)).fetchone() is None:
        raise LookupError("数据源不存在")
    conn.execute("UPDATE integration_sources SET enabled=? WHERE id=?", (int(enabled), source_id))
    db.audit(conn, "integration.toggle", None, f"{source_id} {'启用' if enabled else '停用'}")
    conn.commit()
    return {"id": source_id, "enabled": enabled}


def sync_source(conn, source_id: str) -> dict:
    """模拟 04 层一次采集：写发现记录 → 触发对账 → 更新数据源状态 → 发告警。"""
    row = conn.execute("SELECT * FROM integration_sources WHERE id=?", (source_id,)).fetchone()
    if row is None:
        raise LookupError("数据源不存在")
    if not row["enabled"]:
        raise ValueError("该数据源已停用，请先启用")

    seq = row["sync_count"] + 1
    rnd = random.Random(f"{source_id}-{seq}")
    plane = db.current_vrf()
    cond, args = db.vrf_sql(plane, joiner="AND")
    subs = [r[0] for r in conn.execute(
        "SELECT cidr FROM prefixes WHERE kind='subnet'" + cond, args)]
    pool = []
    for cidr in subs:
        start = domain.bounds(cidr)[0]
        for off in (5, 12, 21, 37, 63, 88, 120, 149, 200, 231):
            pool.append((domain.to_ip(start + off), cidr))
    picks = rnd.sample(pool, min(6, len(pool)))

    signal_by_kind = {
        "dhcp": "活跃租约", "dns": "A / PTR 记录", "cmdb": "资产在册",
        "snmp": "ARP 在线", "netflow": "流量观测", "webhook": "外部事件",
    }
    signal = signal_by_kind.get(row["kind"], "观测记录")
    now = db.now()
    inserted = 0
    for addr, cidr in picks:
        conn.execute(
            "INSERT INTO discovery_records(vrf,addr,prefix_cidr,mac,hostname,source,signal,observed_at) "
            "VALUES(?,?,?,?,?,?,?,?)",
            (plane, addr, cidr,
             f"3c:22:fb:{rnd.randint(16, 240):02x}:{rnd.randint(16, 240):02x}:{rnd.randint(16, 240):02x}",
             f"observed-{addr.replace('.', '-')}", source_id, signal, now),
        )
        inserted += 1
    conn.execute(
        "UPDATE integration_sources SET last_sync=?, sync_count=? WHERE id=?",
        (now, seq, source_id),
    )
    diffs = reconcile(conn)
    db.audit(conn, "integration.sync", None,
             f"[{plane}] {row['name']} 同步：发现 {inserted} 条 / 新增差异 {diffs} 条", plane)
    emit(conn, "integration.synced", source_id,
         {"vrf": plane, "records": inserted, "new_diffs": diffs})
    conn.commit()
    return {"source": source_id, "records": inserted, "new_diffs": diffs, "synced_at": now}


# -------------------------------- 发现与对账 --------------------------------

def list_discovery(conn, limit: int = 50) -> list[dict]:
    cond, args = db.vrf_sql(joiner="WHERE")
    return [dict(r) for r in conn.execute(
        "SELECT * FROM discovery_records" + cond + " ORDER BY id DESC LIMIT ?",
        args + [limit])]


def reconcile(conn) -> int:
    """对账引擎：在当前 VRF 平面内比对外部观测与 IPAM 登记，生成不重复的 open 差异。"""
    created = 0
    plane = db.current_vrf()
    cond, args = db.vrf_sql(plane)
    rows = conn.execute(
        "SELECT * FROM discovery_records" + cond + " ORDER BY id DESC LIMIT 200", args).fetchall()
    for obs in rows:
        addr = obs["addr"]
        obs_vrf = obs["vrf"]
        rec = conn.execute("SELECT * FROM ip_addresses WHERE addr=? AND vrf=?",
                           (addr, obs_vrf)).fetchone()
        if rec is None:
            dtype = "dns_mismatch" if obs["source"] == "dns" else "unregistered"
            detail = f"{obs['signal']}（{obs['hostname']}）在外部数据源可见，但 IPAM 未登记"
        elif obs["signal"] == "30 天无流量" and rec["status"] == "assigned":
            dtype = "zombie"
            detail = f"{addr} 已分配但连续 30 天无流量，建议发起回收"
        elif obs["hostname"] and rec["hostname"] and obs["hostname"] != rec["hostname"] \
                and not obs["hostname"].startswith("observed-"):
            dtype = "conflict"
            detail = f"外部主机名 {obs['hostname']} 与 IPAM 登记 {rec['hostname']} 不一致"
        else:
            continue
        if conn.execute(
            "SELECT 1 FROM reconciliation_diffs "
            "WHERE addr=? AND vrf=? AND type=? AND status='open'",
            (addr, obs_vrf, dtype),
        ).fetchone():
            continue
        label, severity = DIFF_TYPES[dtype]
        conn.execute(
            "INSERT INTO reconciliation_diffs"
            "(vrf,addr,prefix_cidr,type,severity,source,detail,status,discovered_at) "
            "VALUES(?,?,?,?,?,?,?,?,?)",
            (obs_vrf, addr, prefix_for(conn, addr, obs_vrf), dtype, severity,
             obs["source"], detail, "open", db.now()),
        )
        created += 1
    return created


def list_diffs(conn, status: str = "all", dtype: str = "all") -> dict:
    where, args = [], []
    cond, vargs = db.vrf_sql()
    if cond:
        where.append(cond.strip().removeprefix("WHERE").strip())
        args += vargs
    if status != "all":
        where.append("status=?")
        args.append(status)
    if dtype != "all":
        where.append("type=?")
        args.append(dtype)
    clause = " WHERE " + " AND ".join(where) if where else ""
    rows = [dict(r) for r in conn.execute(
        "SELECT * FROM reconciliation_diffs" + clause + " ORDER BY id DESC", args)]
    for r in rows:
        r["type_label"], _ = DIFF_TYPES.get(r["type"], (r["type"], "medium"))
        r["resolved"] = r["status"] != "open"
    counts = {r["status"]: r["n"] for r in conn.execute(
        "SELECT status, COUNT(*) n FROM reconciliation_diffs" + cond + " GROUP BY status", vargs)}
    type_counts = {r["type"]: r["n"] for r in conn.execute(
        "SELECT type, COUNT(*) n FROM reconciliation_diffs" +
        (cond + " AND" if cond else " WHERE") + " status='open' GROUP BY type", vargs)}
    return {"items": rows, "open": counts.get("open", 0), "resolved": counts.get("resolved", 0),
            "ignored": counts.get("ignored", 0), "by_type": type_counts}


DIFF_ACTIONS = {
    "register": "补登为已分配",
    "conflict": "标记为地址冲突",
    "reclaim": "发起回收",
    "ignore": "忽略该差异",
}


def resolve_diff(conn, diff_id: int, action: str, note: str = "") -> dict:
    if action not in DIFF_ACTIONS:
        raise ValueError("不支持的处理方式")
    row = conn.execute("SELECT * FROM reconciliation_diffs WHERE id=?", (diff_id,)).fetchone()
    if row is None:
        raise LookupError("差异记录不存在")
    if row["status"] != "open":
        raise ValueError("该差异已处理")

    plane = row["vrf"] or "default"
    rec = conn.execute("SELECT * FROM ip_addresses WHERE addr=? AND vrf=?",
                       (row["addr"], plane)).fetchone()
    outcome = ""
    if action == "register":
        if rec:
            raise ValueError("该地址在本平面已有登记记录，请改用其他处理方式")
        prefix = prefix_for(conn, row["addr"], plane)
        if prefix == "未归属":
            raise ValueError("地址不属于本平面任何已纳管子网，无法补登")
        obs = conn.execute(
            "SELECT hostname FROM discovery_records WHERE addr=? AND vrf=? ORDER BY id DESC LIMIT 1",
            (row["addr"], plane),
        ).fetchone()
        vlan = conn.execute("SELECT vlan FROM prefixes WHERE cidr=? AND vrf=?",
                            (prefix, plane)).fetchone()
        conn.execute(
            "INSERT INTO ip_addresses(vrf,addr,addr_int,prefix_cidr,status,hostname,business,owner,vlan,updated_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?)",
            (plane, row["addr"], domain.to_int(row["addr"]), prefix, "assigned",
             (obs["hostname"] if obs and not obs["hostname"].startswith("observed-") else "reconciled-host"),
             "对账补登", "IPAM 自动对账", vlan["vlan"] if vlan else None, db.now()),
        )
        outcome = f"[{plane}] 补登 {row['addr']} 为已分配"
    elif action == "conflict":
        if rec is None:
            raise ValueError("地址尚未登记，请先执行「补登」或直接忽略")
        if not domain.can_transition(rec["status"], "conflict"):
            raise ValueError(f"当前状态 {domain.STATUS_LABELS.get(rec['status'])} 不允许标记冲突")
        conn.execute("UPDATE ip_addresses SET status='conflict', updated_at=? WHERE addr=? AND vrf=?",
                     (db.now(), row["addr"], plane))
        outcome = f"{row['addr']} 已标记冲突"
    elif action == "reclaim":
        if rec is None:
            raise ValueError("地址尚未登记，无需回收")
        if not domain.can_transition(rec["status"], "deprecated"):
            raise ValueError(f"当前状态 {domain.STATUS_LABELS.get(rec['status'])} 不允许发起回收")
        conn.execute("UPDATE ip_addresses SET status='deprecated', updated_at=? WHERE addr=? AND vrf=?",
                     (db.now(), row["addr"], plane))
        outcome = f"{row['addr']} 已进入待回收观察期"
    else:
        conn.execute(
            "UPDATE reconciliation_diffs SET status='ignored', resolved_at=?, resolution=? WHERE id=?",
            (db.now(), f"忽略：{note or '人工判定无需处理'}", diff_id),
        )
        outcome = "差异已忽略"

    if action != "ignore":
        conn.execute(
            "UPDATE reconciliation_diffs SET status='resolved', resolved_at=?, resolution=? WHERE id=?",
            (db.now(), f"{DIFF_ACTIONS[action]} · {note or outcome}", diff_id),
        )
    db.audit(conn, "reconcile." + action, row["addr"], outcome, plane)
    emit(conn, "reconciliation.resolved", row["addr"],
         {"vrf": plane, "action": action, "diff_id": diff_id})
    conn.commit()
    return {"id": diff_id, "vrf": plane, "action": action,
            "status": "ignored" if action == "ignore" else "resolved", "outcome": outcome}


# -------------------------------- 审批工单 --------------------------------

def list_tickets(conn, status: str = "all") -> dict:
    cond, vargs = db.vrf_sql()
    clause = cond + (" AND status=?" if cond else " WHERE status=?") if status != "all" else cond
    args = list(vargs) + ([status] if status != "all" else [])
    rows = [dict(r) for r in conn.execute(
        "SELECT * FROM tickets" + clause + " ORDER BY created_at DESC, id DESC", args)]
    for r in rows:
        r["type_label"] = TICKET_TYPES.get(r["type"], r["type"])
    counts = {r["status"]: r["n"] for r in conn.execute(
        "SELECT status, COUNT(*) n FROM tickets" + cond + " GROUP BY status", vargs)}
    return {"items": rows, "pending": counts.get("pending", 0),
            "approved": counts.get("approved", 0), "rejected": counts.get("rejected", 0)}


def create_ticket(conn, payload: dict) -> dict:
    typ = payload.get("type")
    if typ not in TICKET_TYPES:
        raise ValueError("不支持的工单类型")
    plane = str(payload.get("vrf") or "").strip() or db.current_vrf()
    if plane == db.ALL_VRFS:
        raise ValueError("请先选择具体的 VRF 地址平面再提交工单")
    prefix = payload.get("prefix_cidr") or None
    addr = payload.get("addr") or None
    count = int(payload.get("count") or 1)
    if count < 1 or count > 20:
        raise ValueError("申请数量需在 1–20 之间")
    pcond, pargs = db.vrf_sql(plane, joiner="AND")
    if typ == "allocate":
        row = conn.execute("SELECT kind FROM prefixes WHERE cidr=?" + pcond,
                           [prefix] + pargs).fetchone()
        if row is None or row["kind"] != "subnet":
            raise ValueError(f"分配申请必须指定 {plane} 平面内已存在的可分配子网")
    elif typ == "release" and not addr:
        raise ValueError("回收申请必须指定 IP 地址")
    elif typ == "expand":
        row = conn.execute("SELECT kind FROM prefixes WHERE cidr=?" + pcond,
                           [prefix] + pargs).fetchone()
        if row is None or row["kind"] == "subnet":
            raise ValueError(f"扩容申请必须指定 {plane} 平面内的汇聚前缀")

    day = datetime.datetime.now().strftime("%Y%m%d")
    seq = conn.execute("SELECT COUNT(*) FROM tickets").fetchone()[0] + 1
    tid = f"TK-{day}-{seq:03d}"
    while conn.execute("SELECT 1 FROM tickets WHERE id=?", (tid,)).fetchone():
        seq += 1
        tid = f"TK-{day}-{seq:03d}"
    now = db.now()
    conn.execute(
        "INSERT INTO tickets(id,type,title,applicant,business,prefix_cidr,addr,vrf,count,reason,status,created_at,updated_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (tid, typ, payload.get("title") or TICKET_TYPES[typ], payload.get("applicant") or "—",
         payload.get("business") or "未指定", prefix, addr, plane, count,
         payload.get("reason") or "", "pending", now, now),
    )
    db.audit(conn, "ticket.create", addr, f"[{plane}] 新建{TICKET_TYPES[typ]} {tid}", plane)
    emit(conn, "ticket.created", tid,
         {"vrf": plane, "type": typ, "prefix": prefix, "count": count})
    conn.commit()
    return {"id": tid, "vrf": plane, "status": "pending", "type": typ}


def decide_ticket(conn, ticket_id: str, decision: str, approver: str, note: str = "") -> dict:
    """审批通过后调用 03 层真实能力：分配 / 回收 / 扩容，不是只改工单状态。"""
    if decision not in ("approve", "reject"):
        raise ValueError("审批结果只能是 approve 或 reject")
    row = conn.execute("SELECT * FROM tickets WHERE id=?", (ticket_id,)).fetchone()
    if row is None:
        raise LookupError("工单不存在")
    if row["status"] != "pending":
        raise ValueError(f"工单当前状态为 {row['status']}，不可重复审批")
    now = db.now()
    if decision == "reject":
        conn.execute(
            "UPDATE tickets SET status='rejected', updated_at=?, approver=?, decision_note=? WHERE id=?",
            (now, approver, note or "驳回", ticket_id),
        )
        db.audit(conn, "ticket.reject", None, f"工单 {ticket_id} 驳回：{note or '—'}")
        conn.commit()
        return {"id": ticket_id, "status": "rejected", "result": None}

    plane = row["vrf"] or "default"
    result = ""
    try:
        if row["type"] == "allocate":
            addrs = []
            for _ in range(row["count"]):
                allocated = db.allocate({
                    "prefix": row["prefix_cidr"], "business": row["business"],
                    "owner": row["applicant"], "mode": "assigned", "vrf": plane,
                }, plane)
                addrs.append(allocated["addr"])
            result = "已分配 " + ", ".join(addrs)
        elif row["type"] == "release":
            changed = db.transition(row["addr"], "release", plane)
            result = f"{changed['addr']} → 待回收"
        else:  # expand：在本平面聚合前缀下划出一个不冲突的 /24
            parent = row["prefix_cidr"]
            pcond, pargs = db.vrf_sql(plane, joiner="AND")
            existing = [r[0] for r in conn.execute(
                "SELECT cidr FROM prefixes WHERE 1=1" + pcond, pargs)]
            chosen = None
            for cidr in domain.subnets_of(parent, 24, limit=64):
                if not domain.plan_conflicts(cidr, existing):
                    chosen = cidr
                    break
            if chosen is None:
                raise ValueError("该聚合前缀下已无可划分且不冲突的 /24 网段")
            prow = conn.execute("SELECT site FROM prefixes WHERE cidr=?" + pcond,
                                [parent] + pargs).fetchone()
            conn.execute(
                "INSERT INTO prefixes(vrf,cidr,parent_cidr,name,kind,site,vlan) VALUES(?,?,?,?,?,?,?)",
                (plane, chosen, parent, f"扩容网段 {chosen}", "subnet", prow["site"], None),
            )
            result = f"[{plane}] 已划入新网段 {chosen}"
    except Exception as exc:
        conn.execute(
            "UPDATE tickets SET status='failed', updated_at=?, approver=?, decision_note=?, result=? WHERE id=?",
            (now, approver, note, f"执行失败：{exc}", ticket_id),
        )
        db.audit(conn, "ticket.failed", None, f"工单 {ticket_id} 审批执行失败：{exc}")
        conn.commit()
        raise ValueError(f"审批执行失败：{exc}") from exc

    conn.execute(
        "UPDATE tickets SET status='approved', updated_at=?, approver=?, decision_note=?, result=? WHERE id=?",
        (now, approver, note or "同意", result, ticket_id),
    )
    db.audit(conn, "ticket.approve", None, f"工单 {ticket_id} 通过 · {result}")
    emit(conn, "ticket.approved", ticket_id, {"type": row["type"], "result": result})
    conn.commit()
    return {"id": ticket_id, "status": "approved", "result": result}


# -------------------------------- 子网划分 --------------------------------
# 计算不再截断：等分结果按整数索引生成，可分页取任意区间，也可一次导出全部。
MAX_PLAN_TOTAL = 1 << 16   # 单次划分最多 65,536 个子网（例如 /8 → /24）
MAX_PAGE_SIZE = 2_000      # 单次响应最多 2,000 行，避免超大 DOM


def _plan_params(payload: dict) -> tuple[str, int, dict, int, int, int]:
    parent = str(payload.get("parent") or "").strip()
    try:
        new_prefix = int(payload.get("new_prefix", 24))
    except (TypeError, ValueError) as exc:
        raise ValueError("目标掩码必须是整数") from exc
    try:
        info = domain.cidr_info(parent)
        base, size, total = domain.subnet_grid(parent, new_prefix)
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError(f"父前缀格式不合法：{exc}") from exc
    if total > MAX_PLAN_TOTAL:
        raise ValueError(
            f"按 /{new_prefix} 划分将产生 {total:,} 个子网，超过单次上限 "
            f"{MAX_PLAN_TOTAL:,}；请选择更接近父前缀的目标掩码，或缩小父前缀范围"
        )
    return parent, new_prefix, info, base, size, total


def _plan_existing(conn, vrf=None) -> list[tuple[int, int, int, str]]:
    """只取目标 VRF 平面内的已有前缀，冲突判断因此不会跨平面误报。"""
    cond, args = db.vrf_sql(vrf)
    return domain.parse_prefix_ranges(
        r[0] for r in conn.execute("SELECT cidr FROM prefixes" + cond, args))


def _plan_item(index: int, addr: int, new_prefix: int, size: int,
               existing: list[tuple[int, int, int, str]]) -> dict:
    cidr = f"{domain.to_ip(addr)}/{new_prefix}"
    ci = domain.cidr_info(cidr)
    conflicts = domain.conflicts_in_range(addr, addr + size - 1, new_prefix, existing)
    return {
        "index": index, "cidr": cidr,
        "mask": ci["mask"], "network": ci["network"], "broadcast": ci["broadcast"],
        "first_host": ci["first_host"], "last_host": ci["last_host"],
        "total": ci["total"], "usable": ci["usable"],
        "conflicts": conflicts, "available": not conflicts,
    }


def _plan_conflict_count(base: int, size: int, new_prefix: int, total: int,
                         existing: list[tuple[int, int, int, str]]) -> int:
    """区间并集统计全量冲突子网数，O(M log M)，不必遍历每个候选。

    CIDR 边界对齐：比目标掩码更粗的已有前缀只会完整包含若干候选（祖先关系），
    按 plan_conflicts 规则不算冲突；同网段或更细的前缀才会命中。
    """
    parent_end = base + total * size - 1
    spans: list[tuple[int, int]] = []
    for e0, e1, eplen, _ in existing:
        if eplen < new_prefix or e1 < base or e0 > parent_end:
            continue
        i0 = max(0, (e0 - base) // size)
        i1 = min(total - 1, (e1 - base) // size)
        if i0 <= i1:
            spans.append((i0, i1))
    spans.sort()
    merged: list[list[int]] = []
    for a, b in spans:
        if merged and a <= merged[-1][1] + 1:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    return sum(b - a + 1 for a, b in merged)


def plan_subnets(conn, payload: dict) -> dict:
    """按父前缀 + 目标掩码等分，返回全量统计与指定区间的子网明细。"""
    parent, new_prefix, info, base, size, total = _plan_params(payload)
    try:
        offset = max(0, int(payload.get("offset", 0)))
        raw_limit = int(payload.get("limit", 0))
    except (TypeError, ValueError) as exc:
        raise ValueError("分页参数必须是整数") from exc
    if raw_limit <= 0:             # 0 = 一次列出可承载的全部子网
        offset = 0
        page_size = min(total, MAX_PAGE_SIZE)
    else:
        page_size = min(max(1, raw_limit), MAX_PAGE_SIZE)
        offset = min(offset, max(0, total - 1))
    stop = min(total, offset + page_size)
    plane = str(payload.get("vrf") or "").strip() or db.current_vrf()
    existing = _plan_existing(conn, plane)
    items = [_plan_item(i, base + i * size, new_prefix, size, existing)
             for i in range(offset, stop)]
    conflict_count = _plan_conflict_count(base, size, new_prefix, total, existing)
    return {
        "vrf": plane,
        "parent": info, "new_prefix": new_prefix,
        "total_in_parent": total,
        "offset": offset, "limit": stop - offset,
        "shown": len(items), "has_more": stop < total,
        "available_count": total - conflict_count,
        "conflict_count": conflict_count,
        "items": items,
    }


def plan_subnets_csv(conn, parent: str, new_prefix: int, vrf=None) -> str:
    """导出目标 VRF 平面全部等分子网为 CSV（含重叠状态），不受分页限制。"""
    _, new_prefix, _info, base, size, total = _plan_params(
        {"parent": parent, "new_prefix": new_prefix})
    existing = _plan_existing(conn, vrf)
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(["序号", "子网", "子网掩码", "网络号", "广播地址",
                     "首个可分配", "末个可分配", "地址总数", "可用地址数",
                     "状态", "冲突前缀"])
    for i in range(total):
        item = _plan_item(i, base + i * size, new_prefix, size, existing)
        writer.writerow([
            i + 1, item["cidr"], item["mask"], item["network"], item["broadcast"],
            item["first_host"], item["last_host"], item["total"], item["usable"],
            "可划入" if item["available"] else "冲突",
            " ".join(item["conflicts"]),
        ])
    return "\ufeff" + out.getvalue()   # BOM 便于 Excel 直接打开中文表头


def commit_subnets(conn, payload: dict) -> dict:
    parent = payload.get("parent", "")
    cidrs = payload.get("cidrs") or []
    if not cidrs:
        raise ValueError("请至少选择一个待划入的子网")
    vrf = str(payload.get("vrf") or "").strip() or db.current_vrf()
    if vrf == db.ALL_VRFS:
        raise ValueError("请先选择具体的 VRF 地址平面，不能在汇总视图下划分子网")
    pcond, pargs = db.vrf_sql(vrf, joiner="AND")
    prow = conn.execute("SELECT * FROM prefixes WHERE cidr=?" + pcond,
                        [parent] + pargs).fetchone()
    if prow is None:
        raise ValueError(f"父前缀 {parent} 不存在于 {vrf} 地址平面")
    if conn.execute("SELECT 1 FROM vrfs WHERE name=?", (vrf,)).fetchone() is None:
        raise ValueError(f"VRF 地址平面「{vrf}」不存在，请先在「VRF 地址平面」页创建")
    existing = [r[0] for r in conn.execute("SELECT cidr FROM prefixes WHERE 1=1" + pcond, pargs)]
    for cidr in cidrs:
        if not domain.contains(parent, cidr):
            raise ValueError(f"{cidr} 不属于 {parent}")
        if domain.plan_conflicts(cidr, existing):
            raise ValueError(f"{cidr} 与 {vrf} 平面内已有前缀重叠，已拒绝写入")
        if cidr in existing:
            raise ValueError(f"{cidr} 已在 {vrf} 平面存在")
    for idx, cidr in enumerate(cidrs):
        conn.execute(
            "INSERT INTO prefixes(vrf,cidr,parent_cidr,name,kind,site,vlan) VALUES(?,?,?,?,?,?,?)",
            (vrf, cidr, parent, payload.get("name") or f"新划分子网 {idx + 1}", "subnet",
             prow["site"], payload.get("vlan") or None),
        )
        existing.append(cidr)
    db.audit(conn, "subnet.split", None,
             f"[{vrf}] {parent} 划入 {len(cidrs)} 个子网：{', '.join(cidrs)}", vrf)
    emit(conn, "subnet.created", parent, {"vrf": vrf, "cidrs": cidrs})
    conn.commit()
    return {"created": len(cidrs), "vrf": vrf, "cidrs": cidrs}


# -------------------------------- 报表 / 审计 / 设置 --------------------------------

DIMENSIONS = {
    "site": ("站点", "site"),
    "vlan": ("VLAN", "vlan"),
    "vrf": ("VRF 地址平面", "vrf"),
    "business": ("业务系统", "business"),
    "status": ("地址状态", "status"),
    "prefix": ("子网", "prefix_cidr"),
}


def report(conn, dimension: str = "site", vrf=None) -> dict:
    """按维度聚合；除「按 VRF」对比维度外，一律只统计当前 VRF 地址平面。"""
    if dimension not in DIMENSIONS:
        raise ValueError("不支持的报表维度")
    label, _ = DIMENSIONS[dimension]
    plane = db.current_vrf() if vrf is None else vrf
    # 「按 VRF」是跨平面对比视图，需要全部前缀；其余维度严格限定当前平面
    scope = db.ALL_VRFS if dimension == "vrf" else plane
    cond, args = db.vrf_sql(scope)
    if dimension == "status":
        counts = {r["status"]: r["n"] for r in conn.execute(
            "SELECT status, COUNT(*) n FROM ip_addresses" + cond + " GROUP BY status", args)}
        d = db.dashboard(conn, scope)
        rows = [
            {"key": k, "label": domain.STATUS_LABELS.get(k, k), "total": v, "occupied": v,
             "free": 0, "util": 100.0}
            for k, v in sorted(counts.items(), key=lambda x: -x[1])
        ]
        rows.append({"key": "available", "label": "可用（未落库）", "total": d["free"],
                     "occupied": 0, "free": d["free"], "util": 0.0})
        return {"dimension": dimension, "label": label, "vrf": scope, "rows": rows,
                "summary": {"groups": len(rows), "total": d["total"], "occupied": d["occupied"]}}

    prefixes = db.list_prefixes(conn, scope)
    subs = [p for p in prefixes if p["kind"] == "subnet"]
    ip_rows = [dict(r) for r in conn.execute(
        "SELECT vrf, prefix_cidr, business, status FROM ip_addresses" + cond, args)]
    buckets: dict[str, dict] = {}
    # 根 / 汇聚 / 子网都带 VRF 归属；容量只在可分配子网上累加，避免重复计数
    if dimension == "vrf":
        for p in prefixes:
            key = str(p["vrf"] or "default")
            b = buckets.setdefault(key, {"key": key, "label": key, "total": 0, "retained": 0,
                                         "occupied": 0, "free": 0, "subnets": 0})
            b["subnets"] += 1
    for p in subs:
        if dimension == "prefix":
            # 同一 CIDR 可属于多个平面，报表 key 必须复合
            key = f"{p['vrf']} · {p['cidr']}"
        elif dimension == "site":
            key = str(p["site"])
        elif dimension == "vrf":
            key = str(p["vrf"] or "default")
        else:
            key = str(p["vlan"])
        if key == "None":
            key = "未分配 VLAN" if dimension == "vlan" else "未指定"
        b = buckets.setdefault(key, {"key": key, "label": key, "total": 0, "retained": 0,
                                     "occupied": 0, "free": 0, "subnets": 0})
        b["total"] += p["total"]
        b["retained"] += p["retained"]
        b["occupied"] += p["occupied"]
        b["free"] += p["free"]
        if dimension != "vrf":
            b["subnets"] += 1
    # 业务维度按 IP 明细重新聚合（业务归属在地址行上）
    if dimension == "business":
        buckets = {}
        for r in ip_rows:
            b = buckets.setdefault(r["business"], {"key": r["business"], "label": r["business"],
                                                   "total": 0, "retained": 0, "occupied": 0,
                                                   "free": 0, "subnets": 0})
            b["occupied"] += 1
        for b in buckets.values():
            b["total"] = b["occupied"]
    rows = []
    for b in buckets.values():
        denom = max(1, b["total"] - b["retained"])
        b["util"] = round(b["occupied"] / denom * 100, 1) if dimension != "business" else 100.0
        rows.append(b)
    rows.sort(key=lambda r: -r["occupied"])
    return {"dimension": dimension, "label": label, "vrf": scope, "rows": rows,
            "summary": {"groups": len(rows),
                        "total": sum(r["total"] for r in rows),
                        "occupied": sum(r["occupied"] for r in rows)}}


def export_rows(conn, dimension: str, vrf=None) -> list[dict]:
    return report(conn, dimension, vrf)["rows"]


def audit_list(conn, action: str = "all", q: str = "", limit: int = 100) -> dict:
    where, args = [], []
    cond, vargs = db.vrf_sql()
    if cond:
        where.append(cond.strip().removeprefix("WHERE").strip())
        args += vargs
    if action != "all":
        where.append("action LIKE ?")
        args.append(action + "%")
    if q:
        where.append("(addr LIKE ? OR detail LIKE ? OR action LIKE ?)")
        args += [f"%{q}%"] * 3
    clause = " WHERE " + " AND ".join(where) if where else ""
    rows = [dict(r) for r in conn.execute(
        "SELECT * FROM audit_logs" + clause + " ORDER BY id DESC LIMIT ?",
        args + [min(500, max(1, limit))],
    )]
    actions = [r[0] for r in conn.execute("SELECT DISTINCT action FROM audit_logs ORDER BY action")]
    return {"items": rows, "actions": actions, "total": len(rows)}


def list_settings(conn) -> dict:
    rows = [dict(r) for r in conn.execute("SELECT * FROM settings ORDER BY key")]
    return {"items": rows, "thresholds": db.thresholds(conn)}


def update_settings(conn, payload: dict) -> dict:
    allowed = {r[0] for r in conn.execute("SELECT key FROM settings")}
    updates = {}
    for key, value in payload.items():
        if key not in allowed:
            raise ValueError(f"未知设置项：{key}")
        updates[key] = str(value)
    if "warn_threshold" in updates or "crit_threshold" in updates:
        warn = float(updates.get("warn_threshold", db.thresholds(conn)["warn"]))
        crit = float(updates.get("crit_threshold", db.thresholds(conn)["crit"]))
        if not (0 <= warn < crit <= 100):
            raise ValueError("阈值需满足 0 ≤ 预警 < 告警 ≤ 100")
    if "reservation_ttl_hours" in updates and not (1 <= int(updates["reservation_ttl_hours"]) <= 720):
        raise ValueError("预留有效期需在 1–720 小时之间")
    for key, value in updates.items():
        conn.execute("UPDATE settings SET value=? WHERE key=?", (value, key))
    db.audit(conn, "settings.update", None, "更新系统设置：" + ", ".join(f"{k}={v}" for k, v in updates.items()))
    emit(conn, "settings.changed", None, updates)
    conn.commit()
    return {"updated": updates, "thresholds": db.thresholds(conn)}


def expire_reservations(conn) -> dict:
    """预留超时维护任务：只清理当前 VRF 平面的过期预留行。"""
    plane = db.current_vrf()
    hours = db.thresholds(conn)["reservation_ttl_hours"]
    cutoff = (datetime.datetime.now() - datetime.timedelta(hours=hours)).strftime("%Y-%m-%d %H:%M:%S")
    cond, args = db.vrf_sql(plane, joiner="AND")
    rows = conn.execute(
        "SELECT vrf, addr FROM ip_addresses WHERE status='reserved' AND updated_at < ?" + cond,
        [cutoff] + args).fetchall()
    for r in rows:
        conn.execute("DELETE FROM ip_addresses WHERE addr=? AND vrf=?", (r["addr"], r["vrf"]))
    if rows:
        db.audit(conn, "maintenance.expire", None,
                 f"[{plane}] 释放 {len(rows)} 个超时预留地址（TTL {hours}h）", plane)
    conn.commit()
    return {"vrf": plane, "expired": len(rows), "ttl_hours": hours,
            "addrs": [r["addr"] for r in rows]}


def webhook_events(conn, limit: int = 20, vrf: str | None = None) -> list[dict]:
    """按当前地址平面过滤告警事件；'all' 汇总视图显示全部并保留 vrf 列。"""
    cond, args = db.vrf_sql(vrf)
    rows = conn.execute("SELECT * FROM webhook_events" + cond +
                        " ORDER BY id DESC LIMIT ?",
                        [*args, min(100, max(1, limit))])
    return [dict(r) for r in rows]
