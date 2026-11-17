"""自定义网络拓扑：设备成员 + 手工坐标持久化，连线由 asset_links 实时推导。

设计要点：
  * 每张拓扑绑定单一 VRF 地址平面，避免跨平面连线含义不清；
  * 拓扑只存「包含哪些设备」和「每个节点的坐标」，不复制任何链路数据。
    设备或链路变更后重新打开，连线与树形结构自动同步；
  * 自动树形布局以连接度最高的设备为根（可手动指定），BFS 分层、正交连线，
    环路按生成树处理，非生成树链路标记为 extra，孤立设备单独排一层；
  * pinned=1 的节点是用户拖出来的坐标，链路变化时不覆盖；pinned=0 的节点
    每次打开都按当前链路重新取自动坐标。「重新布局」清除全部固定标记。
"""
from __future__ import annotations

import math
import re
import sqlite3
import uuid
from collections import defaultdict, deque

from . import assets, auth, db

COL_GAP = 190
ROW_GAP = 120
ORIGIN_Y = 70
MIN_WIDTH = 900
MAX_NAME = 60
MAX_DESC = 500


def _id() -> str:
    return "topo-" + uuid.uuid4().hex[:10]


def _planes(conn: sqlite3.Connection) -> list[dict]:
    return [{"id": r["name"], "name": r["name"]}
            for r in conn.execute("SELECT name FROM vrfs ORDER BY name")]


def _plane_exists(conn: sqlite3.Connection, vrf: str) -> bool:
    return conn.execute("SELECT 1 FROM vrfs WHERE name=?", (vrf,)).fetchone() is not None


def _require_plane(conn: sqlite3.Connection, vrf: str) -> str:
    value = str(vrf or "").strip() or "default"
    if value == db.ALL_VRFS:
        raise ValueError("拓扑必须绑定具体的 VRF 地址平面，不能选择「全部 VRF」汇总视图")
    if not _plane_exists(conn, value):
        raise ValueError(f"VRF 地址平面「{value}」不存在，请先在「VRF 地址平面」页创建")
    return value


def _assert_write_plane(vrf: str) -> None:
    """编辑已有拓扑必须落在它所属的平面上；'all' 汇总视图只读。

    新建拓扑允许在 all 视图下发生，因为请求体已显式给出唯一目标平面，
    不存在「往哪个平面写」的歧义；其余写操作一律要求顶栏切到该平面。
    """
    plane = db.current_vrf()
    if plane == db.ALL_VRFS:
        raise ValueError("请先选择具体的 VRF 地址平面，不能在「全部 VRF」汇总视图下编辑拓扑")
    if plane != vrf:
        raise ValueError(f"该拓扑属于地址平面「{vrf}」，请先在顶栏切换到该平面后再编辑")


def _scopes_for(vrf: str) -> list[str] | None:
    raw = auth.current_scopes()
    if not raw:
        return None
    return auth.plain_cidrs(raw, vrf) or ["0.0.0.0/32"]


def _device_rows(conn: sqlite3.Connection, vrf: str) -> list[dict]:
    rows = conn.execute("""
        SELECT d.id, d.name, d.role, d.vendor, d.model, d.mgmt_ip, d.status, d.vrf,
               d.location_id, d.rack_id, r.name AS rack_name, l.name AS location_name
        FROM asset_devices d
        LEFT JOIN asset_racks r ON r.id = d.rack_id
        LEFT JOIN asset_locations l ON l.id = d.location_id
        WHERE d.vrf = ? ORDER BY d.name, d.id
    """, (vrf,))
    return [dict(r) for r in rows]


def _catalog_devices(conn: sqlite3.Connection, vrf: str) -> list[dict]:
    rows = assets._scope_filter(_device_rows(conn, vrf), _scopes_for(vrf), ("mgmt_ip",))
    return [r for r in rows if r["id"]]


def _links(conn: sqlite3.Connection, ids: set[str]) -> list[dict]:
    if len(ids) < 2:
        return []
    rows = [dict(r) for r in conn.execute("""
        SELECT id, name, local_device_id, local_port, remote_device_id, remote_port,
               kind, bandwidth_gbps, vlan, status
        FROM asset_links ORDER BY id
    """)]
    return [r for r in rows
            if r["local_device_id"] in ids and r["remote_device_id"] in ids
            and r["local_device_id"] != r["remote_device_id"]]


def _clean_ids(raw) -> list[str]:
    if not isinstance(raw, list):
        raise ValueError("设备列表格式不正确")
    out: list[str] = []
    for item in raw:
        value = str(item or "").strip()
        if value and value not in out:
            out.append(value)
    return out


def layout(device_ids: list[str], links: list[dict], root: str | None = None) -> dict:
    """按链路关系生成树形布局；纯函数，便于单测直接调用。"""
    adj: dict[str, list[str]] = defaultdict(list)
    for link in links:
        a, b = link["local_device_id"], link["remote_device_id"]
        if a == b:
            continue
        adj[a].append(b)
        adj[b].append(a)
    for key in adj:
        adj[key] = sorted(set(adj[key]))

    ids = list(dict.fromkeys(device_ids))
    if not ids:
        return {"root": None, "coords": {}, "parent": {}, "depth": {},
                "tree_edges": set(), "isolated": [], "levels": [],
                "width": MIN_WIDTH, "height": 240}

    degrees = {i: len(adj.get(i, [])) for i in ids}
    chosen = root if root in ids else min(ids, key=lambda i: (-degrees.get(i, 0), str(i)))

    visited = {chosen}
    parent: dict[str, str | None] = {chosen: None}
    tree_edges: set[frozenset] = set()
    depth: dict[str, int] = {chosen: 0}
    levels: list[list[str]] = []
    queue = deque([chosen])
    while queue:
        layer = [queue.popleft() for _ in range(len(queue))]
        levels.append(layer)
        nxt: list[str] = []
        for cur in layer:
            for nb in adj.get(cur, []):
                if nb in visited:
                    continue
                visited.add(nb)
                parent[nb] = cur
                depth[nb] = len(levels)
                tree_edges.add(frozenset((cur, nb)))
                nxt.append(nb)
        queue = deque(nxt)

    isolated = [i for i in ids if i not in visited]
    if isolated:
        levels.append(isolated)
        for i in isolated:
            parent[i] = None
            depth[i] = len(levels) - 1

    widest = max(len(layer) for layer in levels)
    width = max(MIN_WIDTH, widest * COL_GAP + 160)
    coords: dict[str, tuple[float, float]] = {}
    for level, layer in enumerate(levels):
        count = len(layer)
        for idx, did in enumerate(layer):
            x = width / 2 + (idx - (count - 1) / 2) * COL_GAP
            coords[did] = (round(x, 1), round(ORIGIN_Y + level * ROW_GAP, 1))
    return {
        "root": chosen, "coords": coords, "parent": parent, "depth": depth,
        "tree_edges": tree_edges, "isolated": isolated, "levels": levels,
        "width": width, "height": ORIGIN_Y + len(levels) * ROW_GAP + 100,
    }


def _sync_members(conn: sqlite3.Connection, topo: sqlite3.Row, device_ids: list[str],
                  reset_pinned: bool = False) -> dict:
    """把 topology_nodes 同步到 device_ids，并刷新未固定节点的自动坐标。"""
    valid = {d["id"] for d in _device_rows(conn, topo["vrf"])}
    unknown = [i for i in device_ids if i not in valid]
    if unknown:
        raise ValueError("以下设备不存在或不在该拓扑的地址平面内：" + "、".join(unknown[:5]))
    topo_id = topo["id"]
    root = str(topo["root_device_id"] or "") if topo["root_mode"] == "manual" else None
    if root and root not in device_ids:
        raise ValueError("手动指定的根设备必须在所选设备内")
    if reset_pinned:
        conn.execute("UPDATE topology_nodes SET pinned=0 WHERE topology_id=?", (topo_id,))
    if device_ids:
        marks = ",".join("?" for _ in device_ids)
        conn.execute(f"DELETE FROM topology_nodes WHERE topology_id=? AND device_id NOT IN ({marks})",
                     [topo_id] + device_ids)
    else:
        conn.execute("DELETE FROM topology_nodes WHERE topology_id=?", (topo_id,))
    links = _links(conn, set(device_ids))
    lay = layout(device_ids, links, root)
    for did in device_ids:
        x, y = lay["coords"][did]
        conn.execute("INSERT OR IGNORE INTO topology_nodes(topology_id,device_id,x,y,pinned) "
                     "VALUES(?,?,?,?,0)", (topo_id, did, x, y))
    for did in device_ids:
        x, y = lay["coords"][did]
        conn.execute("UPDATE topology_nodes SET x=?,y=? WHERE topology_id=? AND device_id=? AND pinned=0",
                     (x, y, topo_id, did))
    return lay


def _row(conn: sqlite3.Connection, topo_id: str) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM topologies WHERE id=?", (topo_id,)).fetchone()
    if row is None:
        raise LookupError("拓扑图不存在")
    return row


def list_topologies(conn: sqlite3.Connection) -> dict:
    plane = db.current_vrf()
    sql = ("SELECT t.*, (SELECT COUNT(*) FROM topology_nodes n WHERE n.topology_id=t.id) "
           "AS device_count FROM topologies t")
    args: list = []
    if plane != db.ALL_VRFS:
        sql += " WHERE t.vrf=?"
        args.append(plane)
    sql += " ORDER BY COALESCE(t.updated_at,t.created_at) DESC, t.id"
    rows = [dict(r) for r in conn.execute(sql, args)]
    all_links = [(r[0], r[1]) for r in conn.execute(
        "SELECT local_device_id, remote_device_id FROM asset_links")]
    for row in rows:
        ids = {r[0] for r in conn.execute(
            "SELECT device_id FROM topology_nodes WHERE topology_id=?", (row["id"],))}
        row["link_count"] = sum(1 for a, b in all_links if a in ids and b in ids)
    return {"items": rows, "plane": plane, "vrfs": _planes(conn)}


def catalog(conn: sqlite3.Connection, vrf: str | None = None) -> dict:
    """新建弹窗 / 编辑器设备池的数据源，按指定平面取设备（与顶栏平面解耦）。"""
    value = _require_plane(conn, str(vrf or "").strip() or "default")
    return {"vrf": value, "items": _catalog_devices(conn, value), "vrfs": _planes(conn)}


def get_topology(conn: sqlite3.Connection, topo_id: str) -> dict:
    topo = _row(conn, topo_id)
    node_rows = [dict(r) for r in conn.execute(
        "SELECT device_id,x,y,pinned FROM topology_nodes WHERE topology_id=?", (topo_id,))]
    devices = {d["id"]: d for d in _device_rows(conn, topo["vrf"])}
    selected = [r["device_id"] for r in node_rows if r["device_id"] in devices]
    links = _links(conn, set(selected))
    root = str(topo["root_device_id"] or "") if topo["root_mode"] == "manual" else None
    lay = layout(selected, links, root)
    saved = {r["device_id"]: r for r in node_rows}
    nodes = []
    for did in selected:
        row = saved[did]
        auto_x, auto_y = lay["coords"][did]
        pinned = int(row["pinned"] or 0)
        nodes.append({
            **devices[did],
            "x": float(row["x"]) if pinned else auto_x,
            "y": float(row["y"]) if pinned else auto_y,
            "auto_x": auto_x, "auto_y": auto_y,
            "pinned": pinned, "parent": lay["parent"][did],
            "depth": lay["depth"][did], "is_root": did == lay["root"],
        })
    edges = []
    for link in links:
        pair = frozenset((link["local_device_id"], link["remote_device_id"]))
        # edge_role 是生成树标记；link.kind（trunk / access 等链路类型）原样保留
        edges.append({**link, "edge_role": "tree" if pair in lay["tree_edges"] else "extra"})
    plane = db.current_vrf()
    return {
        "id": topo["id"], "name": topo["name"], "description": topo["description"],
        "vrf": topo["vrf"], "root_mode": topo["root_mode"],
        "root_device_id": topo["root_device_id"], "resolved_root": lay["root"],
        "created_at": topo["created_at"], "updated_at": topo["updated_at"],
        "plane": plane, "writable": plane != db.ALL_VRFS and plane == topo["vrf"],
        "vrfs": _planes(conn),
        "catalog": {"vrf": topo["vrf"], "items": _catalog_devices(conn, topo["vrf"])},
        "nodes": nodes, "edges": edges,
        "missing_devices": [r["device_id"] for r in node_rows
                            if r["device_id"] not in devices],
        "stats": {
            "devices": len(nodes), "links": len(edges),
            "tree_links": sum(1 for e in edges if e["edge_role"] == "tree"),
            "isolated": len([n for n in nodes if n["parent"] is None and not n["is_root"]]),
            "pinned": sum(1 for n in nodes if n["pinned"]),
        },
        "canvas": {"width": lay["width"], "height": lay["height"]},
    }


def _name(value, field: str = "拓扑名称") -> str:
    text = str(value or "").strip()
    if not text:
        raise ValueError(f"{field}不能为空")
    if len(text) > MAX_NAME:
        raise ValueError(f"{field}不能超过 {MAX_NAME} 个字符")
    return text


def create_topology(conn: sqlite3.Connection, payload: dict, actor: str | None = None) -> dict:
    name = _name(payload.get("name"))
    description = str(payload.get("description") or "").strip()[:MAX_DESC]
    vrf = _require_plane(conn, payload.get("vrf"))
    plane = db.current_vrf()
    if plane != db.ALL_VRFS and plane != vrf:
        raise ValueError(f"当前顶栏地址平面为「{plane}」，请先切换后再新建「{vrf}」的拓扑")
    device_ids = _clean_ids(payload.get("device_ids"))
    root_mode = "manual" if payload.get("root_mode") == "manual" else "auto"
    root_device_id = str(payload.get("root_device_id") or "").strip() or None
    if root_mode == "manual" and not root_device_id:
        raise ValueError("手动指定根设备时请选择一台设备")
    if root_device_id and root_device_id not in device_ids:
        raise ValueError("手动指定的根设备必须在所选设备内")
    topo_id = _id()
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute(
            "INSERT INTO topologies(id,name,description,vrf,root_mode,root_device_id,created_at,updated_at) "
            "VALUES(?,?,?,?,?,?,?,NULL)",
            (topo_id, name, description, vrf, root_mode, root_device_id, db.now()))
        topo = _row(conn, topo_id)
        _sync_members(conn, topo, device_ids)
        db.audit(conn, "topology.create", "-", f"新建拓扑图 {name}（{len(device_ids)} 台设备）", vrf=vrf)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return {"id": topo_id, "name": name, "vrf": vrf, "device_count": len(device_ids)}


def update_topology(conn: sqlite3.Connection, topo_id: str, payload: dict,
                    actor: str | None = None) -> dict:
    topo = _row(conn, topo_id)
    _assert_write_plane(topo["vrf"])
    name = _name(payload.get("name"), "拓扑名称") if "name" in payload else topo["name"]
    description = (str(payload.get("description") or "").strip()[:MAX_DESC]
                   if "description" in payload else topo["description"])
    root_mode = ("manual" if payload.get("root_mode") == "manual" else "auto"
                 if "root_mode" in payload else topo["root_mode"])
    root_device_id = (str(payload.get("root_device_id") or "").strip() or None
                      if "root_device_id" in payload or "root_mode" in payload
                      else topo["root_device_id"])
    if root_mode == "auto":
        root_device_id = None
    device_ids = (_clean_ids(payload.get("device_ids"))
                  if "device_ids" in payload else
                  [r[0] for r in conn.execute(
                      "SELECT device_id FROM topology_nodes WHERE topology_id=?", (topo_id,))])
    if root_mode == "manual" and not root_device_id:
        raise ValueError("手动指定根设备时请选择一台设备")
    root_changed = (root_mode != topo["root_mode"] or root_device_id != topo["root_device_id"])
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute("UPDATE topologies SET name=?,description=?,root_mode=?,root_device_id=?,"
                     "updated_at=? WHERE id=?",
                     (name, description, root_mode, root_device_id, db.now(), topo_id))
        _sync_members(conn, _row(conn, topo_id), device_ids, reset_pinned=root_changed)
        db.audit(conn, "topology.update", "-", f"编辑拓扑图 {name}", vrf=topo["vrf"])
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return {"id": topo_id, "name": name, "device_count": len(device_ids)}


def relayout_topology(conn: sqlite3.Connection, topo_id: str,
                      actor: str | None = None) -> dict:
    topo = _row(conn, topo_id)
    _assert_write_plane(topo["vrf"])
    device_ids = [r[0] for r in conn.execute(
        "SELECT device_id FROM topology_nodes WHERE topology_id=?", (topo_id,))]
    conn.execute("BEGIN IMMEDIATE")
    try:
        _sync_members(conn, topo, device_ids, reset_pinned=True)
        conn.execute("UPDATE topologies SET updated_at=? WHERE id=?", (db.now(), topo_id))
        db.audit(conn, "topology.relayout", "-", f"重新布局拓扑图 {topo['name']}", vrf=topo["vrf"])
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return {"id": topo_id, "devices": len(device_ids)}


def save_layout(conn: sqlite3.Connection, topo_id: str, nodes, actor: str | None = None) -> dict:
    topo = _row(conn, topo_id)
    _assert_write_plane(topo["vrf"])
    if not isinstance(nodes, list):
        raise ValueError("坐标列表格式不正确")
    conn.execute("BEGIN IMMEDIATE")
    try:
        changed = 0
        for item in nodes:
            if not isinstance(item, dict):
                continue
            did = str(item.get("device_id") or "").strip()
            try:
                x, y = float(item.get("x")), float(item.get("y"))
            except (TypeError, ValueError):
                raise ValueError("节点坐标必须是数字")
            if not math.isfinite(x) or not math.isfinite(y) or abs(x) > 100000 or abs(y) > 100000:
                raise ValueError("节点坐标超出范围")
            cur = conn.execute(
                "UPDATE topology_nodes SET x=?,y=?,pinned=1 WHERE topology_id=? AND device_id=?",
                (round(x, 1), round(y, 1), topo_id, did))
            changed += cur.rowcount
        conn.execute("UPDATE topologies SET updated_at=? WHERE id=?", (db.now(), topo_id))
        db.audit(conn, "topology.layout", "-", f"保存 {changed} 个节点位置：{topo['name']}",
                 vrf=topo["vrf"])
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return {"id": topo_id, "saved": changed}


def delete_topology(conn: sqlite3.Connection, topo_id: str, actor: str | None = None) -> dict:
    topo = _row(conn, topo_id)
    _assert_write_plane(topo["vrf"])
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute("DELETE FROM topology_nodes WHERE topology_id=?", (topo_id,))
        conn.execute("DELETE FROM topologies WHERE id=?", (topo_id,))
        db.audit(conn, "topology.delete", "-", f"删除拓扑图 {topo['name']}", vrf=topo["vrf"])
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return {"id": topo_id, "name": topo["name"]}


def duplicate_topology(conn: sqlite3.Connection, topo_id: str,
                       actor: str | None = None) -> dict:
    topo = _row(conn, topo_id)
    _require_plane(conn, topo["vrf"])
    new_id = _id()
    name = _name((topo["name"] + " 副本")[:MAX_NAME])
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute(
            "INSERT INTO topologies(id,name,description,vrf,root_mode,root_device_id,created_at,updated_at) "
            "VALUES(?,?,?,?,?,?,?,NULL)",
            (new_id, name, topo["description"], topo["vrf"], topo["root_mode"],
             topo["root_device_id"], db.now()))
        conn.execute(
            "INSERT INTO topology_nodes(topology_id,device_id,x,y,pinned) "
            "SELECT ?,device_id,x,y,pinned FROM topology_nodes WHERE topology_id=?",
            (new_id, topo_id))
        db.audit(conn, "topology.duplicate", "-", f"复制拓扑图 {topo['name']}", vrf=topo["vrf"])
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return {"id": new_id, "name": name, "vrf": topo["vrf"]}
