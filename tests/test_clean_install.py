"""纯净模式（IPAM_DEMO_SEED=0）全新安装回归测试 + 默认地址平面视图。

锁定服务器部署实录中暴露的两个缺陷：
  * db.init_db() 在 prefixes 为空时无条件调用 _seed()，不受开关控制，
    导致纯净模式全新库仍被灌入 17 个前缀 / 2104 个 IP / 14 天快照 / 审计记录；
  * auth.init_auth() 无条件创建演示账号 viewer。

并锁定「安装后默认显示全部 VRF · 跨平面对比」：出厂 settings.default_vrf=all、
旧库一次性迁移且幂等、all 不会被补建成真实地址平面、内置主平面仍受删除保护。

只用标准库 unittest，每个用例使用独立临时库，不触碰项目根目录的 ipam.db。
运行：.venv/bin/python -m unittest discover -s tests -v
"""
from __future__ import annotations

import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from backend import db, extended

REAL_DB_PATH = db.DB_PATH
ROOT = Path(__file__).resolve().parents[1]
LEGACY_DEFAULT_NOTE = "登录后默认进入的 VRF 地址平面（用户手动切换后以手动选择为准）"

BUSINESS_TABLES = (
    "ip_addresses", "asset_devices", "asset_links", "asset_locations", "asset_racks",
    "audit_logs", "discovery_records", "reconciliation_diffs", "sessions", "sso_states",
    "tickets", "utilization_snapshots", "webhook_events",
)
CONFIG_TABLES = (
    "vrfs", "settings", "auth_sources", "integration_sources", "asset_device_roles",
)
CLEAN_ROOTS = {
    ("default", "10.0.0.0/8"),
    ("vrf-lab", "172.16.0.0/12"),
    ("vrf-prod", "192.168.0.0/16"),
}


class CleanInstallTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        db.DB_PATH = Path(self.tmp.name) / "ipam.db"
        db.set_current_vrf("default")

    def tearDown(self) -> None:
        db.set_current_vrf("default")
        db.DB_PATH = REAL_DB_PATH
        self.tmp.cleanup()

    def init(self, mode: str) -> None:
        """在指定种子模式下执行一次真实的 init_db()（等价于服务启动一次）。"""
        with mock.patch.dict(os.environ, {"IPAM_DEMO_SEED": mode}):
            db.init_db()

    def snapshot(self) -> tuple[dict, str]:
        c = sqlite3.connect(db.DB_PATH)
        try:
            tables = [r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")]
            counts = {t: c.execute('SELECT COUNT(*) FROM "%s"' % t).fetchone()[0] for t in tables}
            return counts, c.execute("PRAGMA integrity_check").fetchone()[0]
        finally:
            c.close()

    def business_total(self, counts: dict) -> int:
        return sum(counts.get(t, 0) for t in BUSINESS_TABLES)

    def open(self) -> sqlite3.Connection:
        c = sqlite3.connect(db.DB_PATH)
        c.row_factory = sqlite3.Row
        return c

    def default_vrf(self, c: sqlite3.Connection) -> tuple[str, str]:
        row = c.execute("SELECT value,note FROM settings WHERE key='default_vrf'").fetchone()
        return row["value"], row["note"]

    def test_clean_install_only_roots_and_admin(self) -> None:
        self.init("0")
        counts, integrity = self.snapshot()
        self.assertEqual(integrity, "ok")
        self.assertEqual(self.business_total(counts), 0, "纯净库不应有任何业务记录")
        self.assertEqual(counts["prefixes"], 3)
        self.assertEqual(counts["users"], 1)
        for table in CONFIG_TABLES:
            self.assertGreater(counts.get(table, 0), 0, f"内置配置表 {table} 不应为空")
        c = sqlite3.connect(db.DB_PATH)
        try:
            roots = c.execute("SELECT vrf,cidr,kind,parent_cidr FROM prefixes").fetchall()
            self.assertEqual({(r[0], r[1]) for r in roots}, CLEAN_ROOTS)
            self.assertTrue(all(r[2] == "root" and r[3] is None for r in roots))
            self.assertEqual([r[0] for r in c.execute("SELECT username FROM users")], ["admin"])
        finally:
            c.close()

    def test_clean_install_is_idempotent(self) -> None:
        """重复启动（迁移 + 种子）不得增行或改写任何表。"""
        self.init("0")
        before, _ = self.snapshot()
        self.init("0")
        self.init("0")
        after, integrity = self.snapshot()
        self.assertEqual(after, before)
        self.assertEqual(integrity, "ok")

    def test_clean_restart_after_wipe_does_not_backfill(self) -> None:
        """模拟封版清库：删光业务数据后用纯净模式重启，不得补灌演示数据。"""
        self.init("0")
        c = sqlite3.connect(db.DB_PATH)
        try:
            for table in BUSINESS_TABLES:
                c.execute('DELETE FROM "%s"' % table)
            c.commit()
        finally:
            c.close()
        self.init("0")
        counts, integrity = self.snapshot()
        self.assertEqual(self.business_total(counts), 0)
        self.assertEqual(counts["prefixes"], 3)
        self.assertEqual(counts["users"], 1)
        self.assertEqual(integrity, "ok")

    def test_clean_roots_respect_vrf_isolation(self) -> None:
        """三段根分属三个平面；'all' 汇总视图可读到全部 3 条。"""
        self.init("0")
        c = sqlite3.connect(db.DB_PATH)
        try:
            for vrf, cidr in CLEAN_ROOTS:
                cond, args = db.vrf_sql(vrf)
                rows = c.execute("SELECT cidr FROM prefixes" + cond, args).fetchall()
                self.assertEqual([r[0] for r in rows], [cidr])
            cond, args = db.vrf_sql(db.ALL_VRFS)
            self.assertEqual(
                c.execute("SELECT COUNT(*) FROM prefixes" + cond, args).fetchone()[0], 3)
        finally:
            c.close()

    def test_demo_install_keeps_original_behavior(self) -> None:
        """演示模式保持向后兼容：地址 / 快照 / 设备与 viewer 账号齐全。"""
        self.init("1")
        counts, integrity = self.snapshot()
        self.assertEqual(integrity, "ok")
        self.assertGreater(counts["prefixes"], 3)
        self.assertGreater(counts["ip_addresses"], 0)
        self.assertGreater(counts["utilization_snapshots"], 0)
        self.assertGreater(counts["asset_devices"], 0)
        c = sqlite3.connect(db.DB_PATH)
        try:
            self.assertEqual(
                {r[0] for r in c.execute("SELECT username FROM users")}, {"admin", "viewer"})
        finally:
            c.close()

    # ---- 安装后的默认视图：全部 VRF · 跨平面对比 ------------------------------

    def test_clean_install_defaults_to_all_view(self) -> None:
        """全新纯净库出厂即进入只读跨平面对比视图，且 all 不是真实平面。"""
        self.init("0")
        c = self.open()
        try:
            value, note = self.default_vrf(c)
            self.assertEqual(value, db.ALL_VRFS)
            self.assertEqual(db.thresholds(c)["default_vrf"], db.ALL_VRFS)
            self.assertEqual(extended.list_settings(c)["thresholds"]["default_vrf"], db.ALL_VRFS)
            self.assertIn("全部 VRF", note)
            self.assertEqual(
                [r[0] for r in c.execute("SELECT name FROM vrfs ORDER BY name")],
                ["default", "vrf-lab", "vrf-prod"])
        finally:
            c.close()

    def test_demo_install_defaults_to_all_view(self) -> None:
        """演示模式同样默认进汇总视图，不因种子模式不同而分叉。"""
        self.init("1")
        c = self.open()
        try:
            self.assertEqual(self.default_vrf(c)[0], db.ALL_VRFS)
        finally:
            c.close()

    def test_thresholds_fallback_is_all_view(self) -> None:
        """settings 缺行时（老库 / 空表）兜底也必须是 all，不能闪回 default。"""
        c = sqlite3.connect(":memory:")
        c.row_factory = sqlite3.Row
        try:
            c.execute("CREATE TABLE settings(key TEXT, value TEXT)")
            self.assertEqual(db.thresholds(c)["default_vrf"], db.ALL_VRFS)
        finally:
            c.close()

    def test_legacy_default_vrf_migrates_once_and_is_idempotent(self) -> None:
        """历史库 value=default + 内置旧文案 → 一次性翻转为 all，重复启动不改回。"""
        self.init("0")
        c = self.open()
        try:
            c.execute("UPDATE settings SET value='default', note=? WHERE key='default_vrf'",
                      (LEGACY_DEFAULT_NOTE,))
            c.commit()
        finally:
            c.close()
        self.init("0")
        self.init("0")
        c = self.open()
        try:
            self.assertEqual(self.default_vrf(c), (db.ALL_VRFS, extended.DEFAULT_VRF_NOTE))
        finally:
            c.close()

    def test_admin_custom_default_vrf_is_not_overwritten(self) -> None:
        """管理员主动改过的值 / 自定义说明，重启迁移不得覆盖。"""
        self.init("0")
        c = self.open()
        try:
            c.execute("UPDATE settings SET value='vrf-prod' WHERE key='default_vrf'")
            c.commit()
        finally:
            c.close()
        self.init("0")
        c = self.open()
        try:
            self.assertEqual(self.default_vrf(c)[0], "vrf-prod")
            self.assertEqual(extended.protected_vrf(c), "vrf-prod")
            c.execute("UPDATE settings SET value='default', note='我的自定义说明' "
                      "WHERE key='default_vrf'")
            c.commit()
        finally:
            c.close()
        self.init("0")
        c = self.open()
        try:
            self.assertEqual(self.default_vrf(c), ("default", "我的自定义说明"))
        finally:
            c.close()

    def test_all_view_is_not_a_real_plane(self) -> None:
        """normalize_vrf_refs 不能把视图标识 all 补建进 vrfs 字典。"""
        self.init("0")
        c = self.open()
        try:
            self.assertEqual(extended.normalize_vrf_refs(c), 0)
            c.commit()
            self.assertIsNone(
                c.execute("SELECT 1 FROM vrfs WHERE name=?", (db.ALL_VRFS,)).fetchone())
        finally:
            c.close()

    def test_phantom_all_plane_is_removed_on_restart(self) -> None:
        """历史库里误建的 all 空平面，服务重启时自动清掉，顶栏不出现重复项。"""
        self.init("0")
        c = self.open()
        try:
            c.execute("INSERT INTO vrfs(name,tenant,description,created_at) VALUES(?,?,?,?)",
                      (db.ALL_VRFS, "历史数据", "误建的幽灵平面", db.now()))
            c.commit()
            self.assertIsNotNone(
                c.execute("SELECT 1 FROM vrfs WHERE name=?", (db.ALL_VRFS,)).fetchone())
        finally:
            c.close()
        self.init("0")
        c = self.open()
        try:
            self.assertEqual(
                [r[0] for r in c.execute("SELECT name FROM vrfs ORDER BY name")],
                ["default", "vrf-lab", "vrf-prod"])
            self.assertEqual(extended.drop_phantom_all_plane(c), 0)  # 幂等
        finally:
            c.close()

    def test_phantom_all_plane_with_data_is_kept(self) -> None:
        """all 平面若真有业务引用，自愈必须原样保留，不丢数据。"""
        self.init("0")
        c = self.open()
        try:
            c.execute("INSERT INTO vrfs(name,tenant,description,created_at) VALUES(?,?,?,?)",
                      (db.ALL_VRFS, "历史数据", "误建的幽灵平面", db.now()))
            c.execute("UPDATE prefixes SET vrf=? WHERE cidr='10.0.0.0/8'", (db.ALL_VRFS,))
            c.commit()
            self.assertEqual(extended.drop_phantom_all_plane(c), 0)
            self.assertIsNotNone(
                c.execute("SELECT 1 FROM vrfs WHERE name=?", (db.ALL_VRFS,)).fetchone())
        finally:
            c.close()

    def test_builtin_default_plane_still_protected(self) -> None:
        """默认视图为 all 时，内置主平面 default 仍不可删除。"""
        self.init("0")
        c = self.open()
        try:
            with self.assertRaises(ValueError):
                extended.delete_vrf(c, "default")
            flags = {v["name"]: v["is_default"] for v in extended.list_vrfs(c)}
            self.assertTrue(flags["default"])
            self.assertFalse(flags["vrf-prod"])
        finally:
            c.close()

    def test_settings_can_switch_default_to_concrete_plane(self) -> None:
        """想登录即写入时，可在系统设置把默认视图改回具体平面。"""
        self.init("0")
        c = self.open()
        try:
            res = extended.update_settings(c, {"default_vrf": "vrf-lab"})
            self.assertEqual(res["thresholds"]["default_vrf"], "vrf-lab")
            self.assertEqual(extended.protected_vrf(c), "vrf-lab")
        finally:
            c.close()

    def test_frontend_defaults_follow_all_view(self) -> None:
        """前端各层兜底必须与后端出厂值一致，避免登录瞬间先闪 default。"""
        src = ROOT / "frontend" / "src"
        api = (src / "api.ts").read_text(encoding="utf-8")
        auth = (src / "auth.tsx").read_text(encoding="utf-8")
        page = (src / "views" / "VrfPageView.tsx").read_text(encoding="utf-8")
        self.assertIn("let apiVrf = 'all'", api)
        self.assertIn("vrf || 'all'", api)
        self.assertIn("saved || 'all'", auth)
        self.assertIn("res.default_vrf || 'all'", auth)
        self.assertIn("useState('all')", auth)
        self.assertIn("?? 'all'", page)
