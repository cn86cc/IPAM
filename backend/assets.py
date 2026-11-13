"""第五版：设备管理（位置 / 机柜 / 设备 / 链路）。

四张资产表构成一条物理拓扑链：位置（园区 → 楼宇 → 楼层 → 机房）承载机柜，
机柜提供 U 位，设备落位到机柜与 U 位，链路连接两台设备的端口。
设备带管理 IP，会回查地址空间树得到所属前缀与 IPAM 登记状态，
使资产管理层与原有的 IP 地址管理层形成真实联动，而不是独立样例。

所有写操作在 BEGIN IMMEDIATE 事务内完成，并统一写审计日志与 Webhook 事件；
只读用户由 01 层鉴权中间件在写操作与模块级直接拒绝，本模块不需要重复判权。
"""
from __future__ import annotations

import ipaddress
import re
import sqlite3

from . import db, device_roles, domain, extended

KINDS = ("locations", "racks", "devices", "links")
TABLES = {
    "locations": "asset_locations",
    "racks": "asset_racks",
    "devices": "asset_devices",
    "links": "asset_links",
}
LABELS = {
    "locations": "位置", "racks": "机柜", "devices": "设备", "links": "链路",
}

# 四类资产的编号同时是主键并被其它资产表引用；编号再次编辑时必须在同一事务内
# 先同步全部引用，再改主键。第三项用于删除前的影响面提示。
ID_REFERENCES = {
    "locations": [
        ("asset_locations", "parent_id", "下级位置"),
        ("asset_racks", "location_id", "机柜"),
        ("asset_devices", "location_id", "设备"),
    ],
    "racks": [
        ("asset_devices", "rack_id", "设备"),
    ],
    "devices": [
        ("asset_links", "local_device_id", "本端链路"),
        ("asset_links", "remote_device_id", "对端链路"),
    ],
    "links": [],
}

# 可编辑属性字段（不含 id；编号由 create_asset / update_asset 单独校验并级联同步）
FIELDS = {
    "locations": ["name", "kind", "parent_id", "address", "contact", "note"],
    "racks": ["name", "location_id", "units", "power_kw", "status", "note"],
    "devices": ["name", "vendor", "model", "role", "mgmt_ip", "location_id",
                "rack_id", "rack_u", "status", "vrf", "owner", "note"],
    "links": ["name", "local_device_id", "local_port", "remote_device_id",
              "remote_port", "kind", "bandwidth_gbps", "vlan", "status", "note"],
}
ENUMS = {
    "locations": {"kind": ("campus", "building", "floor", "room")},
    "racks": {"status": ("active", "planned", "retired")},
    # devices.role 由 asset_device_roles 字典校验（见 _validate），下拉选项来自同一张表
    "devices": {
        "status": ("online", "offline", "maintenance"),
    },
    "links": {
        "status": ("up", "down", "planned"),
        "kind": ("trunk", "access", "uplink", "stack", "wan"),
    },
}
DEFAULTS = {
    "locations": {"kind": "room", "parent_id": "", "address": "", "contact": "", "note": ""},
    "racks": {"location_id": "", "units": 42, "power_kw": 6, "status": "active", "note": ""},
    "devices": {"vendor": "", "model": "", "role": "other", "mgmt_ip": "", "location_id": "",
                "rack_id": "", "rack_u": "", "status": "online", "vrf": "default",
                "owner": "", "note": ""},
    "links": {"name": "", "local_device_id": "", "local_port": "", "remote_device_id": "",
              "remote_port": "", "kind": "trunk", "bandwidth_gbps": 10, "vlan": "",
              "status": "up", "note": ""},
}
NUMBERS = {"units": int, "rack_u": int, "power_kw": float, "bandwidth_gbps": float}
ID_RE = re.compile(r"^[A-Za-z0-9._-]{2,48}$")

# ---------------------------------------------------------------- 种子数据

SEED_LOCATIONS = [
    ("LOC-HQ", "华东总部园区", "campus", None, "上海市浦东新区张江路 88 号", "设施部 · 王工", "总部主园区"),
    ("LOC-HQ-A", "A 座研发楼", "building", "LOC-HQ", "园区东侧", "物业 · 李工", "研发与核心网络"),
    ("LOC-HQ-A-3F", "A 座 3 层", "floor", "LOC-HQ-A", "", "", ""),
    ("LOC-A3-R01", "核心机房 A3", "room", "LOC-HQ-A-3F", "A 座 3 层 301", "网络组 · 赵强", "双路市电 + UPS"),
    ("LOC-HQ-B", "B 座办公楼", "building", "LOC-HQ", "园区西侧", "物业 · 李工", "办公终端接入"),
    ("LOC-B1-R02", "办公接入机房", "room", "LOC-HQ-B", "B 座 1 层 102", "网络组 · 赵强", "接入交换机"),
    ("LOC-SH-DC", "上海数据中心", "campus", None, "上海市宝山区机房路 1 号", "IDC · 陈工", "异地容灾中心"),
    ("LOC-DC-R01", "数据中心 1 号机房", "room", "LOC-SH-DC", "1 号楼 2 层", "IDC · 陈工", "冷通道封闭"),
]
SEED_RACKS = [
    ("RACK-A3-01", "A3 核心柜 01", "LOC-A3-R01", 42, 8.0, "active", "核心交换与边界设备"),
    ("RACK-A3-02", "A3 业务柜 02", "LOC-A3-R01", 42, 6.0, "active", "业务服务器"),
    ("RACK-A3-03", "A3 业务柜 03", "LOC-A3-R01", 42, 6.0, "active", "负载均衡与中间件"),
    ("RACK-B1-01", "B1 接入柜 01", "LOC-B1-R02", 24, 4.0, "active", "办公区接入"),
    ("RACK-DC-01", "DC 计算柜 01", "LOC-DC-R01", 48, 12.0, "active", "容灾计算与存储"),
    ("RACK-DC-02", "DC 扩容柜 02", "LOC-DC-R01", 48, 12.0, "planned", "待上架"),
]
# (id, name, vendor, model, role, mgmt_ip, location, rack, u, status, vrf, owner, note)
SEED_DEVICES = [
    ("DEV-0001", "core-sw-01", "Huawei", "CE6881", "core_switch", "10.1.10.2",
     "LOC-A3-R01", "RACK-A3-01", 40, "online", "default", "网络组 · 赵强", "核心交换机主"),
    ("DEV-0002", "core-sw-02", "Huawei", "CE6881", "core_switch", "10.1.10.3",
     "LOC-A3-R01", "RACK-A3-01", 38, "online", "default", "网络组 · 赵强", "核心交换机备"),
    ("DEV-0003", "fw-edge-01", "Palo Alto", "PA-3220", "firewall", "10.1.3.2",
     "LOC-A3-R01", "RACK-A3-01", 36, "online", "default", "安全组 · 吴昊", "互联网边界"),
    ("DEV-0004", "rt-wan-01", "Cisco", "ASR1001", "router", "10.1.10.5",
     "LOC-A3-R01", "RACK-A3-01", 34, "online", "default", "网络组 · 赵强", "广域网出口"),
    ("DEV-0005", "agg-sw-a3", "H3C", "S6520", "access_switch", "10.1.10.4",
     "LOC-A3-R01", "RACK-A3-02", 42, "online", "default", "网络组 · 赵强", "业务汇聚"),
    ("DEV-0006", "mq-node-01", "Dell", "R650", "server", "10.1.3.10",
     "LOC-A3-R01", "RACK-A3-02", 30, "online", "vrf-prod", "平台组 · 王磊", "Kafka 节点"),
    ("DEV-0007", "mq-node-02", "Dell", "R650", "server", "10.1.3.11",
     "LOC-A3-R01", "RACK-A3-02", 28, "online", "vrf-prod", "平台组 · 王磊", "Kafka 节点"),
    ("DEV-0008", "lb-prod-01", "F5", "BIG-IP 2000", "load_balancer", "10.1.3.12",
     "LOC-A3-R01", "RACK-A3-03", 40, "online", "vrf-prod", "平台组 · 王磊", "生产流量入口"),
    ("DEV-0009", "office-sw-01", "H3C", "S5130", "access_switch", "10.1.10.21",
     "LOC-B1-R02", "RACK-B1-01", 22, "online", "default", "网络组 · 赵强", "办公终端接入"),
    ("DEV-0010", "dc-sw-01", "Cisco", "Nexus 93180", "core_switch", "10.1.0.2",
     "LOC-DC-R01", "RACK-DC-01", 46, "online", "default", "IDC · 陈工", "容灾核心"),
    ("DEV-0011", "storage-01", "Dell", "PowerStore", "storage", "10.1.0.3",
     "LOC-DC-R01", "RACK-DC-01", 20, "online", "vrf-prod", "IDC · 陈工", "集中存储"),
    ("DEV-0012", "lab-node-01", "Lenovo", "SR650", "server", "10.1.3.13",
     "LOC-A3-R01", None, None, "maintenance", "vrf-lab", "研发 · 何静", "待上架，暂未分配机柜"),
]
# (id, name, local_device, local_port, remote_device, remote_port, kind, gbps, vlan, status, note)
SEED_LINKS = [
    ("LNK-0001", "核心双机堆叠", "DEV-0001", "Eth1/1", "DEV-0002", "Eth1/1", "stack", 100, "", "up", "IRF 堆叠链路"),
    ("LNK-0002", "核心至防火墙", "DEV-0001", "Eth1/10", "DEV-0003", "eth1/1", "trunk", 10, "101,102", "up", "边界上联"),
    ("LNK-0003", "核心至广域网", "DEV-0002", "Eth1/10", "DEV-0004", "Gi0/0/0", "wan", 1, "", "up", "专线出口"),
    ("LNK-0004", "A3 汇聚上联", "DEV-0005", "Eth1/49", "DEV-0001", "Eth1/20", "uplink", 40, "101-105", "up", "双上联之一"),
    ("LNK-0005", "MQ 节点接入 1", "DEV-0006", "eth0", "DEV-0005", "Eth1/1", "access", 10, "103", "up", ""),
    ("LNK-0006", "MQ 节点接入 2", "DEV-0007", "eth0", "DEV-0005", "Eth1/2", "access", 10, "103", "up", ""),
    ("LNK-0007", "负载均衡接入", "DEV-0008", "eth0", "DEV-0005", "Eth1/3", "access", 10, "103", "up", ""),
    ("LNK-0008", "办公接入上联", "DEV-0009", "Eth1/24", "DEV-0001", "Eth1/30", "uplink", 10, "110", "down", "光模块告警，待更换"),
    ("LNK-0009", "容灾互联", "DEV-0010", "Eth1/1", "DEV-0001", "Eth1/48", "wan", 10, "", "up", "同城容灾专线"),
    ("LNK-0010", "存储接入", "DEV-0011", "eth0", "DEV-0010", "Eth1/10", "access", 25, "120", "up", "iSCSI 网络"),
]


def seed_assets(conn: sqlite3.Connection) -> None:
    """INSERT OR IGNORE 幂等；用户删除记录后重启不会重新灌入。

    生产封版模式（IPAM_DEMO_SEED=0）跳过，避免服务重启把演示设备重新灌回已清空的库。
    """
    if not db.demo_seed_enabled():
        return
    now = db.now()
    conn.executemany(
        "INSERT OR IGNORE INTO asset_locations"
        "(id,name,kind,parent_id,address,contact,note,created_at,updated_at) "
        "VALUES(?,?,?,?,?,?,?,?,NULL)",
        [(a, b, c, d, e, f, g, now) for a, b, c, d, e, f, g in SEED_LOCATIONS],
    )
    conn.executemany(
        "INSERT OR IGNORE INTO asset_racks"
        "(id,name,location_id,units,power_kw,status,note,created_at,updated_at) "
        "VALUES(?,?,?,?,?,?,?,?,NULL)",
        [(a, b, c, d, e, f, g, now) for a, b, c, d, e, f, g in SEED_RACKS],
    )
    conn.executemany(
        "INSERT OR IGNORE INTO asset_devices"
        "(id,name,vendor,model,role,mgmt_ip,location_id,rack_id,rack_u,status,vrf,owner,note,"
        "created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)",
        [(a, b, c, d, e, f, g, h, i, j, k, l, m, now) for a, b, c, d, e, f, g, h, i, j, k, l, m
         in SEED_DEVICES],
    )
    conn.executemany(
        "INSERT OR IGNORE INTO asset_links"
        "(id,name,local_device_id,local_port,remote_device_id,remote_port,kind,bandwidth_gbps,"
        "vlan,status,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL)",
        [(a, b, c, d, e, f, g, h, i, j, k, now) for a, b, c, d, e, f, g, h, i, j, k
         in SEED_LINKS],
    )
    _fill_layout_order(conn)


def _fill_layout_order(conn: sqlite3.Connection) -> None:
    """老库补列或新机柜插入后，把未排序的机柜按编号补到该位置当前顺序末尾。"""
    base = {r["location_id"]: (r["m"] or 0) for r in conn.execute(
        "SELECT location_id, MAX(layout_order) AS m FROM asset_racks GROUP BY location_id")}
    rows = conn.execute(
        "SELECT id, location_id FROM asset_racks WHERE layout_order=0 "
        "ORDER BY location_id, id").fetchall()
    for r in rows:
        base[r["location_id"]] = base.get(r["location_id"], 0) + 1
        conn.execute("UPDATE asset_racks SET layout_order=? WHERE id=?",
                     (base[r["location_id"]], r["id"]))


# ---------------------------------------------------------------- 读取与派生


def _check_kind(kind: str) -> str:
    if kind not in KINDS:
        raise LookupError(f"未知资产类型：{kind}")
    return kind


def _plain(conn: sqlite3.Connection, table: str, order: str) -> list[dict]:
    return [dict(r) for r in conn.execute(f"SELECT * FROM {table} ORDER BY {order}")]


def _location_path(rows: list[dict]) -> dict[str, str]:
    by_id = {r["id"]: r for r in rows}
    out: dict[str, str] = {}
    for r in rows:
        parts, seen, cur = [], set(), r
        while cur and cur["id"] not in seen:
            seen.add(cur["id"])
            parts.append(cur["name"])
            cur = by_id.get(cur["parent_id"]) if cur.get("parent_id") else None
        out[r["id"]] = " / ".join(reversed(parts))
    return out


def _prefix_for(conn: sqlite3.Connection, addr: str | None, vrf: str = "default") -> str | None:
    """管理 IP 归属的最细前缀；只在设备所属的 VRF 地址平面内反查。"""
    if not addr:
        return None
    try:
        value = int(ipaddress.IPv4Address(addr))
    except (ipaddress.AddressValueError, ValueError):
        return None
    cond, args = db.vrf_sql(vrf, joiner="AND")
    best: tuple[str, int] | None = None
    for row in conn.execute("SELECT cidr FROM prefixes WHERE 1=1" + cond, args):
        lo, hi, _ = domain.bounds(row["cidr"])
        if lo <= value <= hi and (best is None or hi - lo < best[1]):
            best = (row["cidr"], hi - lo)
    return best[0] if best else None


def _scope_filter(rows: list[dict], scopes: list[str] | None,
                  ip_keys: tuple[str, ...]) -> list[dict]:
    """与 01 层 auth.filter_response 同口径：有管理 IP 的资产按可见 CIDR 收敛。

    无管理 IP 的位置 / 机柜 / 待上架设备不做地址过滤，由模块权限本身控制可见性。
    """
    if not scopes:
        return rows
    nets = []
    for scope in scopes:
        try:
            nets.append(ipaddress.ip_network(scope, strict=False))
        except ValueError:
            continue
    if not nets:
        return rows

    def visible(row: dict) -> bool:
        raw = next((row.get(k) for k in ip_keys if row.get(k)), None)
        if not raw:
            return True
        try:
            addr = ipaddress.IPv4Address(str(raw))
        except ipaddress.AddressValueError:
            return True
        return any(addr in net for net in nets)

    return [r for r in rows if visible(r)]


def overview(conn: sqlite3.Connection) -> dict:
    """设备数按当前地址平面统计；机柜 / 位置 / 链路是平面无关的物理资源。"""
    plane = db.current_vrf()
    cond, args = db.vrf_sql(plane)
    cond_and, _ = db.vrf_sql(plane, joiner="AND")
    return {
        "vrf": plane,
        "locations": conn.execute("SELECT COUNT(*) FROM asset_locations").fetchone()[0],
        "racks": conn.execute("SELECT COUNT(*) FROM asset_racks").fetchone()[0],
        "devices": conn.execute("SELECT COUNT(*) FROM asset_devices" + cond, args).fetchone()[0],
        "links": conn.execute("SELECT COUNT(*) FROM asset_links").fetchone()[0],
        "online_devices": conn.execute(
            "SELECT COUNT(*) FROM asset_devices WHERE status='online'" + cond_and,
            args).fetchone()[0],
        "up_links": conn.execute(
            "SELECT COUNT(*) FROM asset_links WHERE status='up'").fetchone()[0],
    }


def list_assets(conn: sqlite3.Connection, kind: str,
                scopes: list[str] | None = None) -> dict:
    _check_kind(kind)
    all_devices = _plain(conn, "asset_devices", "id")
    # 设备清单按当前地址平面裁剪；'all' 汇总视图保留全部并用 vrf 列区分。
    # 名称 / 管理 IP 解析仍用全量字典，避免链路端点因跨平面而显示成裸编号。
    plane = db.current_vrf()
    plane_devices = ([d for d in all_devices if (d.get("vrf") or "default") == plane]
                     if plane != db.ALL_VRFS else all_devices)
    dev_ip = {d["id"]: d.get("mgmt_ip") for d in all_devices}
    locations = _plain(conn, "asset_locations", "id")
    racks = _plain(conn, "asset_racks", "id")
    devices = _scope_filter(plane_devices, scopes, ("mgmt_ip",))
    links = _plain(conn, "asset_links", "id")
    for link in links:
        link["local_device_ip"] = dev_ip.get(link["local_device_id"]) or ""
    links = _scope_filter(links, scopes, ("local_device_ip",))

    # 名称解析用全量字典：即使对端设备不在当前可见范围内，链路端点仍显示真实名称
    loc_name = {r["id"]: r["name"] for r in locations}
    loc_path = _location_path(locations)
    rack_map = {r["id"]: r for r in racks}
    dev_map = {r["id"]: r for r in all_devices}
    # 同一 IP 可在不同 VRF 平面重复登记，登记状态必须按 (vrf, addr) 判断
    registered = {(r["vrf"], r["addr"]) for r in conn.execute(
        "SELECT vrf, addr FROM ip_addresses")}

    for r in locations:
        children = [x for x in locations if x.get("parent_id") == r["id"]]
        rack_ids = [x["id"] for x in racks if x["location_id"] == r["id"]]
        r["path"] = loc_path[r["id"]]
        r["child_count"] = len(children)
        r["rack_count"] = len(rack_ids)
        r["device_count"] = sum(1 for d in devices if d.get("location_id") == r["id"])

    for r in racks:
        occupants = [d for d in devices if d.get("rack_id") == r["id"]]
        used = len(occupants)
        r["location_name"] = loc_name.get(r["location_id"], "—")
        r["device_count"] = used
        r["used_u"] = used
        r["free_u"] = max(0, r["units"] - used)
        r["util"] = round(used / r["units"] * 100, 1) if r["units"] else 0.0
        r["occupants"] = [
            {"id": d["id"], "name": d["name"], "rack_u": d.get("rack_u"),
             "status": d["status"]} for d in occupants
        ]

    for d in devices:
        ip = d.get("mgmt_ip") or None
        d["location_name"] = loc_name.get(d.get("location_id"), "—")
        d["rack_name"] = rack_map.get(d.get("rack_id"), {}).get("name", "—")
        d["prefix_cidr"] = _prefix_for(conn, ip, d.get("vrf") or "default")
        d["ipam_registered"] = bool(ip and (d.get("vrf") or "default", ip) in registered)
        # 01 层响应裁剪按 addr 过滤：只读用户只能看到可见 CIDR 内的带外管理设备
        d["addr"] = ip

    for l in links:
        a, b = dev_map.get(l["local_device_id"]), dev_map.get(l["remote_device_id"])
        l["local_device_name"] = a["name"] if a else l["local_device_id"]
        l["remote_device_name"] = b["name"] if b else l["remote_device_id"]
        l["local_device_ip"] = (a or {}).get("mgmt_ip") or ""
        l["remote_device_ip"] = (b or {}).get("mgmt_ip") or ""
        l["addr"] = (a or {}).get("mgmt_ip") or None

    source = {"locations": locations, "racks": racks, "devices": devices, "links": links}[kind]
    items = source

    if kind == "locations":
        stats = {
            "total": len(locations), "rooms": sum(1 for x in locations if x["kind"] == "room"),
            "racks": len(racks), "devices": len(devices),
        }
    elif kind == "racks":
        used = sum(x["used_u"] for x in racks)
        cap = sum(x["units"] for x in racks)
        stats = {
            "total": len(racks), "active": sum(1 for x in racks if x["status"] == "active"),
            "used_u": used, "capacity_u": cap,
            "util": round(used / cap * 100, 1) if cap else 0.0,
        }
    elif kind == "devices":
        stats = {
            "total": len(devices),
            "online": sum(1 for x in devices if x["status"] == "online"),
            "offline": sum(1 for x in devices if x["status"] == "offline"),
            "maintenance": sum(1 for x in devices if x["status"] == "maintenance"),
            "with_ip": sum(1 for x in devices if x.get("mgmt_ip")),
            "registered": sum(1 for x in devices if x["ipam_registered"]),
        }
    else:
        stats = {
            "total": len(links), "up": sum(1 for x in links if x["status"] == "up"),
            "down": sum(1 for x in links if x["status"] == "down"),
            "planned": sum(1 for x in links if x["status"] == "planned"),
            "bandwidth": round(sum(x["bandwidth_gbps"] or 0 for x in links), 1),
        }

    return {
        "kind": kind,
        "vrf": plane,
        "label": LABELS[kind],
        "items": items,
        "stats": stats,
        "options": {
            "locations": [{"id": x["id"], "name": x["name"], "path": loc_path[x["id"]],
                           "kind": x["kind"]} for x in locations],
            "racks": [{"id": x["id"], "name": x["name"], "location_id": x["location_id"],
                       "units": x["units"]} for x in racks],
            "devices": [{"id": x["id"], "name": x["name"]} for x in devices],
            "vrfs": [{"id": r["name"], "name": r["name"]}
                     for r in conn.execute("SELECT name FROM vrfs ORDER BY name")],
            "roles": device_roles.role_options(conn),
        },
    }


def rack_detail(conn: sqlite3.Connection, rack_id: str,
                scopes: list[str] | None = None) -> dict:
    """机柜二级页面数据：机柜本体 + 落位设备的完整可编辑字段。

    与 list_assets 保持同一套范围收敛口径；每台设备带上 addr，
    使 01 层 filter_response 对 devices 列表的裁剪与列表页一致。
    """
    row = conn.execute("SELECT * FROM asset_racks WHERE id=?", (rack_id,)).fetchone()
    if not row:
        raise LookupError(f"机柜 {rack_id} 不存在")
    rack = dict(row)
    locations = _plain(conn, "asset_locations", "id")
    loc_path = _location_path(locations)
    rack["location_name"] = next(
        (x["name"] for x in locations if x["id"] == rack["location_id"]), "—")

    all_devices = _plain(conn, "asset_devices", "id")
    scoped_devices = _scope_filter(all_devices, scopes, ("mgmt_ip",))
    devices = [d for d in scoped_devices if d.get("rack_id") == rack_id]
    # 同一 IP 可在不同 VRF 平面重复登记，登记状态必须按 (vrf, addr) 判断
    registered = {(r["vrf"], r["addr"]) for r in conn.execute(
        "SELECT vrf, addr FROM ip_addresses")}
    for d in devices:
        ip = d.get("mgmt_ip") or None
        d["rack_name"] = rack["name"]
        d["prefix_cidr"] = _prefix_for(conn, ip, d.get("vrf") or "default")
        d["ipam_registered"] = bool(ip and (d.get("vrf") or "default", ip) in registered)
        d["addr"] = ip
    devices.sort(key=lambda d: -(d.get("rack_u") or 0))

    units = rack["units"] or 42
    used = len(devices)
    # 角色下拉来自字典；同时把可见范围内已使用的角色一并返回，保证历史 / 停用值不丢失
    role_choices = sorted({str(d.get("role") or "").strip() for d in scoped_devices
                           if str(d.get("role") or "").strip()})
    return {
        "rack": rack,
        "devices": devices,
        "role_choices": role_choices,
        "stats": {
            "units": units,
            "used": used,
            "free": max(0, units - used),
            "util": round(used / units * 100, 1) if units else 0.0,
            "online": sum(1 for d in devices if d["status"] == "online"),
        },
        "options": {
            "locations": [{"id": x["id"], "name": x["name"], "path": loc_path[x["id"]],
                           "kind": x["kind"]} for x in locations],
            "racks": [{"id": x["id"], "name": x["name"], "location_id": x["location_id"],
                       "units": x["units"]} for x in _plain(conn, "asset_racks", "id")],
            "devices": [{"id": x["id"], "name": x["name"]} for x in all_devices],
            "vrfs": [{"id": r["name"], "name": r["name"]}
                     for r in conn.execute("SELECT name FROM vrfs ORDER BY name")],
            "roles": device_roles.role_options(conn),
        },
    }


def location_detail(conn: sqlite3.Connection, location_id: str,
                    scopes: list[str] | None = None) -> dict:
    """位置二级页面数据：位置本体 + 下属机柜（含逐 U 占用与布局顺序）+ 下级位置。

    机柜按 layout_order 升序返回，前端据此等宽横向排列；设备口径与 list_assets /
    rack_detail 一致，按可见 CIDR 收敛后再算占用，避免只读用户看到范围外设备。
    """
    row = conn.execute("SELECT * FROM asset_locations WHERE id=?", (location_id,)).fetchone()
    if not row:
        raise LookupError(f"位置 {location_id} 不存在")
    location = dict(row)
    locations = _plain(conn, "asset_locations", "id")
    loc_path = _location_path(locations)
    by_id = {x["id"]: x for x in locations}
    location["path"] = loc_path[location_id]
    parent = by_id.get(location.get("parent_id") or "")
    location["parent_name"] = parent["name"] if parent else "—"

    all_devices = _plain(conn, "asset_devices", "id")
    visible = _scope_filter(all_devices, scopes, ("mgmt_ip",))
    racks = [dict(r) for r in conn.execute(
        "SELECT * FROM asset_racks WHERE location_id=? ORDER BY layout_order, id",
        (location_id,))]
    for rack in racks:
        occupants = [d for d in visible if d.get("rack_id") == rack["id"]]
        units = rack["units"] or 42
        used = len(occupants)
        rack["used_u"] = used
        rack["free_u"] = max(0, units - used)
        rack["util"] = round(used / units * 100, 1) if units else 0.0
        rack["device_count"] = used
        rack["online"] = sum(1 for d in occupants if d["status"] == "online")
        rack["occupants"] = [
            {"id": d["id"], "name": d["name"], "rack_u": d.get("rack_u"),
             "status": d["status"]} for d in
            sorted(occupants, key=lambda d: -(d.get("rack_u") or 0))
        ]

    rack_counts: dict[str, int] = {}
    for r in _plain(conn, "asset_racks", "id"):
        rack_counts[r["location_id"]] = rack_counts.get(r["location_id"], 0) + 1

    def subtree_ids(root: str) -> set[str]:
        """下级位置的机柜 / 设备数量按其整棵子树累计，中间层级不会显示成 0。"""
        ids, changed = {root}, True
        while changed:
            changed = False
            for x in locations:
                if x.get("parent_id") in ids and x["id"] not in ids:
                    ids.add(x["id"])
                    changed = True
        return ids

    children = []
    for child in locations:
        if child.get("parent_id") != location_id:
            continue
        sub = subtree_ids(child["id"])
        children.append({
            "id": child["id"], "name": child["name"], "kind": child["kind"],
            "path": loc_path[child["id"]],
            "rack_count": sum(rack_counts.get(k, 0) for k in sub),
            "device_count": sum(1 for d in visible if d.get("location_id") in sub),
        })
    children.sort(key=lambda c: c["id"])

    units_total = sum(r["units"] or 0 for r in racks)
    used_u = sum(r["used_u"] for r in racks)
    return {
        "location": location,
        "racks": racks,
        "children": children,
        "stats": {
            "rack_count": len(racks),
            "units_total": units_total,
            "used_u": used_u,
            "util": round(used_u / units_total * 100, 1) if units_total else 0.0,
            # 「在架设备」按本位置机柜的实际 U 位占用统计，与平面图 / 已占用 U 位一致；
            # 设备的 location_id 允许与所属机柜位置不同（数据迁移或登记口径差异）。
            "device_count": used_u,
            "max_units": max((r["units"] or 0 for r in racks), default=0),
            "min_units": min((r["units"] or 0 for r in racks), default=0),
        },
    }


def reorder_racks(conn: sqlite3.Connection, location_id: str, order: object,
                  actor: str | None = None) -> dict:
    """位置平面图左右拖动：把该位置下机柜的横向顺序整体持久化。

    order 必须是该位置全部机柜编号的一个排列；单事务内重写 1..N，
    保证部分失败不会留下半套顺序。
    """
    conn.execute("BEGIN IMMEDIATE")
    try:
        loc = conn.execute("SELECT id,name FROM asset_locations WHERE id=?",
                           (location_id,)).fetchone()
        if not loc:
            raise LookupError(f"位置 {location_id} 不存在")
        if not isinstance(order, list) or any(not isinstance(x, str) for x in order):
            raise ValueError("order 必须是机柜编号数组")
        current = [r["id"] for r in conn.execute(
            "SELECT id FROM asset_racks WHERE location_id=? ORDER BY layout_order, id",
            (location_id,))]
        if len(order) != len(current) or len(set(order)) != len(order) \
                or set(order) != set(current):
            raise ValueError("order 必须包含该位置下全部机柜编号，且不重复、不含其它位置的机柜")
        if order == current:
            conn.rollback()
            return {"location_id": location_id, "order": current,
                    "action": "unchanged", "from": current}

        now = db.now()
        for idx, rack_id in enumerate(order, 1):
            conn.execute("UPDATE asset_racks SET layout_order=?,updated_at=? WHERE id=?",
                         (idx, now, rack_id))
        db.audit(conn, "asset.location.reorder", None,
                 f"REORDER 位置 {location_id} · {loc['name']} 机柜顺序："
                 f"{' → '.join(current)} ⇒ {' → '.join(order)}"
                 + (f"（操作人 {actor}）" if actor else ""))
        extended.emit(conn, "asset.location.reorder", location_id,
                      {"location_id": location_id, "from": current,
                       "to": order, "actor": actor})
        conn.commit()
        return {"location_id": location_id, "order": order,
                "action": "reorder", "from": current}
    except Exception:
        conn.rollback()
        raise


# ---------------------------------------------------------------- 写入与校验


def _clean(kind: str, payload: dict, existing: dict | None) -> dict:
    """白名单字段 + 未知字段拒绝 + 枚举/数字/外键/唯一性校验。"""
    unknown = set(payload) - set(FIELDS[kind])
    if unknown:
        raise ValueError("不支持的字段：" + "、".join(sorted(unknown)))
    out: dict = {}
    for key in FIELDS[kind]:
        raw = payload[key] if key in payload else (
            existing[key] if existing is not None else DEFAULTS[kind].get(key, ""))
        if raw is None:
            raw = ""
        if key in NUMBERS:
            if raw == "" or raw is None:
                out[key] = None if key == "rack_u" else 0
            else:
                try:
                    out[key] = NUMBERS[key](raw)
                except (TypeError, ValueError):
                    raise ValueError(f"{key} 必须是数字")
        else:
            out[key] = str(raw).strip()
        if key in ENUMS.get(kind, {}) and out[key] not in ENUMS[kind][key]:
            raise ValueError(f"{key} 只能是：" + " / ".join(ENUMS[kind][key]))
    if kind == "devices":
        role = " ".join(str(out.get("role") or "").split())
        if not role:
            role = DEFAULTS["devices"]["role"]
        if len(role) > 64:
            raise ValueError("角色不能超过 64 个字符")
        out["role"] = role
        # 新建设备默认归属当前地址平面；编辑时保留原有归属，由 _validate 复核
        if "vrf" not in payload and existing is None:
            plane = db.current_vrf()
            out["vrf"] = plane if plane != db.ALL_VRFS else "default"
    if not out.get("name"):
        if kind == "links":
            out["name"] = "未命名链路"
        else:
            raise ValueError("名称不能为空")
    if len(out["name"]) > 64:
        raise ValueError("名称不能超过 64 个字符")
    for key in ("address", "contact", "note", "owner", "vendor", "model", "vlan",
                "local_port", "remote_port"):
        if key in out and len(out[key]) > 128:
            raise ValueError(f"{key} 不能超过 128 个字符")
    return out


def _validate(conn: sqlite3.Connection, kind: str, values: dict, item_id: str | None) -> None:
    def exists(table: str, key: str) -> bool:
        return conn.execute(f"SELECT 1 FROM {table} WHERE id=?", (key,)).fetchone() is not None

    if kind == "locations":
        parent = values["parent_id"] or None
        values["parent_id"] = parent
        if parent and parent == item_id:
            raise ValueError("位置不能作为自己的上级")
        if parent and not exists("asset_locations", parent):
            raise ValueError(f"上级位置 {parent} 不存在")
        # 防止层级成环：目标节点不能出现在新父级的祖先链上，
        # 同时祖先链本身也不能存在历史脏数据造成的循环。
        seen, cur = set(), parent
        while cur:
            if cur == item_id or cur in seen:
                raise ValueError("位置层级存在循环引用，不能把上级位置挂到自己的下级之下")
            seen.add(cur)
            row = conn.execute("SELECT parent_id FROM asset_locations WHERE id=?", (cur,)).fetchone()
            cur = row["parent_id"] if row else None

    elif kind == "racks":
        if not exists("asset_locations", values["location_id"]):
            raise ValueError(f"所属位置 {values['location_id']} 不存在")
        if not 1 <= values["units"] <= 60:
            raise ValueError("机柜 U 数需在 1–60 之间")
        if not 0 <= values["power_kw"] <= 100:
            raise ValueError("供电功率需在 0–100 kW 之间")

    elif kind == "devices":
        # 设备是地址平面内的资产：写操作只允许在当前选定平面内发生
        plane = db.current_vrf()
        if plane == db.ALL_VRFS:
            raise ValueError("请先选择具体的 VRF 地址平面，不能在汇总视图下新增 / 编辑设备")
        if values["vrf"] != plane:
            raise ValueError(
                f"设备所属地址平面必须为当前平面 {plane}（收到 {values['vrf']}），"
                "请从顶栏切换地址平面后再操作")
        # 设备表单为纯下拉：角色必须先在「角色」字典中定义（预置或自定义）
        if not conn.execute("SELECT 1 FROM asset_device_roles WHERE key=?",
                            (values["role"],)).fetchone():
            raise ValueError(f"角色「{values['role']}」未在角色字典中定义，"
                             "请先在「角色」模块中新增")
        ip = values["mgmt_ip"] or None
        if ip:
            try:
                ipaddress.IPv4Address(ip)
            except ipaddress.AddressValueError:
                raise ValueError(f"管理 IP {ip} 不是合法的 IPv4 地址")
            # 管理 IP 唯一性限定在同一 VRF 地址平面内（plane 已在上面校验过）
            other = conn.execute(
                "SELECT id FROM asset_devices WHERE mgmt_ip=? AND vrf=?",
                (ip, plane)).fetchone()
            if other and other["id"] != item_id:
                raise ValueError(f"管理 IP {ip} 已在 {plane} 平面被设备 {other['id']} 占用")
        values["mgmt_ip"] = ip
        values["location_id"] = values["location_id"] or None
        if values["location_id"] and not exists("asset_locations", values["location_id"]):
            raise ValueError(f"所属位置 {values['location_id']} 不存在")
        values["rack_id"] = values["rack_id"] or None
        values["rack_u"] = values["rack_u"] or None
        if values["rack_id"]:
            rack = conn.execute("SELECT units FROM asset_racks WHERE id=?",
                                (values["rack_id"],)).fetchone()
            if not rack:
                raise ValueError(f"机柜 {values['rack_id']} 不存在")
            if values["rack_u"] is None:
                raise ValueError("设备放入机柜时必须指定 U 位")
            if not 1 <= values["rack_u"] <= rack["units"]:
                raise ValueError(f"U 位需在 1–{rack['units']} 之间")
            clash = conn.execute(
                "SELECT id,name FROM asset_devices WHERE rack_id=? AND rack_u=? AND id<>?",
                (values["rack_id"], values["rack_u"], item_id or ""),
            ).fetchone()
            if clash:
                raise ValueError(f"U 位 {values['rack_u']} 已被 {clash['name']} 占用")
        else:
            values["rack_u"] = None
        # 设备归属必须是已定义的 VRF 地址平面，避免改名 / 删除后出现孤儿引用
        if conn.execute("SELECT 1 FROM vrfs WHERE name=?",
                        (values["vrf"],)).fetchone() is None:
            raise ValueError(f"VRF 地址平面「{values['vrf']}」未定义，"
                             "请先在「VRF 地址平面」页新增")

    else:  # links
        for side in ("local_device_id", "remote_device_id"):
            if not exists("asset_devices", values[side]):
                raise ValueError(f"设备 {values[side]} 不存在")
            if not values["local_port" if side.startswith("local") else "remote_port"]:
                raise ValueError("本端 / 对端端口均不能为空")
        if values["local_device_id"] == values["remote_device_id"]:
            raise ValueError("链路两端不能是同一台设备")
        if values["bandwidth_gbps"] <= 0 or values["bandwidth_gbps"] > 800:
            raise ValueError("链路带宽需在 0–800 Gbps 之间")


def _write_audit(conn: sqlite3.Connection, kind: str, action: str,
                 item_id: str, values: dict, actor: str | None,
                 previous_id: str | None = None, extra: str = "",
                 payload_extra: dict | None = None) -> None:
    name = values.get("name") or item_id
    who = f"（操作人 {actor}）" if actor else ""
    rename = f" {previous_id} → {item_id}" if previous_id and previous_id != item_id else ""
    db.audit(conn, f"asset.{kind}.{action}", values.get("mgmt_ip") or None,
             f"{action.upper()} {LABELS[kind]}{rename} {item_id} · {name}{who}{extra}")
    payload: dict = {"id": item_id, "name": name, "actor": actor}
    if previous_id and previous_id != item_id:
        payload["previous_id"] = previous_id
    if payload_extra:
        payload.update(payload_extra)
    extended.emit(conn, f"asset.{kind}.{action}", item_id, payload)


def create_asset(conn: sqlite3.Connection, kind: str, payload: dict, actor: str | None = None) -> dict:
    _check_kind(kind)
    conn.execute("BEGIN IMMEDIATE")
    try:
        item_id = str(payload.get("id") or "").strip()
        if not ID_RE.match(item_id):
            raise ValueError("编号为必填，仅支持字母、数字、. _ -，长度 2–48")
        if conn.execute(f"SELECT 1 FROM {TABLES[kind]} WHERE id=?", (item_id,)).fetchone():
            raise ValueError(f"编号 {item_id} 已存在")
        values = _clean(kind, {k: v for k, v in payload.items() if k != "id"}, None)
        _validate(conn, kind, values, item_id)
        cols = ["id"] + FIELDS[kind] + ["created_at", "updated_at"]
        marks = ",".join("?" for _ in cols)
        conn.execute(
            f"INSERT INTO {TABLES[kind]}({','.join(cols)}) VALUES({marks})",
            [item_id] + [values[k] for k in FIELDS[kind]] + [db.now(), None],
        )
        if kind == "racks":
            # 新机柜排在该位置平面图的最右侧，不打断用户已调整好的顺序
            m = conn.execute(
                "SELECT COALESCE(MAX(layout_order),0) FROM asset_racks WHERE location_id=?",
                (values["location_id"],)).fetchone()[0]
            conn.execute("UPDATE asset_racks SET layout_order=? WHERE id=?", (m + 1, item_id))
        _write_audit(conn, kind, "create", item_id, values, actor)
        conn.commit()
        return {"id": item_id, **values, "created": True}
    except Exception:
        conn.rollback()
        raise


def update_asset(conn: sqlite3.Connection, kind: str, item_id: str,
                 payload: dict, actor: str | None = None) -> dict:
    """编辑资产：属性与业务编号均可再次修改。

    id 同时是四张资产表的主键并被其它表引用。编号变化时在同一 BEGIN IMMEDIATE
    事务内先同步全部引用，再更新主键；任何一步失败都整体回滚，不留半套引用。
    """
    _check_kind(kind)
    conn.execute("BEGIN IMMEDIATE")
    try:
        row = conn.execute(f"SELECT * FROM {TABLES[kind]} WHERE id=?", (item_id,)).fetchone()
        if not row:
            raise LookupError(f"{LABELS[kind]} {item_id} 不存在")
        raw_id = payload.get("id", item_id)
        new_id = str(item_id if raw_id is None else raw_id).strip()
        if not ID_RE.match(new_id):
            raise ValueError("编号为必填，仅支持字母、数字、. _ -，长度 2–48")
        renamed = new_id != item_id
        if renamed and conn.execute(
                f"SELECT 1 FROM {TABLES[kind]} WHERE id=?", (new_id,)).fetchone():
            raise ValueError(f"编号 {new_id} 已存在")

        before = {k: row[k] for k in FIELDS[kind]}
        values = _clean(kind, {k: v for k, v in payload.items() if k != "id"}, before)
        if kind == "locations" and values["parent_id"] == new_id:
            raise ValueError("位置不能作为自己的上级")
        # item_id 仍是库内旧编号：唯一 IP / U 位占用 / 层级成环校验都需排除本行。
        _validate(conn, kind, values, item_id)
        changes = [k for k in FIELDS[kind] if before[k] != values[k]]
        if not changes and not renamed:
            conn.rollback()
            return {"id": item_id, **values, "unchanged": True, "changes": [],
                    "previous_id": None, "references_updated": 0}

        stamp = db.now()
        refs = 0
        if renamed:
            for table, col, _label in ID_REFERENCES[kind]:
                cur = conn.execute(
                    f"UPDATE {table} SET {col}=?,updated_at=? WHERE {col}=?",
                    (new_id, stamp, item_id),
                )
                refs += cur.rowcount
        conn.execute(
            f"UPDATE {TABLES[kind]} SET "
            + ",".join(k + "=?" for k in FIELDS[kind])
            + ",id=?,updated_at=? WHERE id=?",
            [values[k] for k in FIELDS[kind]] + [new_id, stamp, item_id],
        )
        changed = changes + (["id"] if renamed else [])
        detail = f"；同步更新 {refs} 处编号引用" if renamed and refs else ""
        _write_audit(conn, kind, "update", new_id, values, actor,
                     previous_id=item_id if renamed else None, extra=detail,
                     payload_extra={"changes": changed, "references_updated": refs})
        conn.commit()
        return {"id": new_id, "previous_id": item_id if renamed else None, **values,
                "unchanged": False, "changes": changed, "references_updated": refs}
    except Exception:
        conn.rollback()
        raise


def delete_asset(conn: sqlite3.Connection, kind: str, item_id: str,
                 actor: str | None = None) -> dict:
    _check_kind(kind)
    conn.execute("BEGIN IMMEDIATE")
    try:
        row = conn.execute(f"SELECT * FROM {TABLES[kind]} WHERE id=?", (item_id,)).fetchone()
        if not row:
            raise LookupError(f"{LABELS[kind]} {item_id} 不存在")
        if kind == "devices":
            plane = db.current_vrf()
            if plane == db.ALL_VRFS:
                raise ValueError("请先选择具体的 VRF 地址平面，不能在汇总视图下删除设备")
            if (row["vrf"] or "default") != plane:
                raise ValueError(f"设备属于地址平面 {row['vrf']}，请先从顶栏切换后再操作")
        blockers = ID_REFERENCES[kind]
        reasons = []
        for table, col, label in blockers:
            n = conn.execute(f"SELECT COUNT(*) FROM {table} WHERE {col}=?", (item_id,)).fetchone()[0]
            if n:
                reasons.append(f"{label} {n} 条")
        if reasons:
            raise ValueError(f"无法删除，仍被引用：" + "、".join(reasons) + "；请先迁移或删除引用")
        conn.execute(f"DELETE FROM {TABLES[kind]} WHERE id=?", (item_id,))
        _write_audit(conn, kind, "delete", item_id, dict(row), actor)
        conn.commit()
        return {"id": item_id, "name": row["name"], "deleted": True}
    except Exception:
        conn.rollback()
        raise


def move_device(conn: sqlite3.Connection, rack_id: str, device_id: str,
                rack_u: object, actor: str | None = None) -> dict:
    """机柜正视图拖拽：把设备移到目标 U 位；目标已占用时两台设备互换位置。

    整段在单个 BEGIN IMMEDIATE 事务内完成。asset_devices 上没有 (rack_id, rack_u)
    唯一约束，逐条 UPDATE 不会产生中间态冲突；事务保证要么一起生效要么一起回滚。
    """
    conn.execute("BEGIN IMMEDIATE")
    try:
        rack = conn.execute("SELECT id,name,units FROM asset_racks WHERE id=?",
                            (rack_id,)).fetchone()
        if not rack:
            raise LookupError(f"机柜 {rack_id} 不存在")
        dev = conn.execute(
            "SELECT id,name,rack_id,rack_u,mgmt_ip FROM asset_devices WHERE id=?",
            (device_id,),
        ).fetchone()
        if not dev:
            raise LookupError(f"设备 {device_id} 不存在")
        if dev["rack_id"] != rack_id:
            raise ValueError(f"设备 {dev['name']} 不在机柜 {rack_id} 内，不能直接调整 U 位")
        try:
            target = int(rack_u)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            raise ValueError("U 位必须是数字")
        if not 1 <= target <= rack["units"]:
            raise ValueError(f"U 位需在 1–{rack['units']} 之间")
        origin = dev["rack_u"]
        if origin == target:
            conn.rollback()
            return {"id": device_id, "rack_u": target, "action": "unchanged",
                    "from_u": origin, "swapped_with": None}
        if origin is None:
            raise ValueError("设备尚未指定 U 位，请先在设备编辑面板补齐")

        other = conn.execute(
            "SELECT id,name FROM asset_devices WHERE rack_id=? AND rack_u=? AND id<>?",
            (rack_id, target, device_id),
        ).fetchone()
        now = db.now()
        if other:
            conn.execute("UPDATE asset_devices SET rack_u=?,updated_at=? WHERE id=?",
                         (origin, now, other["id"]))
        conn.execute("UPDATE asset_devices SET rack_u=?,updated_at=? WHERE id=?",
                     (target, now, device_id))

        action = "swap" if other else "move"
        suffix = f"，与 {other['id']}（{other['name']}）交换" if other else ""
        db.audit(conn, "asset.rack.move", dev["mgmt_ip"] or None,
                 f"MOVE {LABELS['devices']} {device_id} · {dev['name']} "
                 f"在机柜 {rack_id} 内 U{origin} → U{target}{suffix}"
                 + (f"（操作人 {actor}）" if actor else ""))
        extended.emit(conn, "asset.rack.move", device_id,
                      {"id": device_id, "rack_id": rack_id, "from_u": origin,
                       "to_u": target, "action": action,
                       "swapped_with": other["id"] if other else None, "actor": actor})
        conn.commit()
        return {"id": device_id, "rack_u": target, "action": action,
                "from_u": origin, "swapped_with": other["id"] if other else None}
    except Exception:
        conn.rollback()
        raise
