"""纯净模式（IPAM_DEMO_SEED=0）全新安装回归测试。

锁定服务器部署实录中暴露的两个缺陷：
  * db.init_db() 在 prefixes 为空时无条件调用 _seed()，不受开关控制，
    导致纯净模式全新库仍被灌入 17 个前缀 / 2104 个 IP / 14 天快照 / 审计记录；
  * auth.init_auth() 无条件创建演示账号 viewer。

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

from backend import db

REAL_DB_PATH = db.DB_PATH

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
