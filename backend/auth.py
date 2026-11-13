"""01 接入与展示层：本地 / LDAP / SSO 认证，角色与可见范围授权。

安全边界：
- 密码只用 PBKDF2-HMAC-SHA256 + 随机盐落库，任何接口都不返回哈希；
- 会话 token 存 SQLite，浏览器只持有 HttpOnly Cookie；
- 角色仅 admin / viewer。viewer 的可见模块与 CIDR 可见范围由管理员手动分配；
- 所有 /api 请求经统一中间件鉴权：viewer 的写操作、非授权模块在后端直接拒绝；
- 响应按可见范围过滤，前端隐藏只是体验，后端才是真正的边界。
"""
from __future__ import annotations

import base64
import contextvars
import datetime
import hashlib
import hmac
import html
import ipaddress
import json
import re
import secrets
import socket
import sqlite3
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from . import db, domain

ROLE_ADMIN = "admin"
ROLE_VIEWER = "viewer"
SOURCE_LOCAL = "local"
SOURCE_LDAP = "ldap"
SOURCE_SSO = "sso"

SESSION_HOURS = 12
COOKIE_NAME = "ipam_session"
PBKDF2_ROUNDS = 200_000
LOCK_THRESHOLD = 5
LOCK_MINUTES = 5

MODULES: list[dict[str, str]] = [
    {"key": "dashboard", "label": "概览看板", "group": "工作台"},
    {"key": "spaces", "label": "地址空间树", "group": "地址管理"},
    {"key": "allocation", "label": "IP 分配/回收", "group": "地址管理"},
    {"key": "subnets", "label": "子网划分", "group": "地址管理"},
    {"key": "vrf", "label": "VRF 地址平面", "group": "地址管理"},
    {"key": "devices", "label": "设备", "group": "设备管理"},
    {"key": "racks", "label": "机柜", "group": "设备管理"},
    {"key": "links", "label": "链路", "group": "设备管理"},
    {"key": "locations", "label": "位置", "group": "设备管理"},
    {"key": "device_roles", "label": "角色", "group": "设备管理"},
    {"key": "tickets", "label": "分配申请", "group": "工单管理"},
    {"key": "approvals", "label": "审批工单", "group": "工单管理"},
    {"key": "reconciliation", "label": "发现与对账", "group": "治理与对账"},
    {"key": "audit", "label": "审计日志", "group": "治理与对账"},
    {"key": "reports", "label": "报表中心", "group": "分析与集成"},
    {"key": "integrations", "label": "集成配置", "group": "分析与集成"},
    {"key": "settings", "label": "系统设置", "group": "分析与集成"},
    {"key": "users", "label": "用户与权限", "group": "访问控制"},
]
MODULE_KEYS = [m["key"] for m in MODULES]

DEFAULT_VIEWER_MODULES = ["dashboard", "spaces", "allocation", "reports"]
DEFAULT_VIEWER_SCOPES = ["10.1.0.0/16"]

DEFAULT_LOCAL_CONFIG = {
    "label": "本地账号",
    "password_min_length": 8,
    "session_hours": SESSION_HOURS,
    "lock_threshold": LOCK_THRESHOLD,
    "lock_minutes": LOCK_MINUTES,
}
DEFAULT_LDAP_CONFIG = {
    "label": "LDAP / AD 目录",
    "enabled": True,
    "demo_mode": True,
    "server_url": "ldap://127.0.0.1:389",
    "bind_dn": "cn=admin,dc=example,dc=com",
    "bind_password": "",
    "base_dn": "dc=example,dc=com",
    "user_filter": "(uid={username})",
    "use_tls": False,
    "display_name_attr": "cn",
    "email_attr": "mail",
    "default_modules": list(DEFAULT_VIEWER_MODULES),
    "default_scopes": list(DEFAULT_VIEWER_SCOPES),
    "demo_users": [
        {"username": "ldap.user", "password": "Ldap@123",
         "display_name": "目录用户", "email": "ldap.user@example.com"},
    ],
}
DEFAULT_SSO_CONFIG = {
    "label": "SSO / OIDC",
    "enabled": True,
    "demo_mode": True,
    "provider": "企业统一身份认证",
    "issuer": "https://idp.example.com",
    "client_id": "ipam-console",
    "client_secret": "",
    "redirect_uri": "http://127.0.0.1:8000/api/auth/sso/callback",
    "scope": "openid profile email",
    "default_modules": list(DEFAULT_VIEWER_MODULES),
    "default_scopes": list(DEFAULT_VIEWER_SCOPES),
}

# 公开路径：登录页在拿不到会话时必须能访问
PUBLIC_EXACT = {
    "/api/health", "/api/auth/login", "/api/auth/sources/public",
    "/api/auth/sso/start", "/api/auth/sso/callback",
}
PUBLIC_PREFIXES = ("/api/auth/sso/demo",)
# 不做模块级校验的路径（应用外壳、自身会话信息）
NO_MODULE_CHECK = {
    "/api/overview", "/api/health", "/api/auth/me", "/api/auth/logout",
    "/api/assets/overview",
}
PATH_MODULE_RULES: list[tuple[tuple[str, ...], str]] = [
    (("/api/tickets",), "tickets"),
    (("/api/reconciliation", "/api/discovery"), "reconciliation"),
    (("/api/audit",), "audit"),
    (("/api/reports",), "reports"),
    (("/api/integrations",), "integrations"),
    (("/api/settings", "/api/maintenance"), "settings"),
    (("/api/vrfs", "/api/pages"), "vrf"),
    (("/api/subnets",), "subnets"),
    (("/api/assets/device-roles",), "device_roles"),
    (("/api/assets/devices",), "devices"),
    (("/api/assets/racks",), "racks"),
    (("/api/assets/links",), "links"),
    (("/api/assets/locations",), "locations"),
]

_current = contextvars.ContextVar("ipam_auth_context", default=None)


# ---------------------------------------------------------------- 基础工具


def dt(offset_minutes: float = 0) -> str:
    return (datetime.datetime.now() + datetime.timedelta(minutes=offset_minutes)).strftime(
        "%Y-%m-%d %H:%M:%S")


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ROUNDS)
    return f"pbkdf2_sha256${PBKDF2_ROUNDS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str | None) -> bool:
    try:
        alg, rounds, salt_hex, digest_hex = (stored or "").split("$")
        if alg != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), int(rounds))
        return hmac.compare_digest(digest.hex(), digest_hex)
    except (ValueError, TypeError):
        return False


def validate_username(value: str) -> str:
    text = (value or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9._-]{3,32}", text):
        raise ValueError("用户名需为 3–32 位字母、数字、点、下划线或连字符")
    return text


def validate_password(value: str) -> str:
    text = value or ""
    if len(text) < 8:
        raise ValueError("密码至少 8 位")
    if not re.search(r"[A-Za-z]", text) or not re.search(r"\d", text):
        raise ValueError("密码需同时包含字母和数字")
    return text


def normalize_modules(values: Any, role: str) -> list[str]:
    if role == ROLE_ADMIN:
        return list(MODULE_KEYS)
    if not isinstance(values, list):
        return list(DEFAULT_VIEWER_MODULES)
    return [k for k in MODULE_KEYS if k in values and k != "users"]


# 可见范围支持两种写法：纯 CIDR（对所有 VRF 生效，兼容历史数据）与
# "vrf:CIDR"（只在该 VRF 地址平面内生效），例如 "vrf-lab:10.1.0.0/16"。
VRF_SCOPE_RE = re.compile(r"^([A-Za-z0-9_-]{1,40}):(.+)$")


def split_scope(text: str) -> tuple[str | None, str]:
    m = VRF_SCOPE_RE.match(text)
    return (m.group(1), m.group(2)) if m else (None, text)


def normalize_scopes(values: Any) -> list[str]:
    if not isinstance(values, list):
        return []
    out: list[str] = []
    for raw in values:
        text = str(raw or "").strip()
        if not text:
            continue
        plane, cidr_text = split_scope(text)
        try:
            net = ipaddress.ip_network(cidr_text, strict=False)
        except ValueError as exc:
            raise ValueError(f"无效的可见地址段：{text}") from exc
        if not isinstance(net, ipaddress.IPv4Network):
            raise ValueError(f"仅支持 IPv4 地址段：{text}")
        canonical = f"{plane}:{net}" if plane else str(net)
        if canonical not in out:
            out.append(canonical)
    return out


def normalize_role_scopes(values: Any, role: str) -> list[str]:
    """管理员恒为全部可见地址范围（空列表 = 不限制）；只读用户按 CIDR 授权集裁剪。"""
    return [] if role == ROLE_ADMIN else normalize_scopes(values)


def _row_user(row: sqlite3.Row | dict) -> dict:
    u = dict(row)
    try:
        u["modules"] = json.loads(u.get("modules") or "[]")
        u["scopes"] = json.loads(u.get("scopes") or "[]")
    except (TypeError, ValueError):
        u["modules"], u["scopes"] = [], []
    u["enabled"] = bool(u.get("enabled"))
    u["must_change_password"] = bool(u.get("must_change_password"))
    return u


def public_user(u: dict) -> dict:
    keys = ("username", "display_name", "email", "role", "source", "enabled",
            "modules", "scopes", "must_change_password", "created_at", "last_login_at")
    out = {k: u.get(k) for k in keys}
    # 管理员恒为「全部功能 + 全部可见地址范围」，不受历史/误存的 CIDR 限定影响
    if out.get("role") == ROLE_ADMIN:
        out["modules"] = list(MODULE_KEYS)
        out["scopes"] = []
    return out


def get_user(conn: sqlite3.Connection, username: str) -> dict | None:
    row = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    return _row_user(row) if row else None


# ---------------------------------------------------------------- 初始化种子


def init_auth(conn: sqlite3.Connection) -> None:
    """幂等种子：认证源配置与初始账号；管理员权限恒定为全部模块 + 全部范围。"""
    now = db.now()
    conn.execute(
        "INSERT OR IGNORE INTO auth_sources(key,enabled,config) VALUES(?,?,?)",
        (SOURCE_LOCAL, 1, json.dumps(DEFAULT_LOCAL_CONFIG, ensure_ascii=False)),
    )
    for key, cfg in ((SOURCE_LDAP, DEFAULT_LDAP_CONFIG), (SOURCE_SSO, DEFAULT_SSO_CONFIG)):
        # 默认开启「演示模式」，让 LDAP / SSO 入口开箱可用；管理员可随时关闭或改接真实服务器
        conn.execute(
            "INSERT OR IGNORE INTO auth_sources(key,enabled,config) VALUES(?,?,?)",
            (key, 1, json.dumps(cfg, ensure_ascii=False)),
        )
    if conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0:
        conn.execute(
            "INSERT INTO users(username,display_name,email,role,source,password_hash,enabled,"
            "modules,scopes,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            ("admin", "系统管理员", "admin@ipam.local", ROLE_ADMIN, SOURCE_LOCAL,
             hash_password("Admin@123"), 1, json.dumps(MODULE_KEYS), "[]", now),
        )
        # viewer 是演示用的只读账号，纯净 / 生产模式只保留 admin
        if db.demo_seed_enabled():
            conn.execute(
                "INSERT INTO users(username,display_name,email,role,source,password_hash,enabled,"
                "modules,scopes,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                ("viewer", "只读观察员", "viewer@ipam.local", ROLE_VIEWER, SOURCE_LOCAL,
                 hash_password("Viewer@123"), 1,
                 json.dumps(DEFAULT_VIEWER_MODULES), json.dumps(DEFAULT_VIEWER_SCOPES), now),
            )
    # 幂等修正：管理员不允许被限定到局部 CIDR，历史数据统一回落为「全部地址范围」
    conn.execute("UPDATE users SET scopes='[]' WHERE role=? AND scopes <> '[]'", (ROLE_ADMIN,))
    conn.execute("UPDATE users SET modules=? WHERE role=? AND modules <> ?",
                 (json.dumps(MODULE_KEYS), ROLE_ADMIN, json.dumps(MODULE_KEYS)))
    conn.commit()


# ---------------------------------------------------------------- 认证源配置


def get_source(conn: sqlite3.Connection, key: str) -> dict:
    if key == SOURCE_LOCAL:
        return {"key": key, "enabled": True, "config": dict(DEFAULT_LOCAL_CONFIG)}
    row = conn.execute("SELECT * FROM auth_sources WHERE key=?", (key,)).fetchone()
    if not row:
        raise LookupError(f"未知认证源：{key}")
    cfg = dict(row)
    try:
        cfg["config"] = json.loads(cfg["config"] or "{}")
    except ValueError:
        cfg["config"] = {}
    # 启用状态只以 auth_sources.enabled 列为准，避免配置里出现同名字段造成二义
    cfg["config"].pop("enabled", None)
    cfg["enabled"] = bool(cfg["enabled"])
    return cfg


SECRET_MASK = "********"


def mask_source(src: dict) -> dict:
    """管理接口回显配置时隐藏密钥；保存时遇到掩码值会保留原值。"""
    out = dict(src)
    cfg = dict(src.get("config") or {})
    for field in ("bind_password", "client_secret"):
        if cfg.get(field):
            cfg[field] = SECRET_MASK
    if isinstance(cfg.get("demo_users"), list):
        cfg["demo_users"] = [
            {**u, "password": SECRET_MASK if u.get("password") else ""}
            for u in cfg["demo_users"] if isinstance(u, dict)
        ]
    out["config"] = cfg
    return out


def public_sources(conn: sqlite3.Connection) -> dict:
    ldap = get_source(conn, SOURCE_LDAP)
    sso = get_source(conn, SOURCE_SSO)
    return {
        "local": {"enabled": True, "label": "本地账号"},
        "ldap": {"enabled": ldap["enabled"], "label": ldap["config"].get("label", "LDAP / AD 目录"),
                 "demo_mode": bool(ldap["config"].get("demo_mode"))},
        "sso": {"enabled": sso["enabled"], "label": sso["config"].get("provider", "企业统一身份认证"),
                "demo_mode": bool(sso["config"].get("demo_mode"))},
    }


def save_source(conn: sqlite3.Connection, key: str, payload: dict, actor: str) -> dict:
    if key not in (SOURCE_LDAP, SOURCE_SSO):
        raise ValueError("本地账号认证不能关闭，也不支持修改配置")
    current = get_source(conn, key)
    incoming = dict(payload.get("config") or {})
    for field in ("bind_password", "client_secret"):
        if incoming.get(field) == SECRET_MASK:
            incoming.pop(field)
    if isinstance(incoming.get("demo_users"), list):
        old_users = {u.get("username"): u for u in current["config"].get("demo_users", [])}
        merged = []
        for u in incoming["demo_users"]:
            if not isinstance(u, dict):
                continue
            item = dict(u)
            if item.get("password") == SECRET_MASK:
                item["password"] = (old_users.get(item.get("username")) or {}).get("password", "")
            merged.append(item)
        incoming["demo_users"] = merged
    cfg = {**current["config"], **incoming}
    for field in ("default_modules", "default_scopes"):
        if field in cfg:
            cfg[field] = (normalize_modules(cfg[field], ROLE_VIEWER) if field == "default_modules"
                          else normalize_scopes(cfg[field]))
    if key == SOURCE_SSO and not cfg.get("demo_mode"):
        for field in ("issuer", "client_id", "client_secret", "redirect_uri"):
            if not str(cfg.get(field) or "").strip():
                raise ValueError(f"真实 OIDC 模式需要填写 {field}")
    if key == SOURCE_LDAP and not cfg.get("demo_mode"):
        for field in ("server_url", "base_dn", "bind_dn", "user_filter"):
            if not str(cfg.get(field) or "").strip():
                raise ValueError(f"真实 LDAP 模式需要填写 {field}")
        if "{username}" not in str(cfg.get("user_filter")):
            raise ValueError("user_filter 必须包含 {username} 占位符")
    enabled = bool(payload.get("enabled", current["enabled"]))
    conn.execute("UPDATE auth_sources SET enabled=?, config=? WHERE key=?",
                 (int(enabled), json.dumps(cfg, ensure_ascii=False), key))
    db.audit(conn, "auth.source.update", None,
             f"{actor} 更新认证源 {key}：启用={enabled}")
    conn.commit()
    result = get_source(conn, key)
    result["enabled"] = enabled
    return result


def test_source(conn: sqlite3.Connection, key: str) -> dict:
    src = get_source(conn, key)
    cfg = src["config"]
    if cfg.get("demo_mode"):
        count = len(cfg.get("demo_users") or []) if key == SOURCE_LDAP else 1
        return {"ok": True, "mode": "demo",
                "detail": f"演示模式可用：内置{'目录账号 ' + str(count) + ' 个' if key == SOURCE_LDAP else '模拟 IdP'}"}
    if key == SOURCE_LDAP:
        url = str(cfg.get("server_url") or "")
        parsed = urllib.parse.urlparse(url if "://" in url else "ldap://" + url)
        host, port = parsed.hostname, parsed.port or (636 if parsed.scheme == "ldaps" else 389)
        if not host:
            raise ValueError("LDAP 服务器地址无效")
        try:
            with socket.create_connection((host, port), timeout=3):
                pass
        except OSError as exc:
            raise ValueError(f"无法连接 {host}:{port}（{exc}）") from exc
        try:
            import ldap3  # noqa: F401
            driver = "ldap3 已安装"
        except ImportError:
            driver = "ldap3 未安装，请执行 pip install ldap3"
        return {"ok": True, "mode": "live", "detail": f"TCP 连通 {host}:{port} · {driver}"}
    doc = oidc_discovery(str(cfg.get("issuer") or ""))
    return {"ok": True, "mode": "live",
            "detail": f"OIDC 发现成功：{doc.get('authorization_endpoint', '授权端点已返回')}"}


# ---------------------------------------------------------------- 本地认证


def authenticate_local(conn: sqlite3.Connection, username: str, password: str) -> dict:
    row = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    if not row or row["source"] != SOURCE_LOCAL:
        raise ValueError("用户名或密码错误")
    u = _row_user(row)
    if not u["enabled"]:
        raise ValueError("账号已停用，请联系管理员")
    if u.get("locked_until") and u["locked_until"] > db.now():
        raise ValueError(f"账号已锁定，请在 {u['locked_until']} 后重试")
    if not verify_password(password, u.get("password_hash")):
        attempts = int(u.get("failed_attempts") or 0) + 1
        locked = dt(LOCK_MINUTES) if attempts >= LOCK_THRESHOLD else None
        conn.execute("UPDATE users SET failed_attempts=?, locked_until=? WHERE username=?",
                     (attempts, locked, u["username"]))
        db.audit(conn, "auth.login.failed", None, f"账号 {u['username']} 登录失败（第 {attempts} 次）")
        conn.commit()
        left = max(0, LOCK_THRESHOLD - attempts)
        raise ValueError("账号已锁定 5 分钟" if locked else f"用户名或密码错误（剩余 {left} 次尝试）")
    return u


def external_username(raw: str) -> str:
    text = re.sub(r"[^A-Za-z0-9._-]", "_", (raw or "").strip())[:32]
    return text if len(text) >= 3 else f"ext_{secrets.token_hex(4)}"


def upsert_external_user(conn: sqlite3.Connection, source: str, username: str,
                         display_name: str, email: str, cfg: dict) -> dict:
    name = external_username(username)
    row = conn.execute("SELECT * FROM users WHERE username=?", (name,)).fetchone()
    if not row:
        conn.execute(
            "INSERT INTO users(username,display_name,email,role,source,password_hash,enabled,"
            "modules,scopes,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (name, display_name or name, email or None, ROLE_VIEWER, source, None, 1,
             json.dumps(normalize_modules(cfg.get("default_modules"), ROLE_VIEWER)),
             json.dumps(normalize_scopes(cfg.get("default_scopes"))), db.now()),
        )
        db.audit(conn, "auth.user.auto", None, f"外部认证首次登录自动建号：{name}（{source}，只读）")
        conn.commit()
    user = get_user(conn, name)
    if not user["enabled"]:
        raise ValueError("该账号已停用，请联系管理员")
    return user


def ldap_authenticate(conn: sqlite3.Connection, username: str, password: str) -> dict:
    src = get_source(conn, SOURCE_LDAP)
    if not src["enabled"]:
        raise ValueError("LDAP 认证未启用")
    cfg = src["config"]
    name = (username or "").strip()
    if not name or not password:
        raise ValueError("请输入域账号和密码")
    if cfg.get("demo_mode"):
        hit = next((u for u in cfg.get("demo_users") or []
                    if u.get("username") == name and u.get("password") == password), None)
        if not hit:
            raise ValueError("目录账号或密码错误（演示目录）")
        return upsert_external_user(conn, SOURCE_LDAP, name,
                                    hit.get("display_name", name), hit.get("email"), cfg)
    try:
        import ldap3
        from ldap3.utils.conv import escape_filter_chars
    except ImportError as exc:
        raise ValueError("LDAP 驱动未安装，请执行 .venv/bin/pip install ldap3") from exc
    url = str(cfg.get("server_url") or "")
    tls = bool(cfg.get("use_tls")) or url.startswith("ldaps://")
    try:
        server = ldap3.Server(url, use_ssl=tls, connect_timeout=5)
        service = ldap3.Connection(server, user=cfg.get("bind_dn") or None,
                                   password=cfg.get("bind_password") or None,
                                   auto_bind=True, receive_timeout=5)
        user_filter = str(cfg.get("user_filter") or "(uid={username})").format(
            username=escape_filter_chars(name))
        attrs = [str(cfg.get("display_name_attr") or "cn"), str(cfg.get("email_attr") or "mail")]
        service.search(cfg.get("base_dn"), user_filter, attributes=attrs)
        if not service.entries:
            raise ValueError("目录中没有该用户")
        entry = service.entries[0]
        user_conn = ldap3.Connection(server, user=entry.entry_dn, password=password,
                                     auto_bind=True, receive_timeout=5)
        user_conn.unbind()
        service.unbind()

        def attr(key: str) -> str:
            try:
                value = entry[key].value
                return str(value) if value else ""
            except Exception:
                return ""

        return upsert_external_user(conn, SOURCE_LDAP, name,
                                    attr("cn") or name, attr("mail"), cfg)
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError(f"LDAP 认证失败：{exc}") from exc


# ---------------------------------------------------------------- SSO / OIDC


def oidc_discovery(issuer: str) -> dict:
    url = issuer.rstrip("/") + "/.well-known/openid-configuration"
    try:
        with urllib.request.urlopen(url, timeout=6) as resp:
            doc = json.load(resp)
    except (urllib.error.URLError, ValueError, TimeoutError) as exc:
        raise ValueError(f"OIDC 发现文档不可用：{exc}") from exc
    for field in ("authorization_endpoint", "token_endpoint", "userinfo_endpoint"):
        if not doc.get(field):
            raise ValueError(f"OIDC 发现文档缺少 {field}")
    return doc


def _save_state(conn: sqlite3.Connection, state: str, mode: str,
                verifier: str | None = None, nonce: str | None = None) -> None:
    conn.execute("DELETE FROM sso_states WHERE expires_at < ?", (db.now(),))
    conn.execute(
        "INSERT INTO sso_states(state,mode,code_verifier,nonce,redirect_to,created_at,expires_at) "
        "VALUES(?,?,?,?,?,?,?)",
        (state, mode, verifier, nonce, "/#dashboard", db.now(), dt(10)),
    )
    conn.commit()


def _consume_state(conn: sqlite3.Connection, state: str) -> dict:
    row = conn.execute("SELECT * FROM sso_states WHERE state=?", (state,)).fetchone()
    if not row or row["expires_at"] < db.now():
        raise ValueError("SSO 会话已过期，请重新发起登录")
    conn.execute("DELETE FROM sso_states WHERE state=?", (state,))
    conn.commit()
    return dict(row)


def sso_start(conn: sqlite3.Connection) -> dict:
    src = get_source(conn, SOURCE_SSO)
    if not src["enabled"]:
        raise ValueError("SSO 认证未启用，请在「用户与权限 → 认证源配置」中开启")
    cfg = src["config"]
    state = secrets.token_urlsafe(24)
    if cfg.get("demo_mode"):
        _save_state(conn, state, "demo")
        return {"mode": "demo", "state": state,
                "authorize_url": "/api/auth/sso/demo/authorize?state=" + urllib.parse.quote(state)}
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    nonce = secrets.token_urlsafe(20)
    doc = oidc_discovery(str(cfg.get("issuer") or ""))
    params = {
        "response_type": "code", "client_id": str(cfg.get("client_id") or ""),
        "redirect_uri": str(cfg.get("redirect_uri") or ""),
        "scope": str(cfg.get("scope") or "openid profile email"),
        "state": state, "nonce": nonce,
        "code_challenge": challenge, "code_challenge_method": "S256",
    }
    _save_state(conn, state, "oidc", verifier, nonce)
    return {"mode": "oidc", "state": state,
            "authorize_url": doc["authorization_endpoint"] + "?" + urllib.parse.urlencode(params)}


def demo_authorize_page(state: str, provider: str) -> str:
    """内置模拟 IdP 授权页：未配置真实 OIDC 时也能完整走一遍跳转 → 回调 → 建会话。"""
    safe_state = html.escape(state, quote=True)
    safe_provider = html.escape(provider or "企业统一身份认证")
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{safe_provider} · 模拟 IdP</title>
<style>
*{{box-sizing:border-box}}body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#F5F7FA;
font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:#1B2430}}
.card{{width:400px;max-width:92vw;background:#fff;border:1px solid #E6EAF0;border-radius:14px;
padding:30px;box-shadow:0 12px 40px rgba(16,24,40,.09)}}
.tag{{display:inline-block;background:#E6F1FB;color:#0C447C;border-radius:6px;padding:3px 9px;font-size:11px}}
h1{{font-size:19px;margin:14px 0 6px}}p{{color:#5B6879;font-size:12px;margin:0 0 20px;line-height:1.7}}
label{{display:block;font-size:12px;color:#5B6879;margin:12px 0 5px}}
input{{width:100%;height:38px;border:1px solid #D9E0EA;border-radius:8px;padding:0 11px;font-size:13px}}
button{{width:100%;height:40px;margin-top:22px;border:0;border-radius:8px;background:#185FA5;color:#fff;
font-size:13px;font-weight:600;cursor:pointer}}
.note{{margin-top:16px;font-size:11px;color:#93A0B0;line-height:1.7}}
</style></head><body>
<form class="card" method="post" action="/api/auth/sso/demo/consent">
  <span class="tag">SSO 演示模式 · 模拟身份提供商</span>
  <h1>{safe_provider}</h1>
  <p>这是内置的模拟 IdP 授权页，用于在没有真实身份提供商时验证完整的授权码流程。
     配置真实 OIDC 后，本页会由企业 IdP 的登录页替代。</p>
  <input type="hidden" name="state" value="{safe_state}">
  <label>企业账号</label><input name="username" value="sso.user" required>
  <label>显示名</label><input name="display_name" value="单点登录用户">
  <label>邮箱</label><input name="email" value="sso.user@example.com">
  <button type="submit">同意授权并登录 IPAM</button>
  <div class="note">首次登录将自动创建只读用户，可见模块与地址范围由管理员分配。</div>
</form></body></html>"""


def demo_consent(conn: sqlite3.Connection, state: str, username: str,
                 display_name: str, email: str) -> dict:
    st = _consume_state(conn, state)
    if st["mode"] != "demo":
        raise ValueError("该 SSO 会话不是演示模式")
    cfg = get_source(conn, SOURCE_SSO)["config"]
    return upsert_external_user(conn, SOURCE_SSO, username, display_name, email, cfg)


def oidc_callback(conn: sqlite3.Connection, code: str, state: str) -> dict:
    st = _consume_state(conn, state)
    if st["mode"] != "oidc":
        raise ValueError("该 SSO 会话不是 OIDC 模式")
    cfg = get_source(conn, SOURCE_SSO)["config"]
    doc = oidc_discovery(str(cfg.get("issuer") or ""))
    body = urllib.parse.urlencode({
        "grant_type": "authorization_code", "code": code,
        "redirect_uri": str(cfg.get("redirect_uri") or ""),
        "client_id": str(cfg.get("client_id") or ""),
        "client_secret": str(cfg.get("client_secret") or ""),
        "code_verifier": st.get("code_verifier") or "",
    }).encode()
    try:
        req = urllib.request.Request(doc["token_endpoint"], data=body,
                                     headers={"Content-Type": "application/x-www-form-urlencoded"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            token = json.load(resp)
        req = urllib.request.Request(doc["userinfo_endpoint"],
                                     headers={"Authorization": "Bearer " + str(token.get("access_token") or "")})
        with urllib.request.urlopen(req, timeout=8) as resp:
            info = json.load(resp)
    except (urllib.error.URLError, ValueError, TimeoutError) as exc:
        raise ValueError(f"OIDC 令牌交换失败：{exc}") from exc
    email = str(info.get("email") or "")
    username = str(info.get("preferred_username") or info.get("sub") or email.split("@")[0])
    display = str(info.get("name") or username)
    return upsert_external_user(conn, SOURCE_SSO, username, display, email, cfg)


# ---------------------------------------------------------------- 会话管理


def create_session(conn: sqlite3.Connection, username: str, source: str,
                   user_agent: str = "") -> str:
    token = secrets.token_urlsafe(32)
    now = db.now()
    conn.execute("INSERT INTO sessions(token,username,source,created_at,expires_at,last_seen,user_agent) "
                 "VALUES(?,?,?,?,?,?,?)",
                 (token, username, source, now, dt(SESSION_HOURS * 60), now, user_agent[:180]))
    conn.execute("UPDATE users SET last_login_at=?, failed_attempts=0, locked_until=NULL "
                 "WHERE username=?", (now, username))
    db.audit(conn, "auth.login", None, f"{username} 通过 {source} 登录成功")
    conn.commit()
    return token


def resolve_session(token: str | None) -> dict | None:
    if not token:
        return None
    conn = db.connect()
    try:
        row = conn.execute("SELECT * FROM sessions WHERE token=?", (token,)).fetchone()
        if not row:
            return None
        if row["expires_at"] < db.now():
            conn.execute("DELETE FROM sessions WHERE token=?", (token,))
            conn.commit()
            return None
        u = conn.execute("SELECT * FROM users WHERE username=?", (row["username"],)).fetchone()
        if not u or not u["enabled"]:
            return None
        # 降低写频率：距上次活跃超过 1 分钟才刷新
        if (datetime.datetime.now() - datetime.datetime.strptime(
                row["last_seen"], "%Y-%m-%d %H:%M:%S")).total_seconds() > 60:
            conn.execute("UPDATE sessions SET last_seen=? WHERE token=?", (db.now(), token))
            conn.commit()
        user = _row_user(u)
        user["session_source"] = row["source"]
        user["token"] = token
        return user
    finally:
        conn.close()


def destroy_session(token: str | None, username: str | None = None) -> None:
    if not token:
        return
    conn = db.connect()
    try:
        conn.execute("DELETE FROM sessions WHERE token=?", (token,))
        if username:
            db.audit(conn, "auth.logout", None, f"{username} 退出登录")
        conn.commit()
    finally:
        conn.close()


def active_sessions(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        "SELECT s.username, s.source, s.created_at, s.last_seen, s.expires_at, u.display_name "
        "FROM sessions s LEFT JOIN users u ON u.username=s.username "
        "WHERE s.expires_at > ? ORDER BY s.last_seen DESC", (db.now(),)).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------- 用户管理


def list_users(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute("SELECT * FROM users ORDER BY created_at, username").fetchall()
    return [public_user(_row_user(r)) for r in rows]


def create_user(conn: sqlite3.Connection, payload: dict, actor: str) -> dict:
    username = validate_username(str(payload.get("username") or ""))
    if get_user(conn, username):
        raise ValueError(f"用户名 {username} 已存在")
    role = str(payload.get("role") or ROLE_VIEWER)
    if role not in (ROLE_ADMIN, ROLE_VIEWER):
        raise ValueError("角色只能是 admin 或 viewer")
    password = validate_password(str(payload.get("password") or ""))
    display = str(payload.get("display_name") or username).strip()[:64]
    modules = normalize_modules(payload.get("modules"), role)
    scopes = normalize_role_scopes(payload.get("scopes"), role)
    conn.execute(
        "INSERT INTO users(username,display_name,email,role,source,password_hash,enabled,"
        "modules,scopes,must_change_password,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        (username, display, str(payload.get("email") or "").strip() or None, role, SOURCE_LOCAL,
         hash_password(password), int(bool(payload.get("enabled", True))),
         json.dumps(modules), json.dumps(scopes),
         int(bool(payload.get("must_change_password"))), db.now()),
    )
    db.audit(conn, "auth.user.create", None,
             f"{actor} 创建用户 {username}（{role}），模块 {len(modules)} 个 / 范围 "
             + ("全部（不限）" if role == ROLE_ADMIN else f"{len(scopes)} 个"))
    conn.commit()
    return public_user(get_user(conn, username))


def update_user(conn: sqlite3.Connection, username: str, payload: dict, actor: str) -> dict:
    u = get_user(conn, username)
    if not u:
        raise LookupError(f"用户 {username} 不存在")
    role = str(payload.get("role", u["role"]))
    if role not in (ROLE_ADMIN, ROLE_VIEWER):
        raise ValueError("角色只能是 admin 或 viewer")
    enabled = bool(payload.get("enabled", u["enabled"]))
    if username == actor and (role != ROLE_ADMIN or not enabled):
        raise ValueError("不能停用自己或取消自己的管理员角色")
    if u["role"] == ROLE_ADMIN and (role != ROLE_ADMIN or not enabled):
        count = conn.execute(
            "SELECT COUNT(*) FROM users WHERE role=? AND enabled=1", (ROLE_ADMIN,)).fetchone()[0]
        if count <= 1:
            raise ValueError("系统必须保留至少一个启用状态的管理员")
    display = str(payload.get("display_name", u["display_name"])).strip()[:64] or username
    modules = normalize_modules(payload.get("modules", u["modules"]), role)
    scopes = normalize_role_scopes(payload.get("scopes", u["scopes"]), role)
    email = str(payload.get("email", u.get("email") or "") or "").strip() or None
    must_change = bool(payload.get("must_change_password", u["must_change_password"]))
    new_pw = payload.get("password")
    password_hash = u.get("password_hash")
    if new_pw:
        password_hash = hash_password(validate_password(str(new_pw)))
        conn.execute("DELETE FROM sessions WHERE username=?", (username,))
    if not enabled:
        conn.execute("DELETE FROM sessions WHERE username=?", (username,))
    conn.execute(
        "UPDATE users SET display_name=?, email=?, role=?, enabled=?, modules=?, scopes=?, "
        "must_change_password=?, password_hash=?, failed_attempts=0, locked_until=NULL WHERE username=?",
        (display, email, role, int(enabled), json.dumps(modules), json.dumps(scopes),
         int(must_change), password_hash, username),
    )
    db.audit(conn, "auth.user.update", None,
             f"{actor} 更新用户 {username}（{role}），模块 {len(modules)} 个 / 范围 "
             + ("全部（不限）" if role == ROLE_ADMIN else f"{len(scopes)} 个")
             + ("，重置密码" if new_pw else ""))
    conn.commit()
    return public_user(get_user(conn, username))


def delete_user(conn: sqlite3.Connection, username: str, actor: str) -> dict:
    u = get_user(conn, username)
    if not u:
        raise LookupError(f"用户 {username} 不存在")
    if username == actor:
        raise ValueError("不能删除当前登录的账号")
    if u["role"] == ROLE_ADMIN:
        count = conn.execute(
            "SELECT COUNT(*) FROM users WHERE role=? AND enabled=1", (ROLE_ADMIN,)).fetchone()[0]
        if count <= 1:
            raise ValueError("系统必须保留至少一个启用状态的管理员")
    conn.execute("DELETE FROM sessions WHERE username=?", (username,))
    conn.execute("DELETE FROM users WHERE username=?", (username,))
    db.audit(conn, "auth.user.delete", None, f"{actor} 删除用户 {username}")
    conn.commit()
    return {"username": username, "deleted": True}


def change_own_password(conn: sqlite3.Connection, username: str, old: str, new: str) -> dict:
    u = get_user(conn, username)
    if not u or not verify_password(old, u.get("password_hash")):
        raise ValueError("原密码不正确")
    validate_password(new)
    conn.execute("UPDATE users SET password_hash=?, must_change_password=0 WHERE username=?",
                 (hash_password(new), username))
    db.audit(conn, "auth.password.change", None, f"{username} 修改了自己的密码")
    conn.commit()
    return {"ok": True}


# ---------------------------------------------------------------- 授权判定


def module_for(path: str) -> str | None:
    if path in NO_MODULE_CHECK:
        return None
    if path.startswith("/api/auth/admin"):
        return "users"
    for prefixes, key in PATH_MODULE_RULES:
        if any(path == p or path.startswith(p + "/") for p in prefixes):
            return key
    return "core"


def allowed_module(user: dict, module: str | None) -> bool:
    if user["role"] == ROLE_ADMIN:
        return True
    if module in (None, "core"):
        # 核心地址 API 是各页面的公共数据源，响应会按 CIDR 范围过滤
        return True
    if module == "users":
        return False
    return module in user["modules"]


def is_public(path: str) -> bool:
    return path in PUBLIC_EXACT or any(path.startswith(p) for p in PUBLIC_PREFIXES)


def set_current(user: dict, scopes: list[str]) -> None:
    _current.set((user, scopes))


def current_user() -> dict | None:
    ctx = _current.get()
    return ctx[0] if ctx else None


def current_scopes() -> list[str]:
    ctx = _current.get()
    return ctx[1] if ctx else []


def resolve_scopes(user: dict, header: str | None) -> list[str]:
    """管理员不限制；只读用户只能在被授权的 CIDR 集合中切换当前范围。"""
    if user["role"] == ROLE_ADMIN:
        return []
    allowed = user["scopes"]
    if not allowed:
        return []
    if not header or header in ("all", "全部"):
        return list(allowed)
    if header in allowed:
        return [header]
    # 只读用户可在被授权范围内手动收窄到某个更细的子网
    try:
        chosen = ipaddress.ip_network(header, strict=False)
    except ValueError:
        return list(allowed)
    for parent in _nets(allowed):
        if isinstance(chosen, ipaddress.IPv4Network) and chosen.subnet_of(parent):
            return [str(chosen)]
    return list(allowed)


def _nets(scopes: list[str]) -> list[ipaddress.IPv4Network]:
    """解析 scope 的 CIDR 部分（不做 VRF 过滤），用于 resolve_scopes 收窄判断。"""
    out = []
    for text in scopes:
        _, cidr_text = split_scope(text)
        try:
            net = ipaddress.ip_network(cidr_text, strict=False)
            if isinstance(net, ipaddress.IPv4Network):
                out.append(net)
        except ValueError:
            continue
    return out


def plain_cidrs(scopes: list[str], vrf: str | None = None) -> list[str]:
    """返回对指定 VRF 生效的纯 CIDR 列表，供 SQL 层过滤（db.list_ips / 资产）。"""
    plane = vrf or db.current_vrf()
    out = []
    for text in scopes:
        scope_vrf, cidr_text = split_scope(text)
        if scope_vrf is None or scope_vrf == plane or plane == db.ALL_VRFS:
            out.append(cidr_text)
    return out


def _active_scopes(scopes: list[str], item_vrf: str | None = None,
                   vrf: str | None = None) -> list[ipaddress.IPv4Network] | None:
    """带 VRF 前缀的授权只对该平面生效；纯 CIDR 授权对所有平面生效。

    返回 None = 不限制（管理员 / 未配置范围）；返回空列表 = 该平面无任何授权，一律拒绝。
    """
    if not scopes:
        return None
    plane = vrf or db.current_vrf()
    target = item_vrf or plane
    active = [cidr_text for text in scopes
              for scope_vrf, cidr_text in [split_scope(text)]
              if scope_vrf is None or scope_vrf == target or plane == db.ALL_VRFS]
    return _nets(active)


def addr_visible(addr: str | None, scopes: list[str], vrf: str | None = None,
                 item_vrf: str | None = None) -> bool:
    nets = _active_scopes(scopes, item_vrf, vrf)
    if nets is None:
        return True
    if not nets:
        return False
    if not addr:
        return True
    try:
        value = ipaddress.IPv4Address(str(addr).split("/")[0])
    except ValueError:
        return True
    return any(value in net for net in nets)


def cidr_visible(cidr: str | None, scopes: list[str], vrf: str | None = None,
                 item_vrf: str | None = None) -> bool:
    nets = _active_scopes(scopes, item_vrf, vrf)
    if nets is None:
        return True
    if not nets:
        return False
    if not cidr:
        return True
    try:
        net = ipaddress.ip_network(str(cidr), strict=False)
    except ValueError:
        return True
    return any(net.overlaps(s) for s in nets)


def request_target_visible(query: urllib.parse.MultiDict | dict, scopes: list[str],
                           vrf: str | None = None) -> bool:
    """地址位图 / 手动预检等请求参数指向范围外的地址时直接拒绝。"""
    if not scopes:
        return True
    cidr = query.get("cidr") if hasattr(query, "get") else None
    addr = query.get("addr") if hasattr(query, "get") else None
    if cidr and not cidr_visible(str(cidr), scopes, vrf):
        return False
    if addr and not addr_visible(str(addr), scopes, vrf):
        return False
    return True


def _filter_item(item: Any, scopes: list[str], vrf: str | None = None) -> bool:
    if not isinstance(item, dict):
        return True
    item_vrf = item.get("vrf") if isinstance(item.get("vrf"), str) else None
    if item.get("addr") is not None:
        return addr_visible(str(item["addr"]), scopes, vrf, item_vrf)
    for key in ("cidr", "prefix_cidr", "key"):
        value = item.get(key)
        if isinstance(value, str) and "/" in value:
            return cidr_visible(value, scopes, vrf, item_vrf)
    return True


def _trim_nested_prefixes(item: Any, scopes: list[str], vrf: str | None = None) -> Any:
    if not isinstance(item, dict):
        return item
    out = dict(item)
    item_vrf = out.get("vrf") if isinstance(out.get("vrf"), str) else None
    if isinstance(out.get("prefixes"), list):
        out["prefixes"] = [p for p in out["prefixes"]
                           if not isinstance(p, str) or cidr_visible(p, scopes, vrf, item_vrf)]
    if isinstance(out.get("prefix_names"), dict):
        out["prefix_names"] = {k: v for k, v in out["prefix_names"].items()
                               if cidr_visible(str(k), scopes, vrf, item_vrf)}
    return out


def filter_response(path: str, data: dict, scopes: list[str],
                    vrf: str | None = None) -> dict:
    """按 (VRF, CIDR) 可见范围裁剪 JSON 响应中的地址、前缀、报表与工单行。"""
    if not scopes or not isinstance(data, dict):
        return data
    out = dict(data)
    for key, value in list(out.items()):
        if isinstance(value, list):
            out[key] = [_trim_nested_prefixes(x, scopes, vrf) for x in value
                        if _filter_item(x, scopes, vrf)]
    pool = out.get("pool")
    if isinstance(pool, dict) and not addr_visible(
            pool.get("addr"), scopes, vrf, pool.get("vrf")):
        out["pool"] = None
    out["scope_limited"] = True
    out["visible_scopes"] = scopes
    return out


def scope_dashboard(data: dict, scopes: list[str], vrf: str | None = None) -> dict:
    """只读用户看板：按当前 VRF 平面内可见子网重算容量指标。"""
    if not scopes:
        return data
    plane = vrf or db.current_vrf()
    conn = db.connect()
    try:
        prefixes = db.list_prefixes(conn, plane)
        subnets = [p for p in prefixes if p.get("kind") == "subnet"
                   and cidr_visible(p.get("cidr"), scopes, plane, p.get("vrf"))]
        total = sum(int(p.get("total") or 0) for p in subnets)
        retained = sum(int(p.get("retained") or 0) for p in subnets)
        occupied = sum(int(p.get("occupied") or 0) for p in subnets)
        reserved = sum(int(p.get("reserved") or 0) for p in subnets)
        free = sum(int(p.get("free") or 0) for p in subnets)
        usable = max(1, total - retained)
        status: dict[str, int] = {}
        for p in subnets:
            for row in conn.execute(
                    "SELECT status, COUNT(*) AS n FROM ip_addresses "
                    "WHERE prefix_cidr=? AND vrf=? GROUP BY status",
                    (p["cidr"], p["vrf"])):
                status[row["status"]] = status.get(row["status"], 0) + row["n"]
    finally:
        conn.close()
    out = dict(data)
    out.update({
        "total": total, "retained": retained, "occupied": occupied,
        "reserved": reserved, "free": free,
        "util": round((occupied - reserved) / usable * 100, 1),
        "subnet_count": len(subnets), "status": status,
        "scope_limited": True, "visible_scopes": scopes,
    })
    return out
