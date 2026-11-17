"""自定义网络拓扑回归测试。

覆盖：自动 / 手动根节点、BFS 树形分层、环路与孤立设备、坐标持久化与自愈、
CRUD、单 VRF 平面约束和「全部 VRF」只读保护。每个用例独立临时库，
不触碰项目根目录的 ipam.db。
运行：.venv/bin/python -m unittest discover -s tests -v
"""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from backend import db, topology

REAL_DB_PATH = db.DB_PATH


def link(a: str, b: str, lid: str = "") -> dict:
    return {"id": lid or f"{a}-{b}", "local_device_id": a, "remote_device_id": b}


class TopologyTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(setattr, db, "DB_PATH", REAL_DB_PATH)
        self.addCleanup(db.set_current_vrf, "default")
        db.DB_PATH = Path(self.tmp.name) / "ipam.db"
        db.set_current_vrf("default")
        with mock.patch.dict(os.environ, {"IPAM_DEMO_SEED": "1"}):
            db.init_db()

    def connect(self):
        return db.connect()

    def devices(self, vrf: str = "default") -> list[str]:
        c = self.connect()
        try:
            return [r[0] for r in c.execute(
                "SELECT id FROM asset_devices WHERE vrf=? ORDER BY id", (vrf,))]
        finally:
            c.close()

    def make(self, **kwargs) -> str:
        c = self.connect()
        try:
            payload = {"name": "测试拓扑", "vrf": "default",
                       "device_ids": self.devices(), "description": ""}
            payload.update(kwargs)
            return topology.create_topology(c, payload, "admin")["id"]
        finally:
            c.close()

    # ---------------------------------------------------------------- 布局算法

    def test_layout_picks_highest_degree_root(self) -> None:
        links = [link("edge", "core"), link("core", "agg"),
                 link("core", "fw"), link("agg", "acc")]
        lay = topology.layout(["edge", "core", "agg", "fw", "acc"], links)
        self.assertEqual(lay["root"], "core")
        self.assertEqual(lay["depth"]["core"], 0)
        self.assertEqual(lay["depth"]["acc"], 2)
        self.assertEqual(len(lay["levels"]), 3)
        self.assertEqual(lay["parent"]["agg"], "core")
        self.assertEqual(len(lay["coords"]), 5)

    def test_layout_manual_root(self) -> None:
        links = [link("edge", "core"), link("core", "agg"), link("agg", "acc")]
        lay = topology.layout(["edge", "core", "agg", "acc"], links, root="acc")
        self.assertEqual(lay["root"], "acc")
        self.assertEqual(lay["depth"]["core"], 2)
        self.assertIsNone(lay["parent"]["acc"])

    def test_layout_cycle_keeps_spanning_tree(self) -> None:
        links = [link("a", "b"), link("b", "c"), link("c", "a")]
        lay = topology.layout(["a", "b", "c"], links)
        self.assertEqual(len(lay["tree_edges"]), 2)
        self.assertEqual(len(lay["levels"]), 2)
        self.assertEqual(sum(len(x) for x in lay["levels"]), 3)

    def test_layout_isolated_devices_get_extra_row(self) -> None:
        lay = topology.layout(["a", "b", "solo"], [link("a", "b")])
        self.assertEqual(lay["isolated"], ["solo"])
        # 根层 / 子节点层 / 孤立设备单独一行
        self.assertEqual(len(lay["levels"]), 3)
        self.assertEqual(lay["depth"]["solo"], 2)
        self.assertIsNone(lay["parent"]["solo"])

    def test_layout_empty_is_safe(self) -> None:
        lay = topology.layout([], [])
        self.assertIsNone(lay["root"])
        self.assertEqual(lay["coords"], {})

    # ---------------------------------------------------------------- 表与列表

    def test_schema_tables_exist_and_start_empty(self) -> None:
        c = self.connect()
        try:
            names = {r[0] for r in c.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertIn("topologies", names)
            self.assertIn("topology_nodes", names)
            self.assertEqual(c.execute("SELECT COUNT(*) FROM topologies").fetchone()[0], 0)
            self.assertEqual(c.execute("SELECT COUNT(*) FROM topology_nodes").fetchone()[0], 0)
        finally:
            c.close()

    def test_list_filters_by_plane(self) -> None:
        self.make(name="默认平面拓扑")
        default_ids = self.devices()
        lab_ids = self.devices("vrf-lab")
        self.assertTrue(default_ids)
        self.assertTrue(lab_ids)
        db.set_current_vrf("vrf-lab")
        c = self.connect()
        try:
            topology.create_topology(c, {"name": "实验室拓扑", "vrf": "vrf-lab",
                                         "device_ids": lab_ids}, "admin")
        finally:
            c.close()
        db.set_current_vrf("default")
        c = self.connect()
        try:
            names = [i["name"] for i in topology.list_topologies(c)["items"]]
        finally:
            c.close()
        self.assertEqual(names, ["默认平面拓扑"])
        db.set_current_vrf(db.ALL_VRFS)
        c = self.connect()
        try:
            names = {i["name"] for i in topology.list_topologies(c)["items"]}
        finally:
            c.close()
        self.assertEqual(names, {"默认平面拓扑", "实验室拓扑"})

    # ---------------------------------------------------------------- CRUD

    def test_create_update_duplicate_delete(self) -> None:
        topo_id = self.make(name="园区核心", description="核心层拓扑")
        c = self.connect()
        try:
            detail = topology.get_topology(c, topo_id)
            self.assertEqual(detail["name"], "园区核心")
            self.assertEqual(detail["root_mode"], "auto")
            self.assertGreater(len(detail["nodes"]), 0)
            self.assertGreater(len(detail["edges"]), 0)
            self.assertEqual(detail["stats"]["devices"], len(detail["nodes"]))
            self.assertTrue(all("edge_role" in e for e in detail["edges"]))

            keep = [n["id"] for n in detail["nodes"][:3]]
            topology.update_topology(c, topo_id, {"name": "园区核心 v2",
                                                  "device_ids": keep}, "admin")
            detail = topology.get_topology(c, topo_id)
            self.assertEqual(detail["name"], "园区核心 v2")
            self.assertEqual({n["id"] for n in detail["nodes"]}, set(keep))

            copy = topology.duplicate_topology(c, topo_id, "admin")
            self.assertNotEqual(copy["id"], topo_id)
            self.assertEqual(
                c.execute("SELECT COUNT(*) FROM topology_nodes WHERE topology_id=?",
                          (copy["id"],)).fetchone()[0], len(keep))

            topology.delete_topology(c, topo_id, "admin")
            self.assertIsNone(c.execute("SELECT 1 FROM topologies WHERE id=?",
                                        (topo_id,)).fetchone())
            self.assertEqual(
                c.execute("SELECT COUNT(*) FROM topology_nodes WHERE topology_id=?",
                          (topo_id,)).fetchone()[0], 0)
        finally:
            c.close()

    def test_manual_root_is_persisted_and_can_be_reset(self) -> None:
        ids = self.devices()
        topo_id = self.make(root_mode="manual", root_device_id=ids[-1])
        c = self.connect()
        try:
            detail = topology.get_topology(c, topo_id)
            self.assertEqual(detail["resolved_root"], ids[-1])
            self.assertTrue(next(n for n in detail["nodes"]
                                 if n["id"] == ids[-1])["is_root"])
            topology.update_topology(c, topo_id, {"root_mode": "auto",
                                                  "root_device_id": None}, "admin")
            detail = topology.get_topology(c, topo_id)
            self.assertEqual(detail["root_mode"], "auto")
            self.assertIsNone(detail["root_device_id"])
        finally:
            c.close()

    # ---------------------------------------------------------------- 坐标

    def test_saved_coordinates_survive_link_changes(self) -> None:
        topo_id = self.make()
        c = self.connect()
        try:
            detail = topology.get_topology(c, topo_id)
            target = detail["nodes"][0]["id"]
            topology.save_layout(c, topo_id,
                                 [{"device_id": target, "x": 321.5, "y": 456.5}], "admin")
            # 链路台账变更后重新打开：固定坐标不动，其余节点跟随自动布局
            c.execute("INSERT INTO asset_links(id,name,local_device_id,local_port,"
                      "remote_device_id,remote_port,kind,bandwidth_gbps,vlan,status,note,"
                      "created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                      ("L-EXTRA", "新增链路", detail["nodes"][0]["id"], "Gi0/9",
                       detail["nodes"][-1]["id"], "Gi0/9", "trunk", 10, "", "up", "",
                       db.now(), None))
            c.commit()
            detail = topology.get_topology(c, topo_id)
            node = next(n for n in detail["nodes"] if n["id"] == target)
            self.assertEqual((node["x"], node["y"]), (321.5, 456.5))
            self.assertEqual(node["pinned"], 1)
            self.assertEqual(detail["stats"]["pinned"], 1)
            self.assertNotEqual((node["auto_x"], node["auto_y"]), (321.5, 456.5))

            topology.relayout_topology(c, topo_id, "admin")
            detail = topology.get_topology(c, topo_id)
            node = next(n for n in detail["nodes"] if n["id"] == target)
            self.assertEqual(node["pinned"], 0)
            self.assertEqual(detail["stats"]["pinned"], 0)
        finally:
            c.close()

    def test_layout_rejects_invalid_coordinates(self) -> None:
        topo_id = self.make()
        c = self.connect()
        try:
            with self.assertRaises(ValueError):
                topology.save_layout(c, topo_id,
                                     [{"device_id": "x", "x": float("nan"), "y": 1}], "admin")
        finally:
            c.close()

    # ---------------------------------------------------------------- 平面约束

    def test_single_plane_constraint(self) -> None:
        c = self.connect()
        try:
            with self.assertRaises(ValueError):
                topology.create_topology(c, {"name": "跨平面", "vrf": db.ALL_VRFS,
                                             "device_ids": []}, "admin")
            with self.assertRaises(ValueError):
                topology.create_topology(c, {"name": "不存在的平面", "vrf": "vrf-x",
                                             "device_ids": []}, "admin")
            lab_ids = self.devices("vrf-lab")
            self.assertTrue(lab_ids)
            with self.assertRaises(ValueError):
                topology.create_topology(c, {"name": "设备跨平面", "vrf": "default",
                                             "device_ids": lab_ids}, "admin")
        finally:
            c.close()

    def test_all_view_is_readonly_for_existing_topology(self) -> None:
        topo_id = self.make()
        db.set_current_vrf(db.ALL_VRFS)
        c = self.connect()
        try:
            detail = topology.get_topology(c, topo_id)
            self.assertFalse(detail["writable"])
            for call in (
                lambda: topology.update_topology(c, topo_id, {"name": "改名"}, "admin"),
                lambda: topology.save_layout(c, topo_id, [], "admin"),
                lambda: topology.relayout_topology(c, topo_id, "admin"),
                lambda: topology.delete_topology(c, topo_id, "admin"),
            ):
                with self.assertRaises(ValueError):
                    call()
        finally:
            c.close()

    def test_writing_other_plane_is_rejected(self) -> None:
        topo_id = self.make()
        db.set_current_vrf("vrf-prod")
        c = self.connect()
        try:
            with self.assertRaises(ValueError):
                topology.save_layout(c, topo_id, [], "admin")
        finally:
            c.close()

    def test_create_in_all_view_is_allowed_when_plane_is_explicit(self) -> None:
        db.set_current_vrf(db.ALL_VRFS)
        c = self.connect()
        try:
            res = topology.create_topology(c, {"name": "显式平面", "vrf": "default",
                                               "device_ids": self.devices()[:2]}, "admin")
            self.assertTrue(res["id"].startswith("topo-"))
            row = c.execute("SELECT vrf FROM topologies WHERE id=?", (res["id"],)).fetchone()
            self.assertEqual(row[0], "default")
        finally:
            c.close()

    def test_catalog_returns_only_requested_plane(self) -> None:
        cat = None
        c = self.connect()
        try:
            cat = topology.catalog(c, "vrf-lab")
        finally:
            c.close()
        self.assertEqual(cat["vrf"], "vrf-lab")
        self.assertTrue(all(d["vrf"] == "vrf-lab" for d in cat["items"]))
        self.assertEqual(len(cat["items"]), len(self.devices("vrf-lab")))


if __name__ == "__main__":
    unittest.main(verbosity=2)
