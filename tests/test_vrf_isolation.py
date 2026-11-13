"""路线 2「真 VRF 隔离」回归测试。

只用标准库 unittest，不引入额外依赖；每个用例独立临时数据库，
通过替换 db.DB_PATH 运行真实的 init_db() 迁移与种子，因此同时覆盖迁移幂等性。

运行：.venv/bin/python -m unittest discover -s tests -v
"""
from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from backend import assets, auth, db, domain, extended, prefix_admin

REAL_DB_PATH = db.DB_PATH
PLANE = "vrf-a"
OTHER = "vrf-b"


class VrfIsolationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        db.DB_PATH = Path(self.tmp.name) / "ipam.db"
        db.set_current_vrf("default")
        db.init_db()

    def tearDown(self) -> None:
        db.set_current_vrf("default")
        db.DB_PATH = REAL_DB_PATH
        self.tmp.cleanup()

    def conn(self) -> sqlite3.Connection:
        return db.connect()

    def columns(self, conn: sqlite3.Connection, table: str) -> list[str]:
        return [r[1] for r in conn.execute(f"PRAGMA table_info({table})")]

    def primary_key(self, conn: sqlite3.Connection, table: str) -> list[str]:
        return [r[1] for r in conn.execute(f"PRAGMA table_info({table})") if r[5]]

    def seed_plane(self, conn: sqlite3.Connection, name: str,
                   with_subnet: bool = True) -> None:
        """在目标平面建与 default 相同的根 / 汇聚 / 子网（可只建前两级）。"""
        extended.create_vrf(conn, {"name": name, "tenant": "测试", "description": ""})
        chain = [("10.0.0.0/8", "root", None),
                 ("10.1.0.0/16", "aggregate", "10.0.0.0/8")]
        if with_subnet:
            chain.append(("10.1.1.0/24", "subnet", "10.1.0.0/16"))
        for cidr, kind, parent in chain:
            prefix_admin.create_prefix(conn, {
                "cidr": cidr, "name": cidr, "kind": kind, "parent_cidr": parent,
                "vrf": name, "site": "测试", "vlan": None, "description": "",
            }, name)

    def free_addr(self, plane: str, prefix: str = "10.1.1.0/24") -> str:
        """让后端自动取号，避免测试地址与种子数据撞车。"""
        return db.allocate({"prefix": prefix, "business": "测试", "owner": "qa"}, plane)["addr"]

    # ------------------------------------------------------------ 数据层

    def test_composite_keys_and_vrf_columns(self) -> None:
        c = self.conn()
        self.assertEqual(self.primary_key(c, "prefixes"), ["vrf", "cidr"])
        self.assertEqual(self.primary_key(c, "ip_addresses"), ["vrf", "addr"])
        self.assertEqual(self.primary_key(c, "utilization_snapshots"), ["vrf", "day"])
        for table in ("audit_logs", "utilization_snapshots", "discovery_records",
                      "reconciliation_diffs", "tickets", "webhook_events", "vrfs"):
            self.assertIn("vrf" if table != "vrfs" else "warn_threshold",
                          self.columns(c, table), f"{table} 缺少 VRF 相关列")
        # init_db 幂等：再跑一次不应报错或改坏主键
        db.init_db()
        self.assertEqual(self.primary_key(c, "prefixes"), ["vrf", "cidr"])
        c.close()

    def test_same_cidr_across_planes_and_preflight_scope(self) -> None:
        c = self.conn()
        self.seed_plane(c, PLANE)
        rows = c.execute("SELECT vrf FROM prefixes WHERE cidr='10.1.1.0/24' ORDER BY vrf").fetchall()
        self.assertEqual([r[0] for r in rows], ["default", PLANE])
        same = prefix_admin.preflight(c, "10.1.1.0/24", parent="10.1.0.0/16",
                                      kind="subnet", vrf="default")
        self.assertFalse(same["can_apply"], "同平面重复前缀必须被拒")
        # OTHER 平面只有根 / 汇聚，没有该子网：其它平面里的同 CIDR 不应造成冲突
        self.seed_plane(c, OTHER, with_subnet=False)
        cross = prefix_admin.preflight(c, "10.1.1.0/24", parent="10.1.0.0/16",
                                       kind="subnet", vrf=OTHER)
        self.assertTrue(cross["can_apply"], f"跨平面相同 CIDR 必须允许：{cross}")
        self.assertEqual({p["vrf"] for p in db.list_prefixes(c, "default")}, {"default"})
        self.assertEqual({p["vrf"] for p in db.list_prefixes(c, PLANE)}, {PLANE})
        # 'all' 汇总必须等于全部已建平面之和（OTHER 只有根 / 汇聚两级）
        self.assertEqual(len(db.list_prefixes(c, "all")),
                         len(db.list_prefixes(c, "default")) + len(db.list_prefixes(c, PLANE))
                         + len(db.list_prefixes(c, OTHER)))
        c.close()

    def test_same_ip_across_planes_and_reclaim_isolation(self) -> None:
        c = self.conn()
        self.seed_plane(c, PLANE)
        base_default = db.dashboard(c, "default")["occupied"]
        base_plane = db.dashboard(c, PLANE)["occupied"]
        # default 让后端自动取号（种子里已有大量占用地址，不能写死 IP），
        # 再把这个地址手动登记到 PLANE —— 真隔离下同一 IP 允许跨平面重复。
        addr = self.free_addr("default")
        second = db.allocate({"prefix": "10.1.1.0/24", "addr": addr,
                              "business": "测试", "owner": "qa"}, PLANE)
        self.assertEqual(second["addr"], addr)
        self.assertEqual(second["vrf"], PLANE)
        self.assertEqual(db.lookup_ip(c, addr, "default")["item"]["vrf"], "default")
        self.assertEqual(db.lookup_ip(c, addr, PLANE)["item"]["vrf"], PLANE)
        # 两个平面各自 +1，互不相加、互不借用对方容量
        self.assertEqual(db.dashboard(c, "default")["occupied"], base_default + 1)
        self.assertEqual(db.dashboard(c, PLANE)["occupied"], base_plane + 1)
        self.assertEqual(db.address_map(c, "10.1.1.0/24", 0, PLANE)["vrf"], PLANE)
        # 完整回收链路 release → reclaim 只删 default 平面这一行
        db.transition(addr, "release", "default")
        self.assertEqual(db.lookup_ip(c, addr, "default")["item"]["status"], "deprecated")
        db.transition(addr, "reclaim", "default")
        with self.assertRaises(LookupError):
            db.lookup_ip(c, addr, "default")
        self.assertEqual(db.lookup_ip(c, addr, PLANE)["item"]["status"], "assigned",
                         "default 平面回收不能影响其它平面")
        c.close()

    def test_cross_vrf_overlap_report(self) -> None:
        c = self.conn()
        self.seed_plane(c, PLANE)
        addr = self.free_addr("default")
        db.allocate({"prefix": "10.1.1.0/24", "addr": addr,
                     "business": "测试", "owner": "qa"}, PLANE)
        report = extended.cross_vrf_overlap(c)
        self.assertGreaterEqual(report["prefix_count"], 1)
        self.assertGreaterEqual(report["ip_count"], 1)
        self.assertIn("10.1.1.0/24", [x["cidr"] for x in report["prefix_overlap"]])
        self.assertIn(addr, [x["addr"] for x in report["ip_overlap"]])
        self.assertIn(PLANE, report["planes"])
        overlap = next(x for x in report["ip_overlap"] if x["addr"] == addr)
        self.assertEqual(set(overlap["vrfs"].split("、")), {"default", PLANE})
        self.assertEqual(overlap["plane_count"], 2)
        c.close()

    # ------------------------------------------------------------ 治理数据归属

    def test_snapshot_webhook_audit_are_plane_scoped(self) -> None:
        c = self.conn()
        self.seed_plane(c, PLANE)
        db.record_snapshot(c, "default")
        db.record_snapshot(c, PLANE)
        rows = c.execute("SELECT vrf, day FROM utilization_snapshots ORDER BY vrf").fetchall()
        self.assertEqual({r["vrf"] for r in rows}, {"default", PLANE})
        self.assertEqual([t["vrf"] for t in db.dashboard(c, PLANE)["trend"]], [PLANE])
        # 种子数据为 default 生成了 14 天历史曲线，整条曲线都必须只属于 default
        default_trend = db.dashboard(c, "default")["trend"]
        self.assertGreater(len(default_trend), 1)
        self.assertEqual({t["vrf"] for t in default_trend}, {"default"})
        self.assertEqual({t["vrf"] for t in db.dashboard(c, "all")["trend"]}, {"all"})

        extended.emit(c, "unit.probe", "x", {"k": 1}, vrf=PLANE)
        event = c.execute("SELECT vrf, payload FROM webhook_events WHERE event='unit.probe'").fetchone()
        self.assertEqual(event["vrf"], PLANE)
        self.assertIn('"vrf": "vrf-a"', event["payload"])
        # 种子阶段已有 vrf.created / ticket.created 等 default 事件，因此按事件名精确计数
        self.assertEqual(len([e for e in extended.webhook_events(c, 100, PLANE)
                              if e["event"] == "unit.probe"]), 1)
        self.assertEqual(len([e for e in extended.webhook_events(c, 100, "default")
                              if e["event"] == "unit.probe"]), 0)
        # 汇总视图不把 'all' 当成真实平面写进数据
        db.set_current_vrf("all")
        extended.emit(c, "unit.global", None, {})
        self.assertEqual(c.execute(
            "SELECT vrf FROM webhook_events WHERE event='unit.global'").fetchone()[0], "default")
        c.close()

    def test_plane_thresholds_and_validation(self) -> None:
        c = self.conn()
        self.seed_plane(c, PLANE)
        base = db.thresholds(c)
        self.assertEqual(db.plane_thresholds(c, PLANE)["warn"], base["warn"])
        extended.update_vrf(c, PLANE, {"warn_threshold": 55, "crit_threshold": 70})
        self.assertEqual(db.plane_thresholds(c, PLANE)["warn"], 55)
        self.assertEqual(db.plane_thresholds(c, PLANE)["crit"], 70)
        self.assertEqual(db.plane_thresholds(c, "default")["warn"], base["warn"])
        self.assertEqual(db.plane_thresholds(c, "all")["warn"], base["warn"])
        self.assertEqual(db.dashboard(c, PLANE)["thresholds"]["warn"], 55)
        with self.assertRaises(ValueError):
            extended.update_vrf(c, PLANE, {"warn_threshold": 95})  # 与 crit=70 倒挂
        with self.assertRaises(ValueError):
            extended.create_vrf(c, {"name": "vrf-bad", "warn_threshold": 99, "crit_threshold": 10})
        c.close()

    # ------------------------------------------------------------ 写保护 / 锁

    def test_all_view_write_guard(self) -> None:
        from backend import app as webapp
        guard = webapp._is_plane_write
        self.assertTrue(guard("POST", "/api/spaces"))
        self.assertTrue(guard("PUT", "/api/spaces/10.1.1.0/24"))
        self.assertTrue(guard("POST", "/api/allocations"))
        self.assertTrue(guard("POST", "/api/assets/devices"))
        self.assertTrue(guard("POST", "/api/tickets"))
        self.assertTrue(guard("POST", "/api/integrations/snmp/sync"))
        self.assertFalse(guard("GET", "/api/spaces"))
        self.assertFalse(guard("POST", "/api/vrfs"))                    # 平面字典全局配置
        self.assertFalse(guard("PUT", "/api/settings"))
        self.assertFalse(guard("POST", "/api/subnets/plan"))            # 纯计算
        self.assertFalse(guard("POST", "/api/maintenance/snapshot"))    # 跨平面维护
        self.assertFalse(guard("POST", "/api/assets/racks/R1/move"))    # 物理布局
        self.assertFalse(guard("POST", "/api/assets/links"))            # 物理资源
        self.assertFalse(guard("POST", "/api/integrations/snmp/toggle"))

    def test_write_body_cannot_override_request_plane(self) -> None:
        """P0：请求体自带的 vrf 不能把写入挪到别的平面 / 幽灵平面。"""
        from fastapi import HTTPException
        from backend import app as webapp

        c = self.conn()
        self.seed_plane(c, PLANE)
        db.set_current_vrf("default")
        self.assertEqual(webapp._bind_plane({"prefix": "10.1.1.0/24"})["vrf"], "default")
        self.assertEqual(webapp._assert_plane(None), "default")
        with self.assertRaises(HTTPException) as cm:
            webapp._bind_plane({"prefix": "10.1.1.0/24", "vrf": PLANE})
        self.assertEqual(cm.exception.status_code, 400)
        self.assertIn("不一致", cm.exception.detail)
        db.set_current_vrf(PLANE)
        self.assertEqual(webapp._bind_plane({"vrf": PLANE})["vrf"], PLANE)
        db.set_current_vrf(db.ALL_VRFS)
        with self.assertRaises(HTTPException):
            webapp._bind_plane({})
        db.set_current_vrf("ghost-plane")
        with self.assertRaises(HTTPException) as cm:
            webapp._bind_plane({})
        self.assertIn("不存在", cm.exception.detail)
        c.close()

    def test_prefix_lock_is_composite(self) -> None:
        with domain.prefix_lock("default", "10.1.1.0/24"):
            pass
        with domain.prefix_lock(PLANE, "10.1.1.0/24"):
            pass
        keys = {k for k in domain._locks if "10.1.1.0/24" in k}
        self.assertEqual(keys, {"default|10.1.1.0/24", "vrf-a|10.1.1.0/24"})

    # ------------------------------------------------------------ VRF 生命周期

    def test_delete_vrf_migrates_data(self) -> None:
        c = self.conn()
        self.seed_plane(c, PLANE)
        extended.create_vrf(c, {"name": OTHER, "tenant": "测试", "description": ""})
        db.allocate({"prefix": "10.1.1.0/24", "addr": "10.1.1.203",
                     "business": "测试", "owner": "qa"}, PLANE)
        before = c.execute("SELECT COUNT(*) FROM prefixes WHERE vrf=?", (PLANE,)).fetchone()[0]
        res = extended.delete_vrf(c, PLANE, OTHER)
        self.assertTrue(res["deleted"])
        self.assertEqual(res["migrated_to"], OTHER)
        self.assertEqual(c.execute("SELECT COUNT(*) FROM prefixes WHERE vrf=?", (OTHER,)).fetchone()[0],
                         before)
        self.assertEqual(c.execute("SELECT COUNT(*) FROM prefixes WHERE vrf=?", (PLANE,)).fetchone()[0], 0)
        self.assertEqual(c.execute("SELECT COUNT(*) FROM ip_addresses WHERE vrf=?", (OTHER,)).fetchone()[0], 1)
        self.assertIsNone(c.execute("SELECT 1 FROM vrfs WHERE name=?", (PLANE,)).fetchone())
        c.close()

    def test_delete_vrf_conflict_and_default_protection(self) -> None:
        c = self.conn()
        self.seed_plane(c, PLANE)
        self.seed_plane(c, OTHER)
        with self.assertRaisesRegex(ValueError, "已存在相同数据"):
            extended.delete_vrf(c, PLANE, OTHER)
        with self.assertRaisesRegex(ValueError, "默认 VRF 不可删除"):
            extended.delete_vrf(c, "default", PLANE)
        # 未指定迁移目标时仍拒绝删除有数据的平面
        with self.assertRaisesRegex(ValueError, "请选择迁移目标"):
            extended.delete_vrf(c, PLANE)
        c.close()

    # ------------------------------------------------------------ 资产与权限

    def test_asset_plane_binding_and_list_filtering(self) -> None:
        c = self.conn()
        self.seed_plane(c, PLANE)
        default_count = len(assets.list_assets(c, "devices")["items"])
        db.set_current_vrf("all")
        total_before = len(assets.list_assets(c, "devices")["items"])
        db.set_current_vrf(PLANE)
        created = assets.create_asset(c, "devices", {"id": "dev-p2-1", "name": "测试设备"})
        self.assertEqual(created["vrf"], PLANE)
        self.assertEqual(len(assets.list_assets(c, "devices")["items"]), 1)
        with self.assertRaisesRegex(ValueError, "必须为当前平面"):
            assets.create_asset(c, "devices",
                                {"id": "dev-p2-2", "name": "跨平面设备", "vrf": "default"})
        db.set_current_vrf("all")
        with self.assertRaisesRegex(ValueError, "汇总视图"):
            assets.create_asset(c, "devices", {"id": "dev-p2-3", "name": "汇总视图设备"})
        # 'all' 视图是全量设备（含其它平面的种子设备），不能拿 default 平面数推算
        self.assertEqual(len(assets.list_assets(c, "devices")["items"]), total_before + 1)
        db.set_current_vrf("default")
        self.assertEqual(len(assets.list_assets(c, "devices")["items"]), default_count)
        c.close()

    def test_vrf_scoped_authorization(self) -> None:
        scopes = auth.normalize_scopes(["vrf-lab:10.1.0.0/16", "10.0.0.0/8"])
        self.assertEqual(auth.plain_cidrs(scopes, "vrf-lab"), ["10.1.0.0/16", "10.0.0.0/8"])
        self.assertEqual(auth.plain_cidrs(scopes, "default"), ["10.0.0.0/8"])
        self.assertEqual(auth.plain_cidrs(scopes, "all"), ["10.1.0.0/16", "10.0.0.0/8"])

    def test_default_vrf_setting_is_readable(self) -> None:
        c = self.conn()
        self.seed_plane(c, PLANE)
        c.execute("UPDATE settings SET value=? WHERE key='default_vrf'", (PLANE,))
        c.commit()
        self.assertEqual(db.thresholds(c)["default_vrf"], PLANE)
        self.assertTrue(next(v for v in extended.list_vrfs(c) if v["name"] == PLANE)["is_default"])
        c.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
