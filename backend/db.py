"""数据层：SQLite 持久化 + 种子数据。

只存「已占用 / 预留 / 待回收 / 冲突」的地址行，可用地址由前缀区间推导，
不预生成空行。所有分配与状态流转都在 BEGIN IMMEDIATE 事务内完成。

VRF 真隔离：每个 VRF 是一张独立地址平面，(vrf, cidr) / (vrf, addr) 才是唯一键。
当前请求的 VRF 由 X-IPAM-VRF 头注入 ContextVar，业务 SQL 统一用 vrf_sql() 拼接条件；
'vrf=all' 为跨平面汇总视图，仅供字典、报表与对比类页面使用。
"""
from __future__ import annotations

import contextvars
import datetime
import os
import sqlite3
from pathlib import Path

from . import domain

DB_PATH = Path(__file__).resolve().parent.parent / "ipam.db"


def demo_seed_enabled() -> bool:
    """是否灌入演示业务数据（设备 / 机柜 / 链路 / 位置 / 工单 / 发现 / 对账样例）。

    默认开启，保持原有开发体验。生产部署设置 IPAM_DEMO_SEED=0 后，
    已清空的封版库在服务每次启动时都不会被幂等种子重新灌满。
    必需的配置字典（VRF / 设置 / 集成源 / 角色 / 认证源 / 页面文案）不受影响。
    """
    return os.environ.get("IPAM_DEMO_SEED", "1") != "0"

ALL_VRFS = "all"
_VRF_CTX: contextvars.ContextVar[str] = contextvars.ContextVar("ipam_vrf", default="default")


def set_current_vrf(vrf: str | None) -> str:
    """由 HTTP 中间件在请求入口设置；非法值回落 default。"""
    value = (vrf or "default").strip() or "default"
    _VRF_CTX.set(value)
    return value


def current_vrf() -> str:
    return _VRF_CTX.get() or "default"


def vrf_sql(vrf: str | None = None, col: str = "vrf", joiner: str = "WHERE") -> tuple[str, list]:
    """生成 VRF 过滤片段；'all' 表示不做过滤（跨平面汇总）。

    用法：cond, args = vrf_sql()  /  vrf_sql(joiner="AND")
    """
    value = current_vrf() if vrf is None else (vrf or "default")
    if value == ALL_VRFS:
        return "", []
    return f" {joiner} {col}=?", [value]

SCHEMA = """
-- 真隔离：同一 CIDR / IP 可在不同 VRF 内重复，唯一键必须是 (vrf, ...)
CREATE TABLE IF NOT EXISTS prefixes (
  vrf TEXT NOT NULL DEFAULT 'default',
  cidr TEXT NOT NULL,
  parent_cidr TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  site TEXT,
  vlan INTEGER,
  description TEXT NOT NULL DEFAULT '',
  updated_at TEXT,
  PRIMARY KEY (vrf, cidr)
);
CREATE INDEX IF NOT EXISTS idx_prefix_vrf ON prefixes(vrf);
CREATE INDEX IF NOT EXISTS idx_prefix_parent ON prefixes(vrf, parent_cidr);
CREATE TABLE IF NOT EXISTS ip_addresses (
  vrf TEXT NOT NULL DEFAULT 'default',
  addr TEXT NOT NULL,
  addr_int INTEGER NOT NULL,
  prefix_cidr TEXT NOT NULL,
  status TEXT NOT NULL,
  hostname TEXT,
  business TEXT,
  owner TEXT,
  vlan INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (vrf, addr),
  UNIQUE (vrf, addr_int)
);
CREATE INDEX IF NOT EXISTS idx_ip_prefix ON ip_addresses(vrf, prefix_cidr);
CREATE INDEX IF NOT EXISTS idx_ip_status ON ip_addresses(vrf, status);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  action TEXT NOT NULL,
  addr TEXT,
  detail TEXT,
  vrf TEXT NOT NULL DEFAULT 'default'
);
CREATE TABLE IF NOT EXISTS utilization_snapshots (
  vrf TEXT NOT NULL DEFAULT 'default',
  day TEXT NOT NULL,
  occupied INTEGER NOT NULL,
  util REAL NOT NULL,
  PRIMARY KEY (vrf, day)
);

-- 第二版：治理与对账 / 工单 / 集成 / 系统设置（04 集成与同步层的本地落地）
CREATE TABLE IF NOT EXISTS vrfs (
  name TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  -- NULL 表示沿用系统全局阈值；否则该地址平面使用自己的预警 / 告警线
  warn_threshold REAL,
  crit_threshold REAL
);
CREATE TABLE IF NOT EXISTS integration_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  endpoint TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_sync TEXT,
  sync_count INTEGER NOT NULL DEFAULT 0,
  note TEXT
);
CREATE TABLE IF NOT EXISTS discovery_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  addr TEXT NOT NULL,
  prefix_cidr TEXT NOT NULL,
  vrf TEXT NOT NULL DEFAULT 'default',
  mac TEXT,
  hostname TEXT,
  source TEXT NOT NULL,
  signal TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reconciliation_diffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  addr TEXT NOT NULL,
  prefix_cidr TEXT NOT NULL,
  vrf TEXT NOT NULL DEFAULT 'default',
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  source TEXT NOT NULL,
  detail TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  discovered_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT
);
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  applicant TEXT NOT NULL,
  business TEXT,
  prefix_cidr TEXT,
  addr TEXT,
  vrf TEXT NOT NULL DEFAULT 'default',
  count INTEGER NOT NULL DEFAULT 1,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  approver TEXT,
  decision_note TEXT,
  result TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  label TEXT NOT NULL,
  note TEXT
);
CREATE TABLE IF NOT EXISTS webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  event TEXT NOT NULL,
  target TEXT,
  payload TEXT,
  vrf TEXT NOT NULL DEFAULT 'default'
);
-- 第三版：可自定义编辑的页面内容（按 page_key 隔离，内容以 JSON 保存）
CREATE TABLE IF NOT EXISTS custom_pages (
  page_key TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  updated_at TEXT,
  updated_by TEXT
);
-- 第四版：01 接入层认证与授权（本地 / LDAP / SSO）
CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'viewer',
  source TEXT NOT NULL DEFAULT 'local',
  password_hash TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  modules TEXT NOT NULL DEFAULT '[]',
  scopes TEXT NOT NULL DEFAULT '[]',
  must_change_password INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  user_agent TEXT
);
CREATE TABLE IF NOT EXISTS auth_sources (
  key TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  config TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS sso_states (
  state TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  code_verifier TEXT,
  nonce TEXT,
  redirect_to TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
-- 第五版：设备管理（位置 → 机柜 → 设备 → 链路）
CREATE TABLE IF NOT EXISTS asset_locations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'room',
  parent_id TEXT,
  address TEXT NOT NULL DEFAULT '',
  contact TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS asset_racks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  location_id TEXT NOT NULL,
  units INTEGER NOT NULL DEFAULT 42,
  power_kw REAL NOT NULL DEFAULT 6,
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT NOT NULL DEFAULT '',
  -- 位置平面图里同一位置的机柜横向排列顺序；0 表示沿用默认（按编号）排序
  layout_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS asset_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  vendor TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'other',
  mgmt_ip TEXT,
  location_id TEXT,
  rack_id TEXT,
  rack_u INTEGER,
  status TEXT NOT NULL DEFAULT 'online',
  vrf TEXT NOT NULL DEFAULT 'default',
  owner TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS asset_links (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  local_device_id TEXT NOT NULL,
  local_port TEXT NOT NULL,
  remote_device_id TEXT NOT NULL,
  remote_port TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'trunk',
  bandwidth_gbps REAL NOT NULL DEFAULT 10,
  vlan TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'up',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_asset_device_rack ON asset_devices(rack_id);
CREATE INDEX IF NOT EXISTS idx_asset_link_local ON asset_links(local_device_id);
CREATE INDEX IF NOT EXISTS idx_asset_link_remote ON asset_links(remote_device_id);
-- 第六版：角色字典。设备表单的角色恢复为纯下拉，选项只来自本表；
-- builtin=1 为预置角色（不可删除 / 改名），enabled=0 的角色不进入下拉但保留历史引用。
CREATE TABLE IF NOT EXISTS asset_device_roles (
  key TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  builtin INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_asset_device_role ON asset_devices(role);
"""

# (分组 CIDR, 名称, [(子网 CIDR, 名称, VLAN, 已登记使用数)])
GROUPS = [
    ("10.1.0.0/16", "华东生产", [
        ("10.1.1.0/24", "核心业务", 101, 220),
        ("10.1.2.0/24", "数据库集群", 102, 166),
        ("10.1.3.0/24", "消息队列", 103, 176),
        ("10.1.10.0/24", "办公终端", 110, 105),
        ("10.1.20.0/24", "网络设备管理", 120, 206),
    ]),
    ("10.2.0.0/16", "华北生产", [
        ("10.2.1.0/24", "容器节点", 201, 184),
        ("10.2.2.0/24", "缓存与中间件", 202, 152),
        ("10.2.3.0/24", "大数据计算", 203, 141),
    ]),
    ("10.8.0.0/16", "测试环境", [
        ("10.8.1.0/24", "开发环境", 801, 118),
        ("10.8.5.0/24", "集成测试", 805, 84),
    ]),
    ("10.9.0.0/16", "DMZ 区", [
        ("10.9.1.0/24", "DMZ 边缘", 901, 198),
        ("10.9.2.0/24", "公网映射", 902, 233),
    ]),
]

PROFILES = {
    "10.1.1.0/24": ("核心交易平台", "张伟", "app-core"),
    "10.1.2.0/24": ("订单数据库", "陈默", "db-mysql"),
    "10.1.3.0/24": ("消息中间件", "王磊", "mq-kafka"),
    "10.1.10.0/24": ("办公终端", "李娜", "pc-office"),
    "10.1.20.0/24": ("网络设备", "赵强", "sw-access"),
    "10.2.1.0/24": ("容器平台", "刘洋", "k8s-node"),
    "10.2.2.0/24": ("缓存服务", "孙倩", "redis"),
    "10.2.3.0/24": ("大数据平台", "周敏", "spark-worker"),
    "10.8.1.0/24": ("研发环境", "何静", "dev-box"),
    "10.8.5.0/24": ("集成测试", "何静", "test-runner"),
    "10.9.1.0/24": ("反向代理", "吴昊", "dmz-proxy"),
    "10.9.2.0/24": ("公网映射", "吴昊", "nat-map"),
}


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def now() -> str:
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def audit(conn: sqlite3.Connection, action: str, addr: str, detail: str,
          vrf: str | None = None) -> None:
    """审计自动带上当前地址平面；跨平面汇总操作记为 default。"""
    value = vrf or current_vrf()
    if value == ALL_VRFS:
        value = "default"
    conn.execute(
        "INSERT INTO audit_logs(ts, action, addr, detail, vrf) VALUES(?,?,?,?,?)",
        (now(), action, addr, detail, value),
    )


def _seed(conn: sqlite3.Connection) -> None:
    conn.execute(
        "INSERT INTO prefixes(cidr,parent_cidr,name,kind,site,vrf) VALUES(?,?,?,?,?,?)",
        ("10.0.0.0/8", None, "企业内网根空间", "root", "全局", "default"),
    )
    seq = 0
    for group_cidr, group_name, subnets in GROUPS:
        conn.execute(
            "INSERT INTO prefixes(cidr,parent_cidr,name,kind,site,vrf) VALUES(?,?,?,?,?,?)",
            (group_cidr, "10.0.0.0/8", group_name, "aggregate", group_name, "default"),
        )
        for cidr, name, vlan, used in subnets:
            conn.execute(
                "INSERT INTO prefixes(cidr,parent_cidr,name,kind,site,vlan,vrf) VALUES(?,?,?,?,?,?,?)",
                (cidr, group_cidr, name, "subnet", group_name, vlan, "default"),
            )
            business, owner, prefix = PROFILES[cidr]
            cursor = domain.bounds(cidr)[0] + 2
            for k in range(used):
                addr_int = cursor
                cursor += 1
                status = "assigned"
                if k == used - 1:
                    status = "deprecated"
                elif name in ("数据库集群", "公网映射") and k == 1:
                    status = "conflict"
                if status == "conflict":
                    hostname = "unknown-host"
                elif status == "deprecated":
                    hostname = f"old-{prefix}-{k + 1:03d}"
                elif k < 4:
                    hostname = f"{prefix}-{k + 1:02d}"
                else:
                    hostname = f"host-{k + 1:03d}"
                updated = f"2026-11-09 14:{20 + seq % 30:02d}:00" if k < 4 else f"2026-10-{10 + k % 18:02d} 09:00:00"
                seq += 1
                conn.execute(
                    "INSERT INTO ip_addresses(vrf,addr,addr_int,prefix_cidr,status,hostname,business,owner,vlan,updated_at) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?)",
                    ("default", domain.to_ip(addr_int), addr_int, cidr, status, hostname,
                     business, owner, vlan, updated),
                )
            reserved = 11 if cidr == "10.9.2.0/24" else 10
            for k in range(reserved):
                addr_int = cursor
                cursor += 1
                conn.execute(
                    "INSERT INTO ip_addresses(vrf,addr,addr_int,prefix_cidr,status,hostname,business,owner,vlan,updated_at) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?)",
                    ("default", domain.to_ip(addr_int), addr_int, cidr, "reserved",
                     f"pending-{k + 1:02d}", business, owner, vlan, "2026-11-09 13:00:00"),
                )

    base = datetime.date(2026, 11, 9)
    for i in range(14):
        day = base - datetime.timedelta(days=13 - i)
        occupied = 1740 + round((2104 - 1740) * i / 13)
        conn.execute(
            "INSERT INTO utilization_snapshots(vrf,day,occupied,util) VALUES(?,?,?,?)",
            ("default", day.isoformat(), occupied, round((occupied - 121) / 3036 * 100, 2)),
        )

    conn.execute("UPDATE prefixes SET updated_at=? WHERE updated_at IS NULL", (now(),))
    audit(conn, "seed", "10.0.0.0/8", "初始化地址空间：4 个汇聚前缀 / 12 个 /24 网段")
    conn.commit()


# 老库兼容：CREATE TABLE IF NOT EXISTS 不会给已有表补列，这里显式迁移。
MIGRATIONS = [
    ("prefixes", "description", "TEXT NOT NULL DEFAULT ''"),
    ("prefixes", "updated_at", "TEXT"),
    # 老库补列：位置平面图机柜横向顺序，默认 0 时按编号排序
    ("asset_racks", "layout_order", "INTEGER NOT NULL DEFAULT 0"),
    # 路线 2：所有地址相关记录都要带上所属地址平面
    ("audit_logs", "vrf", "TEXT NOT NULL DEFAULT 'default'"),
    ("utilization_snapshots", "vrf", "TEXT NOT NULL DEFAULT 'default'"),
    ("discovery_records", "vrf", "TEXT NOT NULL DEFAULT 'default'"),
    ("reconciliation_diffs", "vrf", "TEXT NOT NULL DEFAULT 'default'"),
    ("tickets", "vrf", "TEXT NOT NULL DEFAULT 'default'"),
    # P0-2：告警事件也要能按地址平面归因 / 过滤
    ("webhook_events", "vrf", "TEXT NOT NULL DEFAULT 'default'"),
    # P2：VRF 级容量阈值（NULL = 沿用全局设置）
    ("vrfs", "warn_threshold", "REAL"),
    ("vrfs", "crit_threshold", "REAL"),
]


def _rebuild_vrf_tables(conn: sqlite3.Connection) -> list[str]:
    """幂等重建 prefixes / ip_addresses，把全局主键升级为 (vrf, ...) 复合键。

    SQLite 不支持 ALTER PRIMARY KEY，只能建新表 + 复制 + 换名。旧库里 cidr 全局唯一，
    因此 ip_addresses.vrf 可以从所属前缀的 vrf 精确回填，不需要猜测。
    """
    applied: list[str] = []

    def table_sql(table: str) -> str:
        row = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()
        return (row[0] if row else "") or ""

    ips_old = "PRIMARY KEY (vrf, addr)" not in " ".join(table_sql("ip_addresses").split())
    pfx_old = "PRIMARY KEY (vrf, cidr)" not in " ".join(table_sql("prefixes").split())

    # 先重建 IP 表：此时 prefixes 仍是旧表，cidr 唯一，可安全反查 vrf
    if ips_old and table_sql("ip_addresses"):
        conn.executescript("""
            CREATE TABLE ip_addresses_vrf2 (
              vrf TEXT NOT NULL DEFAULT 'default',
              addr TEXT NOT NULL,
              addr_int INTEGER NOT NULL,
              prefix_cidr TEXT NOT NULL,
              status TEXT NOT NULL,
              hostname TEXT, business TEXT, owner TEXT,
              vlan INTEGER, updated_at TEXT NOT NULL,
              PRIMARY KEY (vrf, addr), UNIQUE (vrf, addr_int)
            );
            INSERT INTO ip_addresses_vrf2
              (vrf, addr, addr_int, prefix_cidr, status, hostname, business, owner, vlan, updated_at)
            SELECT COALESCE((SELECT p.vrf FROM prefixes p WHERE p.cidr = i.prefix_cidr), 'default'),
                   i.addr, i.addr_int, i.prefix_cidr, i.status, i.hostname, i.business,
                   i.owner, i.vlan, i.updated_at
              FROM ip_addresses i;
            DROP TABLE ip_addresses;
            ALTER TABLE ip_addresses_vrf2 RENAME TO ip_addresses;
            CREATE INDEX IF NOT EXISTS idx_ip_prefix ON ip_addresses(vrf, prefix_cidr);
            CREATE INDEX IF NOT EXISTS idx_ip_status ON ip_addresses(vrf, status);
        """)
        applied.append("ip_addresses(vrf,addr)")

    if pfx_old and table_sql("prefixes"):
        conn.executescript("""
            CREATE TABLE prefixes_vrf2 (
              vrf TEXT NOT NULL DEFAULT 'default',
              cidr TEXT NOT NULL,
              parent_cidr TEXT,
              name TEXT NOT NULL,
              kind TEXT NOT NULL,
              site TEXT, vlan INTEGER,
              description TEXT NOT NULL DEFAULT '',
              updated_at TEXT,
              PRIMARY KEY (vrf, cidr)
            );
            INSERT INTO prefixes_vrf2
              (vrf, cidr, parent_cidr, name, kind, site, vlan, description, updated_at)
            SELECT COALESCE(vrf, 'default'), cidr, parent_cidr, name, kind, site, vlan,
                   COALESCE(description, ''), updated_at
              FROM prefixes;
            DROP TABLE prefixes;
            ALTER TABLE prefixes_vrf2 RENAME TO prefixes;
            CREATE INDEX IF NOT EXISTS idx_prefix_vrf ON prefixes(vrf);
            CREATE INDEX IF NOT EXISTS idx_prefix_parent ON prefixes(vrf, parent_cidr);
        """)
        applied.append("prefixes(vrf,cidr)")

    # 只在首次重建时回填历史 governance 数据；之后用户的手工调整不再被覆盖
    if applied:
        for table in ("discovery_records", "reconciliation_diffs", "tickets"):
            conn.execute(
                f"UPDATE {table} SET vrf=COALESCE("
                "(SELECT p.vrf FROM prefixes p WHERE p.cidr = " + table + ".prefix_cidr LIMIT 1), 'default') "
                "WHERE prefix_cidr IS NOT NULL")
    return applied


def _rebuild_snapshot_table(conn: sqlite3.Connection) -> list[str]:
    """把 utilization_snapshots 的 day 单列主键升级为 (vrf, day)。

    旧表里同一天只能存一条快照，多个地址平面会互相覆盖；SQLite 不支持改主键，
    只能补列后建新表复制。必须在 _migrate() 补完 vrf 列之后调用。
    """
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='utilization_snapshots'"
    ).fetchone()
    sql = " ".join(((row[0] if row else "") or "").split())
    if not sql or "PRIMARY KEY (vrf, day)" in sql:
        return []
    conn.executescript("""
        CREATE TABLE utilization_snapshots_vrf2 (
          vrf TEXT NOT NULL DEFAULT 'default',
          day TEXT NOT NULL,
          occupied INTEGER NOT NULL,
          util REAL NOT NULL,
          PRIMARY KEY (vrf, day)
        );
        INSERT INTO utilization_snapshots_vrf2 (vrf, day, occupied, util)
          SELECT COALESCE(vrf, 'default'), day, occupied, util FROM utilization_snapshots;
        DROP TABLE utilization_snapshots;
        ALTER TABLE utilization_snapshots_vrf2 RENAME TO utilization_snapshots;
        CREATE INDEX IF NOT EXISTS idx_snapshot_vrf_day ON utilization_snapshots(vrf, day);
    """)
    return ["utilization_snapshots(vrf,day)"]


def _migrate(conn: sqlite3.Connection) -> list[str]:
    applied = []
    for table, column, ddl in MIGRATIONS:
        cols = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
        if column not in cols:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")
            if column == "updated_at":
                # 老库补列后给已有前缀一个初始化时间，避免详情页显示「—」
                conn.execute("UPDATE prefixes SET updated_at=? WHERE updated_at IS NULL", (now(),))
            applied.append(f"{table}.{column}")
    return applied


def init_db() -> None:
    conn = connect()
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(SCHEMA)
        _migrate(conn)
        _rebuild_vrf_tables(conn)
        _rebuild_snapshot_table(conn)
        if conn.execute("SELECT COUNT(*) FROM prefixes").fetchone()[0] == 0:
            _seed(conn)
        # 配置类种子与 IP 地址种子解耦：清空地址数据后重启不会重新灌入 IP，
        # 但 VRF / 集成源 / 设置 / 工单样例会保持可用（INSERT OR IGNORE 幂等）。
        from . import assets, auth, device_roles, extended  # 局部导入，避免模块循环
        extended.seed_config(conn)
        assets.seed_assets(conn)
        device_roles.seed_roles(conn)
        # 历史页面文案从「分类标签」翻转为「独立地址平面」，并吸收字典外的历史 VRF 引用
        extended.migrate_vrf_content(conn)
        extended.normalize_vrf_refs(conn)
        conn.commit()
        auth.init_auth(conn)
    finally:
        conn.close()


def thresholds(conn) -> dict:
    rows = {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM settings")}
    return {
        "warn": float(rows.get("warn_threshold", 80)),
        "crit": float(rows.get("crit_threshold", 90)),
        "reservation_ttl_hours": int(rows.get("reservation_ttl_hours", 24)),
        "default_vrf": rows.get("default_vrf", "default"),
        "gateway_offset": int(rows.get("gateway_offset", 1)),
    }


def plane_thresholds(conn, vrf=None) -> dict:
    """当前地址平面的有效容量阈值：VRF 自定义值优先，未配置则回落全局设置。

    汇总视图（'all'）没有单一平面，统一使用全局阈值。
    """
    th = thresholds(conn)
    plane = current_vrf() if vrf is None else vrf
    if plane == ALL_VRFS:
        return th
    row = conn.execute("SELECT warn_threshold, crit_threshold FROM vrfs WHERE name=?",
                       (plane,)).fetchone()
    if row:
        if row["warn_threshold"] is not None:
            th["warn"] = float(row["warn_threshold"])
        if row["crit_threshold"] is not None:
            th["crit"] = float(row["crit_threshold"])
    return th


def _stats_maps(conn, vrf=None):
    """按 (vrf, prefix_cidr) 聚合，不能只用 cidr —— 同一网段可属于多个地址平面。"""
    cond, args = vrf_sql(vrf)
    occupied = {(r["vrf"], r["prefix_cidr"]): r["n"] for r in conn.execute(
        "SELECT vrf, prefix_cidr, COUNT(*) n FROM ip_addresses" + cond +
        " GROUP BY vrf, prefix_cidr", args)}
    reserved = {(r["vrf"], r["prefix_cidr"]): r["n"] for r in conn.execute(
        "SELECT vrf, prefix_cidr, COUNT(*) n FROM ip_addresses" +
        (cond + " AND" if cond else " WHERE") + " status='reserved' GROUP BY vrf, prefix_cidr",
        args)}
    return occupied, reserved


def list_prefixes(conn: sqlite3.Connection, vrf=None) -> list[dict]:
    cond, args = vrf_sql(vrf)
    raw = [dict(r) for r in conn.execute(
        "SELECT * FROM prefixes" + cond + " ORDER BY vrf, cidr", args)]
    occupied, reserved = _stats_maps(conn, vrf)
    subnets = [p for p in raw if p["kind"] == "subnet"]
    out = []
    for p in raw:
        key = (p["vrf"], p["cidr"])
        if p["kind"] == "subnet":
            # 网段规模由 CIDR 推导，支持编辑 / 新建后的非 /24 掩码
            total = domain.bounds(p["cidr"])[2]
            retained = len(domain.retained(p["cidr"]))
            used, res = occupied.get(key, 0), reserved.get(key, 0)
            child_count = 0
        else:
            # 父子关系只在同一地址平面内成立
            children = [s for s in subnets
                        if s["vrf"] == p["vrf"] and domain.contains(p["cidr"], s["cidr"])]
            total = sum(domain.bounds(s["cidr"])[2] for s in children)
            retained = sum(len(domain.retained(s["cidr"])) for s in children)
            used = sum(occupied.get((s["vrf"], s["cidr"]), 0) for s in children)
            res = sum(reserved.get((s["vrf"], s["cidr"]), 0) for s in children)
            child_count = len(children)
        free = max(0, total - retained - used)
        util = round((used - res) / (total - retained) * 100, 1) if total > retained else 0
        out.append({**p, "total": total, "retained": retained, "occupied": used,
                    "reserved": res, "free": free, "util": util,
                    "child_count": child_count})
    return out


def _scope_cidrs(conn, prefix: str, vrf=None) -> set[str] | None:
    if prefix in ("", "all"):
        return None
    cond, extra = vrf_sql(vrf, joiner="AND")
    row = conn.execute("SELECT kind FROM prefixes WHERE cidr=?" + cond,
                       [prefix] + extra).fetchone()
    if row is None:
        raise ValueError("前缀不存在于当前 VRF 地址平面")
    if row["kind"] == "subnet":
        return {prefix}
    rows = conn.execute("SELECT cidr FROM prefixes WHERE kind='subnet'" + cond, extra)
    return {p["cidr"] for p in rows if domain.contains(prefix, p["cidr"])}


def list_ips(conn, prefix="all", status="all", q="", page=1, page_size=10,
             scopes: list[str] | None = None, vrf=None) -> dict:
    """scopes 为当前用户的可见 CIDR 范围；在 SQL 层过滤，保证分页与 total 口径正确。"""
    scope = _scope_cidrs(conn, prefix, vrf)
    cond, vargs = vrf_sql(vrf)
    where = ([cond.strip().removeprefix("WHERE").strip()] if cond else [])
    args = list(vargs)
    if scope is not None:
        if not scope:
            return {"items": [], "total": 0, "page": page, "page_size": page_size, "pages": 1}
        where.append("prefix_cidr IN (%s)" % ",".join("?" * len(scope)))
        args += sorted(scope)
    if scopes:
        parts, range_args = [], []
        for cidr in scopes:
            lo, hi, _ = domain.bounds(cidr)
            parts.append("(addr_int BETWEEN ? AND ?)")
            range_args += [lo, hi]
        where.append("(" + " OR ".join(parts) + ")")
        args += range_args
    if status != "all":
        where.append("status=?")
        args.append(status)
    if q:
        where.append("(addr LIKE ? OR hostname LIKE ? OR business LIKE ? OR owner LIKE ? OR prefix_cidr LIKE ?)")
        args += [f"%{q}%"] * 5
    clause = " WHERE " + " AND ".join(where) if where else ""
    total = conn.execute("SELECT COUNT(*) FROM ip_addresses" + clause, args).fetchone()[0]
    rows = conn.execute(
        "SELECT * FROM ip_addresses" + clause + " ORDER BY updated_at DESC, addr_int ASC LIMIT ? OFFSET ?",
        args + [page_size, (page - 1) * page_size],
    ).fetchall()
    return {"vrf": current_vrf() if vrf is None else vrf,
            "items": [dict(r) for r in rows], "total": total, "page": page,
            "page_size": page_size, "pages": max(1, (total + page_size - 1) // page_size)}


def dashboard(conn, vrf=None) -> dict:
    value = current_vrf() if vrf is None else vrf
    prefixes = list_prefixes(conn, value)
    subs = [p for p in prefixes if p["kind"] == "subnet"]
    total = sum(p["total"] for p in subs)
    retained = sum(p["retained"] for p in subs)
    occupied = sum(p["occupied"] for p in subs)
    reserved = sum(p["reserved"] for p in subs)
    free = total - retained - occupied
    cond, args = vrf_sql(value)
    counts = {r["status"]: r["n"] for r in conn.execute(
        "SELECT status, COUNT(*) n FROM ip_addresses" + cond + " GROUP BY status", args)}
    ranking = sorted(subs, key=lambda p: p["util"], reverse=True)
    # 容量预警按当前平面的阈值（未单独配置时回落全局设置）
    th = plane_thresholds(conn, value)
    if value == ALL_VRFS:
        # 汇总视图按天合并各平面，避免同一 day 的多行让折线错位
        trend = [dict(r) for r in conn.execute(
            "SELECT day, SUM(occupied) AS occupied, ROUND(AVG(util), 2) AS util, 'all' AS vrf "
            "FROM utilization_snapshots GROUP BY day ORDER BY day")]
    else:
        # 只取本平面的历史；新平面没有快照就显示空态，不能借用别的平面曲线
        tcond, targs = vrf_sql(value)
        trend = [dict(r) for r in conn.execute(
            "SELECT day, occupied, util, ? AS vrf FROM utilization_snapshots" + tcond +
            " ORDER BY day", [value] + targs)]
    logs = [dict(r) for r in conn.execute(
        "SELECT ts, action, addr, detail, vrf FROM audit_logs" + cond +
        " ORDER BY id DESC LIMIT 6", args)]
    return {
        "vrf": value,
        "total": total, "retained": retained, "occupied": occupied, "reserved": reserved,
        "free": max(0, free),
        "util": round((occupied - reserved) / max(1, total - retained) * 100, 1),
        "status": counts, "subnet_count": len(subs), "thresholds": th,
        "ranking": [{"cidr": p["cidr"], "vrf": p["vrf"], "name": p["name"], "site": p["site"],
                     "vlan": p["vlan"], "util": p["util"], "free": p["free"],
                     "occupied": p["occupied"]} for p in ranking],
        "alerts": [p for p in ranking if p["util"] >= th["warn"]],
        "trend": trend, "audit": logs,
    }


def record_snapshot(conn, vrf=None) -> dict:
    """按地址平面采样当日利用率快照；'all' 汇总视图为全部已有平面各写一条。

    同一 (vrf, day) 覆盖更新，重复调用幂等；采样口径直接复用 dashboard()，
    保证折线与当前看板的 occupied / util 完全一致。
    """
    value = current_vrf() if vrf is None else vrf
    if value == ALL_VRFS:
        planes = [r[0] for r in conn.execute(
            "SELECT name FROM vrfs UNION SELECT DISTINCT vrf FROM prefixes ORDER BY name")]
    else:
        planes = [value]
    day = datetime.date.today().isoformat()
    written = []
    for plane in planes:
        d = dashboard(conn, plane)
        conn.execute(
            "INSERT INTO utilization_snapshots(vrf,day,occupied,util) VALUES(?,?,?,?) "
            "ON CONFLICT(vrf,day) DO UPDATE SET occupied=excluded.occupied, util=excluded.util",
            (plane, day, d["occupied"], d["util"]))
        written.append({"vrf": plane, "occupied": d["occupied"], "util": d["util"]})
    conn.commit()
    return {"day": day, "vrf": value, "planes": written}


# ---------------------- 手动分配：地址归属校验与预检 ----------------------

def _subnets_containing(conn, value: int, vrf=None) -> list[dict]:
    """返回当前地址平面内包含该地址的全部可分配子网。"""
    cond, args = vrf_sql(vrf, joiner="AND")
    matches = []
    for row in conn.execute(
            "SELECT cidr,name,vlan,vrf FROM prefixes WHERE kind='subnet'" + cond, args):
        start, end, _ = domain.bounds(row["cidr"])
        if start <= value <= end:
            matches.append(dict(row))
    return matches


def _finest_subnet(matches: list[dict]) -> dict:
    """最细（掩码最长）的子网才是地址真正的登记归属。"""
    return max(matches, key=lambda r: domain.net(r["cidr"]).prefixlen)


def resolve_manual_prefix(conn, value: int, requested: str = "", vrf=None) -> str:
    """手动分配时确定归属子网：未指定 / auto 时自动匹配；显式指定则必须是最细归属。"""
    matches = _subnets_containing(conn, value, vrf)
    if not matches:
        raise ValueError(f"{domain.to_ip(value)} 不属于当前 VRF 的任何已纳管子网，请先划入对应网段")
    best = _finest_subnet(matches)
    if requested and requested not in ("", "auto"):
        cond, extra = vrf_sql(vrf, joiner="AND")
        prow = conn.execute("SELECT kind FROM prefixes WHERE cidr=?" + cond,
                            [requested] + extra).fetchone()
        if prow is None:
            raise ValueError(f"目标子网 {requested} 不存在于当前 VRF 地址平面")
        if prow["kind"] != "subnet":
            raise ValueError(f"{requested} 不是可分配子网，请选择具体网段或使用自动匹配")
        if not any(m["cidr"] == requested for m in matches):
            raise ValueError(f"{domain.to_ip(value)} 不在所选子网 {requested} 内")
        if requested != best["cidr"]:
            raise ValueError(f"该地址应归属更细的子网 {best['cidr']}，请切换目标子网或使用自动匹配")
    return best["cidr"]


def _manual_issues(conn, prefix: str, value: int, vrf=None) -> list[str]:
    """手动指定地址的全部写前校验，返回可读的问题列表（空列表表示可分配）。"""
    cond, extra = vrf_sql(vrf, joiner="AND")
    row = conn.execute("SELECT kind FROM prefixes WHERE cidr=?" + cond,
                       [prefix] + extra).fetchone()
    if row is None or row["kind"] != "subnet":
        return ["只能在当前 VRF 的可分配子网下登记地址"]
    start, end, _ = domain.bounds(prefix)
    addr = domain.to_ip(value)
    if not (start <= value <= end):
        return [f"{addr} 不在子网 {prefix} 内"]
    issues: list[str] = []
    if value in domain.retained(prefix):
        label = "网络号" if value == start else ("广播地址" if value == end else "默认网关")
        issues.append(f"{addr} 是 {prefix} 的{label}，属保留地址，不可分配")
    dup = conn.execute(
        "SELECT * FROM ip_addresses WHERE (addr=? OR addr_int=?)" + cond,
        [addr, value] + extra).fetchone()
    if dup:
        issues.append(
            f"{addr} 已在本 VRF 登记占用（{domain.STATUS_LABELS.get(dup['status'], dup['status'])} · "
            f"{dup['prefix_cidr']} · {dup['hostname']}），不可重复分配；"
            "如需相同地址请切换到其它 VRF 地址平面")
    for m in _subnets_containing(conn, value, vrf):
        if m["cidr"] != prefix and domain.net(m["cidr"]).prefixlen > domain.net(prefix).prefixlen:
            issues.append(f"该地址应归属更细的子网 {m['cidr']}")
    return issues


def manual_check(conn, addr: str, prefix: str = "", vrf=None) -> dict:
    """手动分配表单实时预检：只读，不占锁、不写库。"""
    text = (addr or "").strip()
    requested = (prefix or "").strip()
    value_name = current_vrf() if vrf is None else vrf
    out = {"addr": text, "prefix": requested or "auto", "vrf": value_name, "valid": False,
           "issues": [], "resolved_prefix": None, "info": None, "suggestion": None}
    if not text:
        out["issues"].append("请输入要分配的 IPv4 地址")
        return out
    try:
        value = domain.parse_ipv4(text)
    except ValueError as exc:
        out["issues"].append(str(exc))
        return out
    matches = _subnets_containing(conn, value, vrf)
    if not matches:
        out["issues"].append(f"{text} 不属于当前 VRF 的已纳管子网，请先划入对应网段")
        return out
    best = _finest_subnet(matches)
    resolved = best["cidr"]
    out["resolved_prefix"] = resolved
    info = domain.cidr_info(resolved)
    cond, extra = vrf_sql(vrf, joiner="AND")
    used = {r[0] for r in conn.execute(
        "SELECT addr_int FROM ip_addresses WHERE prefix_cidr=?" + cond,
        [resolved] + extra)}
    nxt = domain.next_available(resolved, used)
    out["suggestion"] = domain.to_ip(nxt) if nxt is not None else None
    out["info"] = {
        "cidr": resolved, "name": best["name"], "vlan": best["vlan"],
        "first_host": info["first_host"], "last_host": info["last_host"],
        "usable": info["usable"],
        "free": max(0, info["usable"] - len(used - domain.retained(resolved))),
    }
    if requested and requested != "auto":
        prow = conn.execute("SELECT kind FROM prefixes WHERE cidr=?" + cond,
                            [requested] + extra).fetchone()
        if prow is None:
            out["issues"].append(f"目标子网 {requested} 不存在于当前 VRF 地址平面")
        elif prow["kind"] != "subnet":
            out["issues"].append(f"{requested} 不是可分配子网，请选择具体网段")
        elif requested != resolved:
            if any(m["cidr"] == requested for m in matches):
                out["issues"].append(f"该地址应归属更细的子网 {resolved}，请切换目标子网或使用自动匹配")
            else:
                out["issues"].append(f"{text} 不在所选子网 {requested} 内")
    out["issues"].extend(_manual_issues(conn, resolved, value, vrf))
    out["valid"] = not out["issues"]
    return out


def allocate(payload: dict, vrf=None) -> dict:
    """分配地址：addr 为空取最小可用地址（自动），有值则按指定 IP 登记（手动）。

    两条路径共用同一把「(vrf, 前缀)」锁与 BEGIN IMMEDIATE 事务，因此同一地址平面
    内并发的自动与手动申请不会撞号；不同 VRF 的相同网段互不干扰。
    """
    plane = payload.get("vrf") or (current_vrf() if vrf is None else vrf)
    if plane == ALL_VRFS:
        raise ValueError("分配地址前请选择具体的 VRF 地址平面，不能在「全部 VRF」汇总视图下操作")
    addr_in = str(payload.get("addr") or "").strip()
    requested = str(payload.get("prefix") or "").strip()
    manual = bool(addr_in)
    value_in = domain.parse_ipv4(addr_in) if manual else None
    if not manual and not requested:
        raise ValueError("请选择目标子网")
    status = payload.get("mode", "assigned")
    if status not in ("assigned", "reserved"):
        raise ValueError("不支持的分配方式")
    cond, extra = vrf_sql(plane, joiner="AND")
    # 锁 key 需在事务外确定；手动分配按地址归属的最细子网解析
    if manual:
        conn0 = connect()
        try:
            prefix = resolve_manual_prefix(conn0, value_in, requested, plane)
        finally:
            conn0.close()
    else:
        prefix = requested

    with domain.prefix_lock(plane, prefix):
        conn = connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT kind FROM prefixes WHERE cidr=?" + cond,
                               [prefix] + extra).fetchone()
            if row is None or row["kind"] != "subnet":
                raise ValueError(f"只能在 {plane} 的可分配子网下分配地址")
            if manual:
                # 事务内二次确认：并发前缀变更或刚被占用的地址以库内最新状态为准
                prefix = resolve_manual_prefix(conn, value_in, requested, plane)
                issues = _manual_issues(conn, prefix, value_in, plane)
                if issues:
                    raise ValueError("；".join(issues))
                value = value_in
            else:
                used = {r[0] for r in conn.execute(
                    "SELECT addr_int FROM ip_addresses WHERE prefix_cidr=?" + cond,
                    [prefix] + extra)}
                value = domain.next_available(prefix, used)
                if value is None:
                    raise ValueError("该网段已无可分配地址，请先扩容")
            addr = domain.to_ip(value)
            suffix = value & 0xff
            hostname = payload.get("hostname") or (
                f"srv-manual-{suffix}" if manual else f"srv-auto-{suffix}")
            p = conn.execute("SELECT vlan FROM prefixes WHERE cidr=?" + cond,
                             [prefix] + extra).fetchone()
            conn.execute(
                "INSERT INTO ip_addresses(vrf,addr,addr_int,prefix_cidr,status,hostname,"
                "business,owner,vlan,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (plane, addr, value, prefix, status, hostname,
                 payload.get("business") or "未指定", payload.get("owner") or "—",
                 p["vlan"], now()),
            )
            verb = "手动指定分配" if manual else "自动分配"
            audit(conn, "allocate", addr,
                  f"[{plane}] {verb}{'（仅预留）' if status == 'reserved' else ''} → "
                  f"{prefix} / {payload.get('business') or '未指定'}", plane)
            conn.commit()
            return {"addr": addr, "prefix": prefix, "vrf": plane, "status": status,
                    "hostname": hostname, "business": payload.get("business") or "未指定",
                    "owner": payload.get("owner") or "—", "vlan": p["vlan"],
                    "updated_at": now(), "source": "manual" if manual else "auto"}
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


ACTIONS = {
    "confirm": ("reserved", "assigned", "确认预留"),
    "release": ("assigned", "deprecated", "发起回收"),
    "reclaim": ("deprecated", "available", "释放校验通过 · 归还可用池"),
    "resolve": ("conflict", "assigned", "冲突处理完成"),
}


def lookup_ip(conn, addr: str, vrf=None) -> dict:
    """按 (vrf, IP) 精确查询登记记录，并返回当前状态允许的状态机动作。"""
    plane = current_vrf() if vrf is None else vrf
    value = domain.parse_ipv4(addr)
    cond, extra = vrf_sql(plane, joiner="AND")
    row = conn.execute("SELECT * FROM ip_addresses WHERE addr_int=?" + cond,
                       [value] + extra).fetchone()
    if row is None:
        raise LookupError(f"{domain.to_ip(value)} 在 {plane} 平面未登记占用（处于可用池），无需回收")
    rec = dict(row)
    actions = {
        action: {"label": label, "to": dst}
        for action, (src, dst, label) in ACTIONS.items()
        if rec["status"] == src
    }
    return {"item": rec, "actions": actions}


# ---------------------- 子网可视化：全量地址状态位图 ----------------------

MAP_BLOCK_SIZE = 256  # 与一个 /24 C 段对齐，格子数字即 IPv4 地址最后一段


def address_map(conn, cidr: str, block: int = 0, vrf=None) -> dict:
    """推导可分配子网内每个 IPv4 地址的使用状况，供分配页可视化展示。

    大网段按 256 个地址分块返回（避免 /12 这类超网一次生成百万级格子），
    每块格子数字沿用 IPv4 最后一段，与常见「子网地址表」排版一致。
    可用地址仍由「前缀区间 − 保留地址 − 更细子网 − 已登记占用」实时推导，不落空行；
    所有关联查询都限定在当前 VRF 地址平面内。
    """
    key = (cidr or "").strip()
    cond, extra = vrf_sql(vrf, joiner="AND")
    row = conn.execute("SELECT * FROM prefixes WHERE cidr=?" + cond,
                       [key] + extra).fetchone()
    if row is None:
        raise LookupError(f"前缀 {key} 不存在于当前 VRF 地址平面")
    if row["kind"] != "subnet":
        raise ValueError(f"{key} 不是可分配子网，地址可视化仅支持子网层级")
    start, end, total = domain.bounds(row["cidr"])
    block_count = max(1, (total + MAP_BLOCK_SIZE - 1) // MAP_BLOCK_SIZE)
    index = max(0, min(int(block or 0), block_count - 1))
    b_start = start + index * MAP_BLOCK_SIZE
    b_end = min(end, b_start + MAP_BLOCK_SIZE - 1)

    retained = domain.retained(row["cidr"])
    records = {r["addr_int"]: dict(r) for r in conn.execute(
        "SELECT * FROM ip_addresses WHERE addr_int BETWEEN ? AND ?" + cond,
        [b_start, b_end] + extra)}
    # 网段内若还有更细的子网划分，这些地址不能在父网段直接分配
    children = []
    for child in conn.execute(
            "SELECT cidr FROM prefixes WHERE kind='subnet' AND cidr<>?" + cond,
            [row["cidr"]] + extra):
        c = child["cidr"]
        if domain.contains(row["cidr"], c):
            cs, ce, _ = domain.bounds(c)
            if cs <= end and ce >= start:
                children.append((max(cs, start), min(ce, end), c))

    cells = []
    for value in range(b_start, b_end + 1):
        rec = records.get(value)
        child = next((c for s, e, c in children if s <= value <= e), None)
        retained_label = None
        if value == start:
            retained_label = "网络号"
        elif value == start + 1 and value in retained:
            retained_label = "默认网关"
        elif value == end:
            retained_label = "广播地址"
        if value in retained:
            state = "retained"
        elif rec:
            state = rec["status"]
        elif child:
            state = "child"
        else:
            state = "available"
        cells.append({
            "addr": domain.to_ip(value),
            "host": value & 0xff,
            "state": state,
            "label": retained_label or ("更细子网" if state == "child"
                                        else domain.STATUS_LABELS.get(state, state)),
            "retained_label": retained_label,
            "child_prefix": child,
            "hostname": rec["hostname"] if rec else None,
            "business": rec["business"] if rec else None,
            "owner": rec["owner"] if rec else None,
            "updated_at": rec["updated_at"] if rec else None,
            "prefix_cidr": rec["prefix_cidr"] if rec else None,
        })

    status_counts = {r["status"]: r["n"] for r in conn.execute(
        "SELECT status, COUNT(*) n FROM ip_addresses "
        "WHERE addr_int BETWEEN ? AND ?" + cond + " GROUP BY status",
        [start, end] + extra)}
    occupied = sum(status_counts.values())
    child_total = sum(e - s + 1 for s, e, _ in children)
    usable = max(0, total - len(retained) - child_total)
    free = max(0, usable - occupied)
    info = domain.cidr_info(row["cidr"])
    blocks = []
    for i in range(block_count):
        s = start + i * MAP_BLOCK_SIZE
        e = min(end, s + MAP_BLOCK_SIZE - 1)
        blocks.append({"index": i, "first": domain.to_ip(s), "last": domain.to_ip(e),
                       "label": f"{domain.to_ip(s)} – {domain.to_ip(e)}"})
    return {
        "cidr": row["cidr"], "name": row["name"], "site": row["site"],
        "vlan": row["vlan"], "vrf": row["vrf"],
        "info": {"network": info["network"], "broadcast": info["broadcast"],
                 "mask": info["mask"], "prefixlen": info["prefixlen"],
                 "first_host": info["first_host"], "last_host": info["last_host"],
                 "total": total, "usable": usable},
        "block": index, "block_count": block_count, "block_size": MAP_BLOCK_SIZE,
        "blocks": blocks, "cells": cells,
        "counts": {
            "total": total, "retained": len(retained), "child": child_total,
            "available": free, "free": free, "occupied": occupied,
            "assigned": status_counts.get("assigned", 0),
            "reserved": status_counts.get("reserved", 0),
            "deprecated": status_counts.get("deprecated", 0),
            "conflict": status_counts.get("conflict", 0),
            "util": round(occupied / usable * 100, 1) if usable else 0,
        },
        "block_counts": {
            s: sum(1 for c in cells if c["state"] == s)
            for s in ("available", "retained", "child", "assigned",
                      "reserved", "deprecated", "conflict")
        },
    }


def transition(addr: str, action: str, vrf=None) -> dict:
    """状态机流转，按 (vrf, addr) 定位。reclaim 会删除该行，使其回到本平面可用池。"""
    if action not in ACTIONS:
        raise ValueError("不支持的操作")
    plane = current_vrf() if vrf is None else vrf
    if plane == ALL_VRFS:
        raise ValueError("请先选择具体的 VRF 地址平面，不能在汇总视图下执行回收")
    src, dst, label = ACTIONS[action]
    cond, extra = vrf_sql(plane, joiner="AND")
    conn = connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT * FROM ip_addresses WHERE addr=?" + cond,
                           [addr] + extra).fetchone()
        if row is None:
            raise LookupError(f"地址记录不存在于 {plane} 平面")
        if row["status"] != src:
            raise ValueError(f"状态不允许该操作：当前 {domain.STATUS_LABELS.get(row['status'], row['status'])}")
        if not domain.can_transition(src, dst):
            raise ValueError("非法状态流转")
        if dst == "available":
            conn.execute("DELETE FROM ip_addresses WHERE addr=?" + cond, [addr] + extra)
        else:
            conn.execute("UPDATE ip_addresses SET status=?, updated_at=? WHERE addr=?" + cond,
                         [dst, now(), addr] + extra)
        audit(conn, action, addr, f"[{plane}] {label} · {row['prefix_cidr']}", plane)
        conn.commit()
        return {"addr": addr, "vrf": plane, "from": src, "to": dst, "label": label}
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# ---------------------- 全站模糊搜索（只读） ----------------------

SEARCH_IP_LIMIT = 8
SEARCH_PREFIX_LIMIT = 10


def search(conn, q: str, vrf=None) -> dict:
    """顶栏全局搜索：IP 地址 / CIDR 地址段 / 名称等属性，一次返回分组结果。

    - 文本：模糊匹配 IP 记录（地址、主机名、业务、负责人、归属网段）与前缀
      （CIDR、名称、站点、VRF、备注）。
    - 完整 IPv4：额外联动所有包含该地址的地址段；若未登记，返回可用池提示。
    - CIDR：按网段相等 / 包含 / 相交关系联动地址段。
    - 结果始终带 vrf；同一 CIDR / IP 在不同地址平面各占一条，不互相覆盖。
    """
    plane = current_vrf() if vrf is None else vrf
    text = (q or "").strip()[:64]
    out = {"q": text, "vrf": plane, "ips": [], "prefixes": [], "pool": None,
           "ip_total": 0, "prefix_total": 0}
    if not text:
        return out
    low = text.lower()
    # 用户输入里的 % / _ 按字面匹配，避免被 SQL LIKE 当成通配符查出全表
    escaped = low.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    like = f"%{escaped}%"
    cond, extra = vrf_sql(plane, joiner="AND")

    where = ("(lower(addr) LIKE ? ESCAPE '\\' OR lower(hostname) LIKE ? ESCAPE '\\' "
             "OR lower(business) LIKE ? ESCAPE '\\' OR lower(owner) LIKE ? ESCAPE '\\' "
             "OR lower(prefix_cidr) LIKE ? ESCAPE '\\')" + cond)
    args = [like] * 5 + extra
    out["ip_total"] = conn.execute(
        "SELECT COUNT(*) FROM ip_addresses WHERE " + where, args).fetchone()[0]
    ips = [dict(r) for r in conn.execute(
        "SELECT * FROM ip_addresses WHERE " + where + " ORDER BY vrf, addr_int LIMIT ?",
        args + [SEARCH_IP_LIMIT])]
    for r in ips:
        r["status_label"] = domain.STATUS_LABELS.get(r["status"], r["status"])
    out["ips"] = ips

    all_prefixes = list_prefixes(conn, plane)
    hits: dict[tuple[str, str], dict] = {}

    def add(p: dict, match: str, relation: str, priority: int) -> None:
        key = (p["vrf"], p["cidr"])
        cur = hits.get(key)
        if cur and cur["_priority"] <= priority:
            return
        hits[key] = {
            "cidr": p["cidr"], "vrf": p["vrf"], "name": p["name"], "kind": p["kind"],
            "site": p["site"], "vlan": p["vlan"], "vrf": p["vrf"],
            "description": p["description"], "util": p["util"], "free": p["free"],
            "occupied": p["occupied"], "total": p["total"],
            "match": match, "relation": relation, "_priority": priority,
        }

    for p in all_prefixes:
        fields = (p["cidr"], p["name"], p["site"] or "", p["vrf"], p["description"] or "")
        if any(low in str(f).lower() for f in fields):
            exact = p["cidr"].lower() == low
            add(p, "exact" if exact else "text",
                "精确网段" if exact else "名称 / 属性匹配", 0 if exact else 4)

    try:
        value = domain.parse_ipv4(text)
    except ValueError:
        value = None
    if value is not None:
        containing = []
        for p in all_prefixes:
            start, end, _ = domain.bounds(p["cidr"])
            if start <= value <= end:
                containing.append(p)
                add(p, "contains", "包含该 IP", 1)
        registered_planes = {r[0] for r in conn.execute(
            "SELECT DISTINCT vrf FROM ip_addresses WHERE addr_int=?" + cond,
            [value] + extra)}
        if plane == ALL_VRFS:
            unregistered = [p for p in containing if p["vrf"] not in registered_planes]
            finest = max(unregistered, key=lambda p: domain.net(p["cidr"]).prefixlen,
                         default=None)
        else:
            if plane in registered_planes:
                finest = None
            else:
                finest = max(containing, key=lambda p: domain.net(p["cidr"]).prefixlen,
                             default=None)
        if finest:
            out["pool"] = {
                "addr": domain.to_ip(value), "vrf": finest["vrf"],
                "finest": finest["cidr"],
                "prefixes": [p["cidr"] for p in containing],
                "allocatable": bool(finest["kind"] == "subnet"),
            }

    if "/" in text:
        target = domain.parse_network_text(text)
        if target is not None:
            for p in all_prefixes:
                pn = domain.net(p["cidr"])
                if not pn.overlaps(target):
                    continue
                if pn == target:
                    relation, priority = "精确网段", 0
                elif pn.subnet_of(target):
                    relation, priority = "属于查询网段", 2
                elif target.subnet_of(pn):
                    relation, priority = "包含查询网段", 2
                else:
                    relation, priority = "网段相交", 3
                add(p, "cidr", relation, priority)

    ordered = sorted(hits.values(),
                     key=lambda x: (x["_priority"], domain.bounds(x["cidr"])[0], x["vrf"]))
    out["prefix_total"] = len(ordered)
    out["prefixes"] = [
        {k: v for k, v in x.items() if k != "_priority"}
        for x in ordered[:SEARCH_PREFIX_LIMIT]
    ]
    return out
