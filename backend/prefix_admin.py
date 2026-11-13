"""地址空间树写操作（对应架构图 01 接入层 / 03 领域核心层）。

设计要点：
- 真 VRF 隔离：唯一键是 (vrf, cidr)。重叠、父子、引用检查全部限定在同一地址平面内，
  因此 10.1.0.0/16 可以同时存在于 default 与 vrf-prod 两张平面且互不干扰。
- 前缀树不是普通 CRUD：cidr 同时被 ip_addresses / discovery_records /
  reconciliation_diffs / tickets / 子前缀的 parent_cidr 引用。改名必须在同一事务内
  同步全部引用（且带 vrf 条件），否则会产生孤儿地址与错误归属。
- 顶级根空间切换 VRF 时，整棵子树与相关地址记录一起迁移到目标平面；非根节点
  不允许单独换平面，避免父子跨平面断裂。
- 所有写操作都写审计日志 + Webhook 事件，且只有前缀元数据可变；
  IP 状态仍统一由 domain 状态机约束。
"""
from __future__ import annotations

from . import db, domain, extended

FIELD_LABELS = {
    "cidr": "CIDR", "parent_cidr": "父前缀", "name": "名称", "site": "站点",
    "vlan": "VLAN", "vrf": "VRF", "description": "备注",
}

# 引用了前缀 CIDR 的表。CIDR 变更时逐表同步，顺序在主键更新之前完成。
REFERENCE_TABLES = ("ip_addresses", "discovery_records", "reconciliation_diffs", "tickets")


def parse_cidr(value) -> str:
    """strict 解析：10.1.1.1/24 这类带主机位的写法会被拒绝。"""
    raw = str(value or "").strip()
    try:
        n = domain.net(raw)
    except Exception as exc:
        raise ValueError(f"CIDR 格式不合法：{raw or '(空)'}（需使用网络地址，例如 10.1.1.0/24）") from exc
    if not (8 <= n.prefixlen <= 30):
        raise ValueError("掩码长度需在 /8 – /30 之间（/31、/32 无可分配地址）")
    return str(n)


def _fields(conn, payload: dict, current: dict | None) -> dict:
    """统一清洗可编辑属性，未提交的字段沿用现值。"""
    def pick(key: str, default=None):
        if key in payload:
            return payload[key]
        if current is not None:
            return current[key]
        return default

    name = str(pick("name", "") or "").strip()
    if not name:
        raise ValueError("名称不能为空")
    if len(name) > 60:
        raise ValueError("名称不能超过 60 个字符")

    site = str(pick("site", "") or "").strip() or None
    if site and len(site) > 40:
        raise ValueError("站点名称不能超过 40 个字符")

    vlan_raw = pick("vlan", None)
    if vlan_raw in (None, "", "null", "None"):
        vlan = None
    else:
        try:
            vlan = int(vlan_raw)
        except (TypeError, ValueError) as exc:
            raise ValueError("VLAN 必须是 1–4094 的整数") from exc
        if not (1 <= vlan <= 4094):
            raise ValueError("VLAN 必须在 1–4094 之间")

    vrf = str(pick("vrf", "default") or "default").strip()
    if conn.execute("SELECT 1 FROM vrfs WHERE name=?", (vrf,)).fetchone() is None:
        raise ValueError(f"VRF 地址平面「{vrf}」不存在，请先在「VRF 地址平面」页创建")

    description = str(pick("description", "") or "").strip()[:200]
    return {"name": name, "site": site, "vlan": vlan, "vrf": vrf, "description": description}


def _plane(vrf=None) -> str:
    value = db.current_vrf() if vrf is None else (vrf or "default")
    if value == db.ALL_VRFS:
        raise ValueError("请先选择具体的 VRF 地址平面，不能在「全部 VRF」汇总视图下写操作")
    return value


def _validate(conn, cidr: str, current: str | None, parent: str | None, kind: str,
              vrf=None, target_vrf: str | None = None) -> dict:
    """编辑 / 新建 / 预检共用的规则引擎。

    vrf = 当前节点所在的源平面；target_vrf = 变更后所属平面（默认同源）。
    重叠检查在目标平面内执行，引用与子树检查在源平面内执行。
    """
    src = _plane(vrf)
    dst = target_vrf or src
    issues: list[str] = []
    warnings: list[str] = []
    dst_cond, dst_args = db.vrf_sql(dst)
    existing = [r[0] for r in conn.execute("SELECT cidr FROM prefixes" + dst_cond, dst_args)]
    # 编辑时当前节点及其后代属于同一棵子树，会一起迁移，不属于外部冲突。
    excluded = {current} if current else set()
    if current:
        excluded.update(_descendants(conn, current, src))
    conflicts = domain.plan_conflicts(cidr, [e for e in existing if e not in excluded])
    if conflicts:
        issues.append(f"与 {dst} 平面内已有前缀重叠：" + ", ".join(conflicts[:4]))

    # 根空间是彼此平级的顶级地址空间，任何相交都必须阻断（仍只在目标平面内判）。
    if kind == "root":
        nested = [e for e in existing if e not in excluded and domain.overlaps(cidr, e)]
        if nested:
            issues.append(f"根空间与 {dst} 平面内已有前缀重叠：" + ", ".join(nested[:4]))
            conflicts = list(conflicts) + nested

    if kind == "root" and parent:
        issues.append("根空间是顶级地址空间，不能有父前缀")
    if parent:
        prow = conn.execute("SELECT * FROM prefixes WHERE cidr=?" + dst_cond.replace(" WHERE ", " AND "),
                            [parent] + dst_args).fetchone()
        if prow is None:
            issues.append(f"父前缀 {parent} 不存在于 {dst} 地址平面")
        elif prow["kind"] == "subnet":
            issues.append("父前缀不能是可分配子网")
        elif parent == cidr:
            issues.append("父前缀不能指向自身")
        elif not domain.contains(parent, cidr):
            issues.append(f"{cidr} 不被父前缀 {parent} 包含")
        if current and domain.contains(current, parent):
            issues.append("不能把节点迁移到自己的子前缀下")
    elif kind != "root":
        issues.append("非根空间必须指定父前缀")

    children: list[str] = []
    affected_ips = 0
    src_cond, src_args = db.vrf_sql(src, joiner="AND")
    if current:
        children = [r[0] for r in conn.execute(
            "SELECT cidr FROM prefixes WHERE parent_cidr=?" + src_cond,
            [current] + src_args)]
        escaped = [k for k in children if not domain.contains(cidr, k)]
        if escaped:
            issues.append(f"变更后将脱离 {len(escaped)} 个子前缀：{', '.join(escaped[:3])}")
        start, end, _ = domain.bounds(cidr)
        affected_ips = conn.execute(
            "SELECT COUNT(*) FROM ip_addresses WHERE prefix_cidr=?" + src_cond,
            [current] + src_args).fetchone()[0]
        outside = conn.execute(
            "SELECT COUNT(*) FROM ip_addresses WHERE prefix_cidr=?" + src_cond +
            " AND (addr_int < ? OR addr_int > ?)", [current] + src_args + [start, end]).fetchone()[0]
        if outside:
            issues.append(f"{outside} 个已登记地址将落在新网段之外，请先回收或调整 CIDR")
        if domain.net(cidr).prefixlen != domain.net(current).prefixlen:
            warnings.append("掩码长度改变，容量与利用率将按新网段规模重新计算")
        if dst != src:
            warnings.append(f"整棵子树与 {affected_ips} 条地址记录将迁移到 {dst} 地址平面")
        elif cidr != current and not issues:
            warnings.append(f"将同步更新 {affected_ips} 条地址记录及发现/差异/工单中的前缀引用")
    return {"issues": issues, "warnings": warnings, "conflicts": conflicts,
            "children": children, "affected_ips": affected_ips}


def _descendants(conn, cidr: str, vrf=None) -> list[str]:
    """BFS 取同一地址平面内的全部后代。"""
    plane = _plane(vrf)
    cond, args = db.vrf_sql(plane, joiner="AND")
    found, seen, frontier = [], {cidr}, [cidr]
    while frontier:
        nxt = []
        for p in frontier:
            for row in conn.execute(
                    "SELECT cidr FROM prefixes WHERE parent_cidr=?" + cond, [p] + args):
                child = row[0]
                if child not in seen:
                    seen.add(child)
                    found.append(child)
                    nxt.append(child)
        frontier = nxt
    return found


def preflight(conn, cidr: str, current: str | None = None,
              parent: str | None = None, kind: str = "subnet", vrf=None) -> dict:
    """前端表单实时预检，与写操作共用同一套校验规则（按目标 VRF 平面判冲突）。"""
    plane = _plane(vrf)
    try:
        normalized = parse_cidr(cidr)
    except ValueError as exc:
        return {"valid": False, "info": None, "cidr": str(cidr or ""), "vrf": plane,
                "issues": [str(exc)], "warnings": [], "conflicts": [],
                "children": [], "affected_ips": 0, "can_apply": False}
    p = (parent or "").strip() or None
    check = _validate(conn, normalized, current or None, p, kind, plane)
    return {
        "valid": not check["issues"], "info": domain.cidr_info(normalized),
        "cidr": normalized, "vrf": plane, "issues": check["issues"],
        "warnings": check["warnings"], "conflicts": check["conflicts"],
        "children": check["children"], "affected_ips": check["affected_ips"],
        "can_apply": not check["issues"],
    }


def impact(conn, cidr: str, vrf=None) -> dict:
    """删除前的影响面评估（只统计当前地址平面内的引用）。"""
    plane = _plane(vrf)
    cond, args = db.vrf_sql(plane, joiner="AND")
    row = conn.execute("SELECT * FROM prefixes WHERE cidr=?" + cond,
                       [cidr] + args).fetchone()
    if row is None:
        raise LookupError(f"前缀 {cidr} 不存在于 {plane} 地址平面")
    children = _descendants(conn, cidr, plane)
    ips = conn.execute("SELECT COUNT(*) FROM ip_addresses WHERE prefix_cidr=?" + cond,
                       [cidr] + args).fetchone()[0]
    open_diffs = conn.execute(
        "SELECT COUNT(*) FROM reconciliation_diffs WHERE prefix_cidr=?" + cond +
        " AND status='open'", [cidr] + args).fetchone()[0]
    pending_tickets = conn.execute(
        "SELECT COUNT(*) FROM tickets WHERE prefix_cidr=?" + cond +
        " AND status='pending'", [cidr] + args).fetchone()[0]
    reasons = []
    root_count = conn.execute(
        "SELECT COUNT(*) FROM prefixes WHERE kind='root'" + cond, args).fetchone()[0]
    if row["kind"] == "root" and root_count <= 1:
        reasons.append("需至少保留一个根空间作为地址空间树入口")
    if children:
        reasons.append(f"还有 {len(children)} 个子前缀，需先删除或迁移")
    if ips:
        reasons.append(f"还有 {ips} 条已登记地址，需先全部回收")
    if open_diffs:
        reasons.append(f"还有 {open_diffs} 条待处理对账差异引用该网段")
    if pending_tickets:
        reasons.append(f"还有 {pending_tickets} 条待审批工单引用该网段")
    return {"cidr": cidr, "children": len(children), "ips": ips,
            "open_diffs": open_diffs, "pending_tickets": pending_tickets,
            "can_delete": not reasons, "reasons": reasons}


def update_prefix(conn, cidr: str, payload: dict, vrf=None) -> dict:
    """编辑前缀：属性 / CIDR / 父前缀 / 所属 VRF 平面可改，级联同步可选。"""
    src = _plane(vrf)
    cond, args = db.vrf_sql(src, joiner="AND")
    conn.execute("BEGIN IMMEDIATE")
    try:
        row = conn.execute("SELECT * FROM prefixes WHERE cidr=?" + cond,
                           [cidr] + args).fetchone()
        if row is None:
            raise LookupError(f"前缀 {cidr} 不存在于 {src} 地址平面")
        new_cidr = parse_cidr(payload.get("cidr", cidr))
        parent_raw = payload.get("parent_cidr", row["parent_cidr"])
        parent = str(parent_raw).strip() if parent_raw else None
        fields = _fields(conn, payload, dict(row))
        dst = fields["vrf"]
        if dst != src and row["parent_cidr"]:
            raise ValueError("只有顶级根空间可以切换 VRF 地址平面（会连同整棵子树一起迁移）；"
                             "子节点请切换到目标平面后重新创建")
        check = _validate(conn, new_cidr, cidr, parent, row["kind"], src, dst)
        if check["issues"]:
            raise ValueError("；".join(check["issues"]))

        before = {
            "cidr": cidr, "parent_cidr": row["parent_cidr"], "name": row["name"],
            "site": row["site"], "vlan": row["vlan"], "vrf": row["vrf"],
            "description": row["description"],
        }
        after = {"cidr": new_cidr, "parent_cidr": parent, **fields}
        changes = [
            f"{FIELD_LABELS[k]}：{before[k] or '—'} → {after[k] or '—'}"
            for k in FIELD_LABELS if before[k] != after[k]
        ]

        # 在 CIDR 级联之前取原始后代列表（子树迁移需要用旧 cidr 定位）
        kids = _descendants(conn, cidr, src)

        # CIDR 变更：先同步全部引用（限定源平面），再改主键
        if new_cidr != cidr:
            for table in REFERENCE_TABLES:
                conn.execute(
                    f"UPDATE {table} SET prefix_cidr=? WHERE prefix_cidr=?" + cond,
                    [new_cidr, cidr] + args)
            conn.execute("UPDATE prefixes SET parent_cidr=? WHERE parent_cidr=?" + cond,
                         [new_cidr, cidr] + args)

        moved = 0
        if dst != src:
            # 整棵子树连同地址记录 / 差异 / 工单迁移到目标平面。
            # 引用表的 prefix_cidr 可能已改为 new_cidr，prefixes 表主键仍是旧 cidr。
            ref_tree = [new_cidr] + kids
            pfx_tree = [cidr] + kids
            ref_marks = ",".join("?" * len(ref_tree))
            pfx_marks = ",".join("?" * len(pfx_tree))
            for table in REFERENCE_TABLES:
                conn.execute(
                    f"UPDATE {table} SET vrf=? WHERE vrf=? AND prefix_cidr IN ({ref_marks})",
                    [dst, src] + ref_tree)
            conn.execute(
                f"UPDATE prefixes SET vrf=? WHERE vrf=? AND cidr IN ({pfx_marks})",
                [dst, src] + pfx_tree)
            moved = len(pfx_tree)
            src = dst
            cond, args = db.vrf_sql(src, joiner="AND")

        conn.execute(
            "UPDATE prefixes SET cidr=?,parent_cidr=?,name=?,site=?,vlan=?,description=?,updated_at=? "
            "WHERE cidr=?" + cond,
            [new_cidr, parent, fields["name"], fields["site"], fields["vlan"],
             fields["description"], db.now(), cidr] + args,
        )

        cascaded = 0
        if payload.get("cascade_children"):
            kids = _descendants(conn, new_cidr, src)
            if kids:
                conn.executemany(
                    "UPDATE prefixes SET site=?,vlan=?,updated_at=? WHERE cidr=?" + cond,
                    [(fields["site"], fields["vlan"], db.now(), k) + tuple(args) for k in kids],
                )
                cascaded = len(kids)

        detail = f"[{src}] 编辑前缀 " + cidr + (" → " + new_cidr if new_cidr != cidr else "") + \
                 "：" + ("；".join(changes) if changes else "无字段变更")
        if moved:
            detail += f"；迁移 {moved} 个前缀到 {src} 地址平面"
        if cascaded:
            detail += f"；级联同步 {cascaded} 个子前缀"
        db.audit(conn, "space.update", cidr, detail, src)
        extended.emit(conn, "space.updated", new_cidr,
                      {"previous": cidr, "vrf": src, "changes": changes,
                       "cascaded": cascaded, "moved": moved})
        conn.commit()
        return {"cidr": new_cidr, "vrf": src, "previous_cidr": cidr, "changes": changes,
                "cascaded": cascaded, "moved": moved,
                "affected_ips": check["affected_ips"] if new_cidr != cidr else 0}
    except Exception:
        conn.rollback()
        raise


def create_prefix(conn, payload: dict, vrf=None) -> dict:
    """在指定 VRF 地址平面新增顶级根空间 / 汇聚前缀 / 可分配子网。

    重叠判定只在该平面内进行，因此不同 VRF 可以使用完全相同的 CIDR；
    根空间不挂载父前缀，也不继承任何父级属性。
    """
    plane = str(payload.get("vrf") or "").strip() or _plane(vrf)
    if plane == db.ALL_VRFS:
        raise ValueError("请先选择具体的 VRF 地址平面，不能在「全部 VRF」汇总视图下新建")
    conn.execute("BEGIN IMMEDIATE")
    try:
        cidr = parse_cidr(payload.get("cidr"))
        kind = str(payload.get("kind") or "subnet")
        if kind not in ("root", "aggregate", "subnet"):
            raise ValueError("只能新建「根空间 / 汇聚前缀 / 可分配子网」")
        parent = str(payload.get("parent_cidr") or "").strip() or None
        if kind == "root" and parent:
            raise ValueError("根空间是顶级地址空间，不能有父前缀")
        fields = _fields(conn, {**payload, "vrf": plane}, None)
        check = _validate(conn, cidr, None, parent, kind, plane, plane)
        if check["issues"]:
            raise ValueError("；".join(check["issues"]))
        pcond, pargs = db.vrf_sql(plane, joiner="AND")
        prow = conn.execute("SELECT * FROM prefixes WHERE cidr=?" + pcond,
                            [parent] + pargs).fetchone() if parent else None
        # 未显式给站点时继承同一平面内的父前缀；VRF 固定为当前平面
        site = fields["site"] if (prow is None or "site" in payload) else prow["site"]
        conn.execute(
            "INSERT INTO prefixes(vrf,cidr,parent_cidr,name,kind,site,vlan,description,updated_at) "
            "VALUES(?,?,?,?,?,?,?,?,?)",
            (plane, cidr, parent, fields["name"], kind, site, fields["vlan"],
             fields["description"], db.now()),
        )
        label = {"root": "顶级根空间", "aggregate": "汇聚前缀", "subnet": "子网"}[kind]
        db.audit(conn, "space.create", None,
                 f"[{plane}] 新建{label} {cidr}（{fields['name']}）" +
                 (f"于 {parent} 下" if parent else "，与本平面现有根空间平级"), plane)
        extended.emit(conn, "space.created", cidr,
                      {"kind": kind, "parent": parent, "vrf": plane})
        conn.commit()
        return {"cidr": cidr, "vrf": plane, "kind": kind,
                "name": fields["name"], "parent_cidr": parent}
    except Exception:
        conn.rollback()
        raise


def delete_prefix(conn, cidr: str, vrf=None) -> dict:
    """只允许删除当前平面内、无在册引用与待办的前缀。"""
    plane = _plane(vrf)
    cond, args = db.vrf_sql(plane, joiner="AND")
    conn.execute("BEGIN IMMEDIATE")
    try:
        row = conn.execute("SELECT * FROM prefixes WHERE cidr=?" + cond,
                           [cidr] + args).fetchone()
        if row is None:
            raise LookupError(f"前缀 {cidr} 不存在于 {plane} 地址平面")
        check = impact(conn, cidr, plane)
        if not check["can_delete"]:
            raise ValueError("该前缀不可删除：" + "；".join(check["reasons"]))
        conn.execute("DELETE FROM prefixes WHERE cidr=?" + cond, [cidr] + args)
        db.audit(conn, "space.delete", None,
                 f"[{plane}] 删除前缀 {cidr}（{row['name']}）", plane)
        extended.emit(conn, "space.deleted", cidr, {"kind": row["kind"], "vrf": plane})
        conn.commit()
        return {"cidr": cidr, "vrf": plane, "deleted": True, "name": row["name"]}
    except Exception:
        conn.rollback()
        raise
