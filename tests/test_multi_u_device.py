"""多 U 设备回归测试。

覆盖安装后新建设备可占用连续多 U 的完整链路：
  * 范围文本解析（38 / 38-40 / 40~38）与高度下拉联动；
  * 旧库补 u_height 列、存量设备默认 1U；
  * 区间越界 / 区间重叠校验；
  * 统计按实际占用 U 数累加（台数与 U 数分离）；
  * 拖拽保留自动交换（不限定高度相同，按可用连续空间判定）、空间不足拒绝；
  * 前端源码含范围文本 + 高度下拉联动，且不再把 U 位写成 number 输入框。

每个用例独立临时库，不触碰项目根目录的 ipam.db。
运行：.venv/bin/python -m unittest discover -s tests -v
"""
from __future__ import annotations

import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from backend import assets, db

REAL_DB_PATH = db.DB_PATH
ROOT = Path(__file__).resolve().parent.parent


class MultiUDeviceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(setattr, db, "DB_PATH", REAL_DB_PATH)
        self.addCleanup(db.set_current_vrf, "default")
        db.DB_PATH = Path(self.tmp.name) / "ipam.db"
        db.set_current_vrf("default")
        with mock.patch.dict(os.environ, {"IPAM_DEMO_SEED": "1"}):
            db.init_db()

    def connect(self) -> sqlite3.Connection:
        return db.connect()

    def create(self, did: str, **payload) -> dict:
        c = self.connect()
        try:
            body = {"id": did, "name": did, "role": "server", "vrf": "default",
                    "location_id": "LOC-A3-R01", "rack_id": "RACK-A3-01"}
            body.update(payload)
            return assets.create_asset(c, "devices", body, "admin")
        finally:
            c.close()

    def rows(self, rack_id: str = "RACK-A3-01") -> list[tuple]:
        c = self.connect()
        try:
            return list(c.execute(
                "SELECT id,rack_u,u_height FROM asset_devices "
                "WHERE rack_id=? ORDER BY rack_u", (rack_id,)))
        finally:
            c.close()

    # ------------------------------------------------------------ 解析与迁移

    def test_parse_u_range(self) -> None:
        self.assertIsNone(assets.parse_u_range("38"))
        self.assertEqual(assets.parse_u_range("38-40"), (38, 3))
        self.assertEqual(assets.parse_u_range("40~38"), (38, 3))
        self.assertEqual(assets.parse_u_range(" 10 - 12 "), (10, 3))
        self.assertIsNone(assets.parse_u_range("abc"))
        self.assertIsNone(assets.parse_u_range(""))

    def test_old_db_gets_u_height_default_1(self) -> None:
        """模拟旧库：删掉 u_height 列后重启，迁移必须补列且存量设备全为 1U。"""
        c = self.connect()
        try:
            c.execute("ALTER TABLE asset_devices DROP COLUMN u_height")
            c.commit()
            c.close()
        except Exception:
            c.close()
            raise
        db.init_db()
        c = self.connect()
        try:
            cols = [r[1] for r in c.execute("PRAGMA table_info(asset_devices)")]
            self.assertIn("u_height", cols)
            self.assertEqual(
                {r[0] for r in c.execute("SELECT DISTINCT u_height FROM asset_devices")}, {1})
        finally:
            c.close()

    # ------------------------------------------------------------ 新建与校验

    def test_create_with_range_text(self) -> None:
        res = self.create("DEV-M1", rack_u="10-12")
        self.assertEqual((res["rack_u"], res["u_height"]), (10, 3))
        c = self.connect()
        try:
            self.assertEqual(
                c.execute("SELECT rack_u,u_height FROM asset_devices "
                          "WHERE id='DEV-M1'").fetchone()[:], (10, 3))
        finally:
            c.close()

    def test_create_with_height_dropdown(self) -> None:
        res = self.create("DEV-M2", rack_u=10, u_height=4)
        self.assertEqual((res["rack_u"], res["u_height"]), (10, 4))

    def test_default_height_is_1(self) -> None:
        res = self.create("DEV-M3", rack_u=10)
        self.assertEqual(res["u_height"], 1)

    def test_range_overrides_dropdown(self) -> None:
        """范围文本推导的高度优先于下拉值，保证两种输入不会互相打架。"""
        res = self.create("DEV-M4", rack_u="10-12", u_height=1)
        self.assertEqual((res["rack_u"], res["u_height"]), (10, 3))

    def test_out_of_capacity_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "超出机柜"):
            self.create("DEV-M5", rack_u="40-44")  # RACK-A3-01 只有 42U

    def test_invalid_range_rejected(self) -> None:
        with self.assertRaises(ValueError):
            self.create("DEV-M6", rack_u="10-abc")

    def test_height_out_of_bounds_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "占用高度"):
            self.create("DEV-M7", rack_u=10, u_height=0)
        with self.assertRaisesRegex(ValueError, "占用高度"):
            self.create("DEV-M8", rack_u=10, u_height=61)

    def test_overlap_rejected(self) -> None:
        self.create("DEV-M9", rack_u="10-12")
        with self.assertRaisesRegex(ValueError, "重叠"):
            self.create("DEV-M10", rack_u=11)
        with self.assertRaisesRegex(ValueError, "重叠"):
            self.create("DEV-M11", rack_u="12-13")

    # ------------------------------------------------------------ 统计口径

    def test_stats_count_actual_u_not_devices(self) -> None:
        self.create("DEV-S1", rack_u="10-12")   # 3U
        self.create("DEV-S2", rack_u=20)        # 1U
        c = self.connect()
        try:
            listing = assets.list_assets(c, "racks")
            rack = next(r for r in listing["items"] if r["id"] == "RACK-A3-01")
            # 42U 机柜里原本有 4 台种子设备（各 1U），再加 3U + 1U
            self.assertEqual(rack["device_count"], len(rack["occupants"]))
            self.assertEqual(rack["used_u"], sum(o["u_height"] for o in rack["occupants"]))
            self.assertEqual(rack["free_u"], rack["units"] - rack["used_u"])

            detail = assets.rack_detail(c, "RACK-A3-01")
            # 4 台种子设备各 1U，加 3U + 1U：台数 6、占用 8U，差值来自那台 3U
            self.assertEqual(detail["stats"]["used"], detail["stats"]["device_count"] + 2)
            self.assertEqual(detail["stats"]["free"],
                             detail["stats"]["units"] - detail["stats"]["used"])
            self.assertEqual(detail["stats"]["device_count"], len(detail["devices"]))

            loc = assets.location_detail(c, "LOC-A3-R01")
            self.assertEqual(loc["stats"]["used_u"],
                             sum(r["used_u"] for r in loc["racks"]))
            self.assertEqual(loc["stats"]["device_count"],
                             sum(r["device_count"] for r in loc["racks"]))
        finally:
            c.close()

    def test_u_interval_and_free_segments(self) -> None:
        self.assertEqual(assets.u_interval({"rack_u": 10, "u_height": 3}), (10, 12))
        self.assertIsNone(assets.u_interval({"rack_u": None, "u_height": 3}))
        self.assertEqual(assets._free_segments(6, [(1, 1), (3, 6)]), [(2, 2)])

    # ------------------------------------------------------------ 拖拽 / 自动交换

    def test_classic_1u_swap_is_exact(self) -> None:
        c = self.connect()
        try:
            res = assets.move_device(c, "RACK-A3-01", "DEV-0001", 38, "admin")
        finally:
            c.close()
        self.assertEqual(res["action"], "swap")
        pos = dict((r[0], r[1]) for r in self.rows())
        self.assertEqual(pos["DEV-0001"], 38)
        self.assertEqual(pos["DEV-0002"], 40)  # 精确落回原起始 U

    def test_multi_u_swap_uses_available_space(self) -> None:
        """6U 小机柜：4U 设备与两台 1U 设备按可用空间交换，不要求高度相同。"""
        c = self.connect()
        try:
            now = db.now()
            c.execute("INSERT INTO asset_racks(id,name,location_id,units,power_kw,status,note,created_at) "
                      "VALUES('R-SMALL','小机柜','LOC-A3-R01',6,2,'active','',?)", (now,))
            for did, u, h in [("D-BIG", 3, 4), ("D-S1", 1, 1), ("D-S2", 2, 1)]:
                c.execute("INSERT INTO asset_devices"
                          "(id,name,vendor,model,role,mgmt_ip,location_id,rack_id,rack_u,u_height,"
                          "status,vrf,owner,note,created_at) "
                          "VALUES(?,?,'','','server','','LOC-A3-R01','R-SMALL',?,?,'online',"
                          "'default','','',?)", (did, did, u, h, now))
            c.commit()
            res = assets.move_device(c, "R-SMALL", "D-BIG", 1, "admin")
            self.assertEqual(res["action"], "swap")
            self.assertEqual(len(res["moved"]), 2)
            layout = self.rows("R-SMALL")
            occupied: list[tuple[int, int]] = sorted(
                (u, u + h - 1) for _, u, h in layout)
            self.assertEqual(sum(h for _, _, h in layout), 6)
            for (s1, e1), (s2, e2) in zip(occupied, occupied[1:]):
                self.assertLess(e1, s2, f"区间重叠：{occupied}")
        finally:
            c.close()

    def test_no_space_rejects_and_rolls_back(self) -> None:
        """满柜改高度无处腾挪时整体回滚，不留下半套落位。"""
        c = self.connect()
        try:
            now = db.now()
            c.execute("INSERT INTO asset_racks(id,name,location_id,units,power_kw,status,note,created_at) "
                      "VALUES('R-FULL','满柜','LOC-A3-R01',6,2,'active','',?)", (now,))
            for i in range(1, 7):
                c.execute("INSERT INTO asset_devices"
                          "(id,name,vendor,model,role,mgmt_ip,location_id,rack_id,rack_u,u_height,"
                          "status,vrf,owner,note,created_at) "
                          "VALUES(?,?,'','','server','','LOC-A3-R01','R-FULL',?,1,'online',"
                          "'default','','',?)", ("D-%d" % i, "满%d" % i, i, now))
            c.commit()
            with self.assertRaisesRegex(ValueError, "空间不足"):
                assets.move_device(c, "R-FULL", "D-1", 1, "admin", u_height=2)
            self.assertEqual(
                [r[2] for r in self.rows("R-FULL")], [1, 1, 1, 1, 1, 1])
        finally:
            c.close()

    def test_range_text_move(self) -> None:
        c = self.connect()
        try:
            res = assets.move_device(c, "RACK-A3-02", "DEV-0005", "3-5", "admin")
        finally:
            c.close()
        self.assertEqual((res["rack_u"], res["u_height"]), (3, 3))
        self.assertEqual(
            [r for r in self.rows("RACK-A3-02") if r[0] == "DEV-0005"][0][1:], (3, 3))

    def test_move_height_only(self) -> None:
        """表单只改高度、不改起始位：u_height 参数生效且区间不重叠。"""
        c = self.connect()
        try:
            res = assets.move_device(c, "RACK-A3-02", "DEV-0006", 30, "admin", u_height=2)
        finally:
            c.close()
        self.assertEqual((res["rack_u"], res["u_height"]), (30, 2))
        row = [r for r in self.rows("RACK-A3-02") if r[0] == "DEV-0006"][0]
        self.assertEqual(row[1:], (30, 2))

    # ------------------------------------------------------------ 前端契约

    def test_frontend_uses_range_text_and_height_dropdown(self) -> None:
        view = (ROOT / "frontend/src/views/AssetView.tsx").read_text()
        rack = (ROOT / "frontend/src/views/RackDetailView.tsx").read_text()
        loc = (ROOT / "frontend/src/views/LocationDetailView.tsx").read_text()
        self.assertIn("type: 'urange'", view)
        self.assertIn("key: 'u_height'", view)
        self.assertIn("linkUField", view)
        self.assertIn("uDisplay(occ)", rack)
        self.assertIn("gridRow: `span ${spanH}`", rack)
        self.assertIn("u_height", loc)
        self.assertNotIn("{ key: 'rack_u', label: '机柜 U 位', type: 'number'", view)

        # 回归：U 位文本在逐字符输入过程中绝不能被归一化改写。
        # 早期版本把中间态 '42-4' 改写成 '4-42'，用户再输入 '4' 会变成 '4-424'；
        # '38-4' 被改写成 '4-38'，再输入 '0' 会变成 '4-380'，范围根本无法手动填。
        link = view.split("export function linkUField", 1)[1].split("/**", 1)[0]
        self.assertIn("rack_u: value", link)
        self.assertNotIn("rack_u: `${r.start}", link)
        # 高度 >12U（由范围文本推导）时下拉必须补展示项，不能显示空白
        self.assertIn("uHeightExtraOption", view)
        self.assertIn("uHeightExtraOption", rack)
        # 前端高度上限与后端 assets.MAX_U_HEIGHT 一致
        self.assertIn("MAX_U_HEIGHT = 60", view)
        self.assertIn("MAX_U_HEIGHT = 60", (ROOT / "backend/assets.py").read_text())


if __name__ == "__main__":
    unittest.main(verbosity=2)
