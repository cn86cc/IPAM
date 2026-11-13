"""IPAM HTTP API：地址空间树、分配回收、看板、治理与对账、工单、集成与设置。

01 接入层：统一鉴权中间件 + 本地 / LDAP / SSO 认证与用户权限管理。
"""
from __future__ import annotations

import json
import re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal
from urllib.parse import parse_qs, quote

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict

from . import assets, auth, db, device_roles, domain, extended, ip_admin, prefix_admin


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.init_db()
    yield


app = FastAPI(title="IPAM API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------- 01 层：统一鉴权
# 全局配置类写操作与物理拓扑操作不属于任何地址平面，汇总视图下依然允许。
_PLANE_WRITE_EXEMPT = (
    "/api/auth/", "/api/settings", "/api/vrfs", "/api/pages/",
    "/api/assets/device-roles", "/api/assets/racks/", "/api/assets/locations/",
    "/api/subnets/plan",  # 纯计算试算，不落库
    "/api/maintenance/snapshot",  # 维护任务：按平面（或全部平面）采样，本身不属于某个平面
)
# 地址域写操作：前缀、地址、子网、工单、发现/对账、维护任务。
_PLANE_WRITE_PREFIXES = (
    "/api/spaces", "/api/allocations", "/api/ips/", "/api/subnets",
    "/api/tickets", "/api/reconciliation/", "/api/integrations/",
    "/api/maintenance/",
)


def _is_plane_write(method: str, path: str) -> bool:
    """判断是否为「绑定具体地址平面」的写操作；'all' 汇总视图必须拒绝。"""
    if method in ("GET", "HEAD", "OPTIONS"):
        return False
    if path.startswith(_PLANE_WRITE_EXEMPT) or path.endswith("/toggle"):
        return False
    if path.startswith("/api/assets/"):
        # 资产里只有设备带地址归属；机柜 / 链路 / 位置是平面无关的物理资源
        return path.split("/")[3:4] == ["devices"]
    return path.startswith(_PLANE_WRITE_PREFIXES)


def _assert_plane(supplied: str | None = None) -> str:
    """校验并返回本次写操作唯一允许的地址平面（以请求上下文为准）。

    顶栏全局切换器（X-IPAM-VRF / ?vrf=）是当前地址平面的唯一准绳。历史版本
    允许 AllocationIn / TransitionIn / TicketIn / SubnetCommitIn 在请求体里自带
    vrf，领域层又优先采用该值，于是在「当前 = default」的会话中也能把数据写进
    vrf-prod，甚至写进字典里不存在的幽灵平面，绕过全局通道与可见范围授权。
    这里把「平面不一致 / 平面未定义 / 汇总视图写入」统一挡在落库之前。
    """
    plane = db.current_vrf()
    if plane == db.ALL_VRFS:
        raise HTTPException(
            status_code=400,
            detail="请先选择具体的 VRF 地址平面，不能在「全部 VRF」汇总视图下写操作")
    requested = str(supplied or "").strip()
    if requested and requested != plane:
        raise HTTPException(
            status_code=400,
            detail=f"请求体中的地址平面「{requested}」与当前平面「{plane}」不一致，"
                   "请先在顶栏切换地址平面后再提交")
    conn = db.connect()
    try:
        if conn.execute("SELECT 1 FROM vrfs WHERE name=?", (plane,)).fetchone() is None:
            raise HTTPException(
                status_code=400,
                detail=f"VRF 地址平面「{plane}」不存在，请先在「VRF 地址平面」页创建")
    finally:
        conn.close()
    return plane


def _bind_plane(payload: dict) -> dict:
    """地址域写请求统一丢弃请求体自带的 vrf，改用请求上下文的平面。"""
    plane = _assert_plane(payload.get("vrf"))
    return {**payload, "vrf": plane}


# 前端隐藏只是体验，后端中间件才是权限边界：未登录 401、越权 403、响应按可见范围裁剪。
@app.middleware("http")
async def auth_guard(request: Request, call_next):
    path = request.url.path
    # 当前地址平面：前端全局切换器写入 X-IPAM-VRF，也支持 ?vrf= 便于接口调试。
    # 通过 ContextVar 贯穿整个请求，所有领域层 SQL 都据此做 (vrf, ...) 隔离。
    vrf = (request.headers.get("x-ipam-vrf")
           or request.query_params.get("vrf") or "default").strip()
    if vrf != db.ALL_VRFS and not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", vrf):
        vrf = "default"
    db.set_current_vrf(vrf)
    if request.method == "OPTIONS" or not path.startswith("/api/") or auth.is_public(path):
        try:
            return await call_next(request)
        finally:
            db.set_current_vrf("default")

    token = request.cookies.get(auth.COOKIE_NAME)
    if not token:
        header = request.headers.get("authorization", "")
        if header.lower().startswith("bearer "):
            token = header[7:].strip()
    user = auth.resolve_session(token)
    if not user:
        db.set_current_vrf("default")
        return JSONResponse({"detail": "未登录或会话已过期，请重新登录"}, status_code=401)
    if path.startswith("/api/auth/admin") and user["role"] != auth.ROLE_ADMIN:
        db.set_current_vrf("default")
        return JSONResponse({"detail": "该操作需要管理员权限"}, status_code=403)
    # 「全部 VRF」只是跨平面对比视图：地址域写操作在这里统一拒绝，
    # 领域层各自的 _plane() 校验作为第二道防线，避免逐个路由漏判。
    if vrf == db.ALL_VRFS and _is_plane_write(request.method, path):
        db.set_current_vrf("default")
        return JSONResponse(
            {"detail": "请先选择具体的 VRF 地址平面，不能在「全部 VRF」汇总视图下写操作"},
            status_code=400)
    # 白名单：自身会话操作 + 纯计算不落库的子网规划（只读用户也能试算）
    writable_self = path in ("/api/auth/logout", "/api/auth/password", "/api/subnets/plan")
    if (request.method not in ("GET", "HEAD") and not writable_self
            and user["role"] != auth.ROLE_ADMIN):
        db.set_current_vrf("default")
        return JSONResponse({"detail": "只读用户不能执行写操作"}, status_code=403)
    module = auth.module_for(path)
    if not auth.allowed_module(user, module):
        db.set_current_vrf("default")
        return JSONResponse({"detail": "当前账号无权访问该模块"}, status_code=403)

    scopes = auth.resolve_scopes(user, request.headers.get("x-ipam-scope"))
    if scopes and not auth.request_target_visible(request.query_params, scopes, vrf):
        db.set_current_vrf("default")
        return JSONResponse({"detail": "目标地址不在当前可见范围内"}, status_code=403)
    auth.set_current(user, scopes)
    try:
        response = await call_next(request)
    finally:
        auth.set_current(None, [])
        db.set_current_vrf("default")

    if not scopes or not response.headers.get("content-type", "").startswith("application/json"):
        return response
    body = b""
    async for chunk in response.body_iterator:
        body += chunk
    headers = {k: v for k, v in response.headers.items()
               if k.lower() not in ("content-length", "content-type")}
    try:
        data = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        return Response(content=body, status_code=response.status_code, headers=headers,
                        media_type=response.media_type)
    if isinstance(data, dict):
        data = auth.filter_response(path, data, scopes, vrf)
        if path == "/api/dashboard":
            data = auth.scope_dashboard(data, scopes, vrf)
        if path in ("/api/spaces", "/api/ips", "/api/search"):
            data.setdefault("vrf", vrf)
        return JSONResponse(content=data, status_code=response.status_code, headers=headers)
    return Response(content=body, status_code=response.status_code, headers=headers,
                    media_type=response.media_type)


def _set_session_cookie(response: Response, token: str) -> Response:
    response.set_cookie(auth.COOKIE_NAME, token, httponly=True, samesite="lax",
                        path="/", max_age=auth.SESSION_HOURS * 3600)
    return response


class AllocationIn(BaseModel):
    """addr 为空 → 自动分配；有值 → 手动指定 IP。prefix 可传 auto 由后端按归属匹配。"""
    prefix: str = "auto"
    business: str = "未指定"
    owner: str = "—"
    hostname: str | None = None
    mode: Literal["assigned", "reserved"] = "assigned"
    addr: str | None = None
    vrf: str | None = None


class TransitionIn(BaseModel):
    action: Literal["confirm", "release", "reclaim", "resolve"]
    vrf: str | None = None


class IPUpdateIn(BaseModel):
    """地址记录行内编辑：只提交显式改动的描述性字段，状态变更必须走状态机。"""
    model_config = ConfigDict(extra="forbid")

    hostname: str | None = None
    business: str | None = None
    owner: str | None = None
    vlan: int | str | None = None


class SourceToggleIn(BaseModel):
    enabled: bool


class DiffResolveIn(BaseModel):
    action: Literal["register", "conflict", "reclaim", "ignore"]
    note: str = ""


class TicketIn(BaseModel):
    type: Literal["allocate", "release", "expand"]
    title: str = ""
    applicant: str = "—"
    business: str = "未指定"
    prefix_cidr: str | None = None
    addr: str | None = None
    vrf: str | None = None
    count: int = 1
    reason: str = ""


class TicketDecisionIn(BaseModel):
    decision: Literal["approve", "reject"]
    approver: str = "管理员"
    note: str = ""


class SubnetPlanIn(BaseModel):
    parent: str
    new_prefix: int = 24
    offset: int = 0
    limit: int = 0  # 0 = 一次列出可承载的全部子网（服务端上限 2000 行）
    vrf: str | None = None


class SubnetCommitIn(BaseModel):
    parent: str
    cidrs: list[str]
    name: str = ""
    vlan: int | None = None
    vrf: str | None = None


class PrefixUpdateIn(BaseModel):
    """只提交显式改动的字段；未提交的字段沿用现值（model_dump(exclude_unset=True)）。"""
    cidr: str | None = None
    parent_cidr: str | None = None
    name: str | None = None
    site: str | None = None
    vlan: int | str | None = None
    vrf: str | None = None
    description: str | None = None
    cascade_children: bool = False


class PrefixCreateIn(BaseModel):
    cidr: str
    parent_cidr: str | None = None
    kind: Literal["root", "aggregate", "subnet"] = "subnet"
    name: str = ""
    site: str | None = None
    vlan: int | str | None = None
    vrf: str | None = None
    description: str = ""


class VrfIn(BaseModel):
    name: str
    tenant: str = "未指定"
    description: str = ""
    # None / 留空 = 沿用系统全局阈值
    warn_threshold: float | None = None
    crit_threshold: float | None = None


class VrfUpdateIn(BaseModel):
    """只提交显式改动的字段；改名会同步该平面的全部地址记录与引用。"""
    name: str | None = None
    tenant: str | None = None
    description: str | None = None
    warn_threshold: float | None = None
    crit_threshold: float | None = None


class PageIn(BaseModel):
    """可自定义编辑的页面内容，blocks 为自由内容块列表。

    updated_by 不接受前端指定：由服务端从当前会话注入，保证审计主体真实。
    """
    title: str
    subtitle: str = ""
    blocks: list[dict] = []
    updated_by: str = ""


# ---- 01 接入层：认证与用户权限 ---------------------------------------------
class LoginIn(BaseModel):
    method: Literal["local", "ldap"] = "local"
    username: str
    password: str


class PasswordIn(BaseModel):
    old_password: str
    new_password: str


class UserCreateIn(BaseModel):
    username: str
    display_name: str = ""
    email: str = ""
    role: Literal["admin", "viewer"] = "viewer"
    password: str = ""
    enabled: bool = True
    modules: list[str] = []
    scopes: list[str] = []
    must_change_password: bool = False


class UserUpdateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    display_name: str | None = None
    email: str | None = None
    role: Literal["admin", "viewer"] | None = None
    password: str | None = None
    enabled: bool | None = None
    modules: list[str] | None = None
    scopes: list[str] | None = None
    must_change_password: bool | None = None


class SourceIn(BaseModel):
    enabled: bool = True
    config: dict = {}


def _sql_scopes() -> list[str] | None:
    """把 (vrf, CIDR) 授权转换成当前平面可用的纯 CIDR，供 SQL 层过滤。

    授权只针对其它 VRF 时返回不可匹配网段，避免空列表被误当成「不限制」。
    """
    scopes = auth.current_scopes()
    if not scopes:
        return None
    return auth.plain_cidrs(scopes, db.current_vrf()) or ["0.0.0.0/32"]


def _run(fn, *args, **kwargs):
    """统一的连接生命周期与异常映射：领域错误 → 400 / 404。"""
    conn = db.connect()
    try:
        return fn(conn, *args, **kwargs)
    except LookupError as exc:
        if isinstance(exc, (KeyError, IndexError)):
            raise  # 编程错误不应伪装成 404
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        conn.close()


@app.get("/api/health")
def health():
    return {"ok": True, "service": "ipam", "version": "0.1.0", "auth": True}


def _actor(request: Request) -> dict:
    user = auth.current_user() or auth.resolve_session(request.cookies.get(auth.COOKIE_NAME))
    if not user:
        raise HTTPException(status_code=401, detail="未登录或会话已过期")
    return user


def _sso_config() -> dict:
    conn = db.connect()
    try:
        return auth.get_source(conn, auth.SOURCE_SSO)["config"]
    finally:
        conn.close()


# ---- 01 接入层：登录 / 会话 / SSO / 用户与认证源管理 -------------------------
@app.get("/api/auth/sources/public")
def auth_sources_public():
    """登录页可见的认证方式（不含任何密钥与账号凭据）。"""
    return _run(auth.public_sources)


@app.post("/api/auth/login")
def auth_login(body: LoginIn, request: Request):
    conn = db.connect()
    try:
        if body.method == "local":
            user = auth.authenticate_local(conn, body.username.strip(), body.password)
            source = auth.SOURCE_LOCAL
        else:
            user = auth.ldap_authenticate(conn, body.username, body.password)
            source = auth.SOURCE_LDAP
        token = auth.create_session(conn, user["username"], source,
                                    request.headers.get("user-agent", ""))
    except ValueError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    finally:
        conn.close()
    return _set_session_cookie(
        JSONResponse({"user": auth.public_user(user), "session_hours": auth.SESSION_HOURS}),
        token,
    )


@app.post("/api/auth/logout")
def auth_logout(request: Request):
    token = request.cookies.get(auth.COOKIE_NAME)
    user = _actor(request)
    auth.destroy_session(token, user["username"])
    res = JSONResponse({"ok": True})
    res.delete_cookie(auth.COOKIE_NAME, path="/")
    return res


@app.get("/api/auth/me")
def auth_me(request: Request):
    user = _actor(request)
    # 系统设置的默认地址平面：前端在用户未手动切换过时据此初始化全局平面
    conn = db.connect()
    try:
        default_vrf = db.thresholds(conn)["default_vrf"]
    finally:
        conn.close()
    return {"user": auth.public_user(user), "modules": auth.MODULES,
            "scopes": auth.current_scopes() or auth.resolve_scopes(
                user, request.headers.get("x-ipam-scope")),
            "default_vrf": default_vrf,
            "session_source": user.get("session_source")}


@app.post("/api/auth/password")
def auth_password(body: PasswordIn, request: Request):
    user = _actor(request)
    return _run(auth.change_own_password, user["username"], body.old_password, body.new_password)


@app.get("/api/auth/sso/start")
def auth_sso_start():
    """返回 IdP 授权地址；演示模式返回内置模拟 IdP 页面。"""
    return _run(auth.sso_start)


@app.get("/api/auth/sso/demo/authorize")
def auth_sso_demo_authorize(state: str = ""):
    if not state:
        raise HTTPException(status_code=400, detail="缺少 state 参数")
    cfg = _sso_config()
    return HTMLResponse(auth.demo_authorize_page(state, str(cfg.get("provider") or "")))


@app.post("/api/auth/sso/demo/consent")
async def auth_sso_demo_consent(request: Request):
    form = parse_qs((await request.body()).decode("utf-8", errors="ignore"))
    get = lambda k: (form.get(k) or [""])[0]  # noqa: E731
    conn = db.connect()
    try:
        user = auth.demo_consent(conn, get("state"), get("username"),
                                 get("display_name"), get("email"))
        token = auth.create_session(conn, user["username"], auth.SOURCE_SSO, "demo-idp")
    except ValueError as exc:
        return RedirectResponse("/?auth_error=" + quote(str(exc)) + "#login", status_code=303)
    finally:
        conn.close()
    return _set_session_cookie(RedirectResponse("/#dashboard", status_code=303), token)


@app.get("/api/auth/sso/callback")
def auth_sso_callback(code: str = "", state: str = "", error: str = ""):
    if error or not code or not state:
        return RedirectResponse("/?auth_error=" + quote(error or "SSO 授权未完成") + "#login",
                                status_code=303)
    conn = db.connect()
    try:
        user = auth.oidc_callback(conn, code, state)
        token = auth.create_session(conn, user["username"], auth.SOURCE_SSO, "oidc")
    except ValueError as exc:
        return RedirectResponse("/?auth_error=" + quote(str(exc)) + "#login", status_code=303)
    finally:
        conn.close()
    return _set_session_cookie(RedirectResponse("/#dashboard", status_code=303), token)


@app.get("/api/auth/admin/users")
def auth_admin_users():
    return {"items": _run(auth.list_users), "modules": auth.MODULES,
            "sessions": _run(auth.active_sessions)}


@app.post("/api/auth/admin/users")
def auth_admin_create_user(body: UserCreateIn, request: Request):
    return _run(auth.create_user, body.model_dump(), _actor(request)["username"])


@app.put("/api/auth/admin/users/{username}")
def auth_admin_update_user(username: str, body: UserUpdateIn, request: Request):
    return _run(auth.update_user, username, body.model_dump(exclude_unset=True),
                _actor(request)["username"])


@app.delete("/api/auth/admin/users/{username}")
def auth_admin_delete_user(username: str, request: Request):
    return _run(auth.delete_user, username, _actor(request)["username"])


@app.get("/api/auth/admin/sources")
def auth_admin_sources():
    conn = db.connect()
    try:
        return {"items": [auth.mask_source(auth.get_source(conn, k))
                          for k in (auth.SOURCE_LDAP, auth.SOURCE_SSO)],
                "local": auth.DEFAULT_LOCAL_CONFIG}
    finally:
        conn.close()


@app.put("/api/auth/admin/sources/{key}")
def auth_admin_update_source(key: str, body: SourceIn, request: Request):
    return _run(auth.save_source, key, body.model_dump(), _actor(request)["username"])


@app.post("/api/auth/admin/sources/{key}/test")
def auth_admin_test_source(key: str):
    return _run(auth.test_source, key)


@app.get("/api/search")
def global_search(q: str = ""):
    """全站顶栏模糊搜索：已登记 IP、CIDR 地址段及包含关系（只读）。"""
    return _run(db.search, q=q)


@app.get("/api/spaces")
def spaces():
    conn = db.connect()
    try:
        return {
            "vrf": db.current_vrf(),
            "prefixes": db.list_prefixes(conn),
            "transitions": {k: sorted(v) for k, v in domain.TRANSITIONS.items()},
        }
    finally:
        conn.close()


# ---- 03 层：地址空间树写操作（预检 / 编辑 / 新增 / 删除） ------------------------
@app.get("/api/spaces/preflight")
def spaces_preflight(cidr: str, current: str = "", parent: str = "", kind: str = "subnet",
                     vrf: str | None = None):
    """表单实时预检：CIDR 合法性、重叠、父子包含、子前缀与 IP 是否越界（按目标平面）。"""
    return _run(prefix_admin.preflight, cidr=cidr, current=current or None,
                parent=parent or None, kind=kind, vrf=vrf or db.current_vrf())


@app.get("/api/spaces/impact")
def spaces_impact(cidr: str, vrf: str | None = None):
    """删除前影响面：子前缀 / 已登记地址 / 待办差异与工单。"""
    return _run(prefix_admin.impact, cidr=cidr, vrf=vrf or db.current_vrf())


@app.put("/api/spaces/{cidr:path}")
def update_space(cidr: str, body: PrefixUpdateIn):
    return _run(prefix_admin.update_prefix, cidr, body.model_dump(exclude_unset=True))


@app.post("/api/spaces")
def create_space(body: PrefixCreateIn):
    payload = body.model_dump(exclude_unset=True)
    if not str(payload.get("name") or "").strip():
        prefix = {"root": "新根空间 ", "aggregate": "新汇聚前缀 "}.get(
            payload.get("kind"), "新网段 ")
        payload["name"] = prefix + payload["cidr"]
    return _run(prefix_admin.create_prefix, payload)


@app.delete("/api/spaces/{cidr:path}")
def delete_space(cidr: str):
    return _run(prefix_admin.delete_prefix, cidr)


@app.get("/api/ips")
def ips(request: Request, prefix: str = "all", status: str = "all", q: str = "",
        page: int = 1, page_size: int = 10):
    scopes = _sql_scopes()
    conn = db.connect()
    try:
        return db.list_ips(conn, prefix=prefix, status=status, q=q,
                           page=max(1, page), page_size=min(50, max(1, page_size)),
                           scopes=scopes, vrf=db.current_vrf())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        conn.close()


@app.get("/api/allocations/check")
def check_allocation(addr: str = "", prefix: str = ""):
    """手动分配表单实时预检：IPv4 合法性、子网归属、保留地址、占用与建议地址。"""
    return _run(db.manual_check, addr=addr, prefix=prefix)


@app.get("/api/address-map")
def address_map(cidr: str, block: int = 0):
    """子网地址可视化：按块返回全部地址的使用状况与统计（只读）。"""
    return _run(db.address_map, cidr=cidr, block=block)


@app.post("/api/allocations")
def create_allocation(body: AllocationIn):
    try:
        return db.allocate(_bind_plane(body.model_dump()))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/ips/lookup")
def lookup_ip(addr: str):
    """按 IP 精确查询登记记录与可执行的状态机动作，供手动回收使用。"""
    return _run(db.lookup_ip, addr=addr)


@app.put("/api/ips/{addr}")
def edit_ip(addr: str, body: IPUpdateIn):
    """地址记录行操作：编辑主机名 / 业务 / 负责人 / VLAN，写入审计与 Webhook。"""
    return _run(ip_admin.update_ip, addr=addr, payload=body.model_dump(exclude_unset=True))


@app.post("/api/ips/{addr}/transition")
def change_status(addr: str, body: TransitionIn):
    try:
        return db.transition(addr, body.action, _assert_plane(body.vrf))
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.get("/api/dashboard")
def dashboard():
    conn = db.connect()
    try:
        return db.dashboard(conn)
    finally:
        conn.close()


@app.get("/api/audit")
def audit(action: str = "all", q: str = "", limit: int = 100):
    return _run(extended.audit_list, action=action, q=q, limit=limit)


@app.get("/api/overview")
def overview():
    """导航角标与工作台聚合，一次请求拿到各模块待办量。"""
    conn = db.connect()
    try:
        diffs = extended.list_diffs(conn)
        tickets = extended.list_tickets(conn)
        return {
            "open_diffs": diffs["open"], "pending_tickets": tickets["pending"],
            "sources": len([s for s in extended.list_sources(conn) if s["enabled"]]),
            "vrfs": len(extended.list_vrfs(conn)),
            "webhooks": len(extended.webhook_events(conn, limit=100)),
        }
    finally:
        conn.close()


# ---- 01 接入层：VRF 地址平面字典（每个 VRF 是一张独立隔离的地址空间） ----------
@app.get("/api/vrfs")
def vrfs():
    return {"items": _run(extended.list_vrfs)}


@app.get("/api/vrfs/overlap")
def vrf_overlap():
    """跨平面地址复用全景：同一 CIDR / IP 出现在哪些地址平面（跨平面对比，不受当前平面影响）。"""
    return _run(extended.cross_vrf_overlap)


@app.post("/api/vrfs")
def create_vrf(body: VrfIn):
    return _run(extended.create_vrf, body.model_dump())


@app.put("/api/vrfs/{name}")
def update_vrf(name: str, body: VrfUpdateIn):
    return _run(extended.update_vrf, name, body.model_dump(exclude_unset=True))


@app.delete("/api/vrfs/{name}")
def delete_vrf(name: str, target_vrf: str | None = None):
    """删除地址平面；带 target_vrf 时先把该平面数据迁移到目标平面。"""
    return _run(extended.delete_vrf, name, target_vrf)


# ---- 自定义页面内容（05 层持久化） -------------------------------------------
@app.get("/api/pages/{key}")
def get_page(key: str):
    return _run(extended.get_page, key)


@app.put("/api/pages/{key}")
def save_page(key: str, body: PageIn, request: Request):
    """保存自定义页面；保存人取当前会话账号，忽略前端传入的 updated_by。"""
    payload = body.model_dump()
    user = auth.current_user() or auth.resolve_session(request.cookies.get(auth.COOKIE_NAME))
    payload["updated_by"] = (user or {}).get("username") or "—"
    return _run(extended.save_page, key, payload)


# ---- 04 集成与同步层 ---------------------------------------------------------
@app.get("/api/integrations")
def integrations():
    return {"items": _run(extended.list_sources), "events": _run(extended.webhook_events)}


@app.post("/api/integrations/{source_id}/toggle")
def toggle_source(source_id: str, body: SourceToggleIn):
    return _run(extended.set_source, source_id, body.enabled)


@app.post("/api/integrations/{source_id}/sync")
def sync_source(source_id: str):
    return _run(extended.sync_source, source_id)


@app.get("/api/discovery")
def discovery(limit: int = 50):
    return {"items": _run(extended.list_discovery, limit)}


# ---- 02 治理与对账 -----------------------------------------------------------
@app.get("/api/reconciliation")
def reconciliation(status: str = "all", type: str = "all"):
    return _run(extended.list_diffs, status, type)


@app.post("/api/reconciliation/{diff_id}/resolve")
def resolve_diff(diff_id: int, body: DiffResolveIn):
    return _run(extended.resolve_diff, diff_id, body.action, body.note)


# ---- 02 审批工单 -------------------------------------------------------------
@app.get("/api/tickets")
def tickets(status: str = "all"):
    return _run(extended.list_tickets, status)


@app.post("/api/tickets")
def create_ticket(body: TicketIn):
    return _run(extended.create_ticket, _bind_plane(body.model_dump()))


@app.post("/api/tickets/{ticket_id}/decide")
def decide_ticket(ticket_id: str, body: TicketDecisionIn):
    return _run(extended.decide_ticket, ticket_id, body.decision, body.approver, body.note)


# ---- 03 子网计算与规划 -------------------------------------------------------
@app.post("/api/subnets/plan")
def plan_subnets(body: SubnetPlanIn):
    return _run(extended.plan_subnets, body.model_dump())


@app.get("/api/subnets/plan/export")
def export_subnet_plan(parent: str, new_prefix: int = 24, vrf: str | None = None):
    """把目标 VRF 平面等分结果的全部子网导出为 CSV；纯计算，不落库。"""
    text = _run(extended.plan_subnets_csv, parent, new_prefix, vrf or db.current_vrf())
    filename = quote(f"subnet-plan-{parent.replace('/', '_')}-{new_prefix}.csv")
    return Response(
        content=text, media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"},
    )


@app.post("/api/subnets")
def commit_subnets(body: SubnetCommitIn):
    return _run(extended.commit_subnets, _bind_plane(body.model_dump()))


# ---- 02 报表中心 -------------------------------------------------------------
@app.get("/api/reports")
def reports(dimension: str = "site", vrf: str | None = None):
    return _run(extended.report, dimension, vrf or db.current_vrf())


# ---- 05 设置与维护任务 -------------------------------------------------------
@app.get("/api/settings")
def settings():
    return _run(extended.list_settings)


@app.put("/api/settings")
def update_settings(body: dict):
    return _run(extended.update_settings, body)


@app.post("/api/maintenance/expire-reservations")
def expire_reservations():
    return _run(extended.expire_reservations)


@app.post("/api/maintenance/snapshot")
def take_snapshot():
    """按当前地址平面采样当日利用率；'all' 视图下为所有平面各采一条。"""
    return _run(db.record_snapshot, db.current_vrf())


# ---- 02 设备管理：位置 / 机柜 / 设备 / 链路 ---------------------------------
# 注意 /overview 必须声明在 /{kind} 之前，否则会被当成一种资产类型。
@app.get("/api/assets/overview")
def asset_overview():
    """四类资产计数，供设备管理层页头快捷入口使用。"""
    return _run(assets.overview)


# 角色字典：必须声明在 /api/assets/{kind} 之前，否则 device-roles
# 会被当成一种资产类型。写操作由 01 层统一限制为管理员。
@app.get("/api/assets/device-roles")
def device_role_list():
    """角色字典清单：预置 + 自定义、启用状态与每台角色的引用设备数。"""
    return _run(device_roles.list_roles)


@app.post("/api/assets/device-roles")
def device_role_create(body: dict, request: Request):
    return _run(device_roles.create_role, body, _actor(request)["username"])


@app.put("/api/assets/device-roles/{role_key}")
def device_role_update(role_key: str, body: dict, request: Request):
    """自定义角色可改名；改名会在同一事务内同步已引用设备的角色值。"""
    return _run(device_roles.update_role, role_key, body, _actor(request)["username"])


@app.delete("/api/assets/device-roles/{role_key}")
def device_role_delete(role_key: str, request: Request):
    return _run(device_roles.delete_role, role_key, _actor(request)["username"])


# 机柜二级页面：路径段数多于 /{kind}，但统一放在其前面更直观，
# 且 /api/assets/racks/* 由 01 层的 PATH_MODULE_RULES 自动映射到 racks 模块。
@app.get("/api/assets/racks/{rack_id}/detail")
def asset_rack_detail(rack_id: str):
    """机柜正视图数据：机柜本体 + 全量可编辑设备明细。"""
    return _run(assets.rack_detail, rack_id, _sql_scopes())


@app.post("/api/assets/racks/{rack_id}/move")
def asset_rack_move(rack_id: str, body: dict, request: Request):
    """拖拽调整 U 位；目标被占用时在事务内与占用设备交换位置。"""
    return _run(assets.move_device, rack_id, str(body.get("device_id") or ""),
                body.get("rack_u"), _actor(request)["username"])


# 位置二级页面：机柜横向平面图与顺序调整，路径前缀复用 locations 模块权限规则
@app.get("/api/assets/locations/{location_id}/detail")
def asset_location_detail(location_id: str):
    """位置机柜平面图：位置本体 + 下属机柜 U 位占用 + 下级位置。"""
    return _run(assets.location_detail, location_id, _sql_scopes())


@app.post("/api/assets/locations/{location_id}/reorder")
def asset_location_reorder(location_id: str, body: dict, request: Request):
    """左右拖动后持久化该位置下机柜的横向顺序。"""
    return _run(assets.reorder_racks, location_id, body.get("order"),
                _actor(request)["username"])


@app.get("/api/assets/{kind}")
def asset_list(kind: str):
    return _run(assets.list_assets, kind, _sql_scopes())


@app.post("/api/assets/{kind}")
def asset_create(kind: str, body: dict, request: Request):
    return _run(assets.create_asset, kind, body, _actor(request)["username"])


@app.put("/api/assets/{kind}/{item_id}")
def asset_update(kind: str, item_id: str, body: dict, request: Request):
    """编辑资产；body 中的 id 可再次修改，后端在同一事务内级联同步全部引用。"""
    return _run(assets.update_asset, kind, item_id, body, _actor(request)["username"])


@app.delete("/api/assets/{kind}/{item_id}")
def asset_delete(kind: str, item_id: str, request: Request):
    return _run(assets.delete_asset, kind, item_id, _actor(request)["username"])


# 构建后的前端由同一个服务托管，便于单端口部署；开发态走 Vite dev server。
DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if DIST.is_dir():
    app.mount("/", StaticFiles(directory=str(DIST), html=True), name="frontend")
