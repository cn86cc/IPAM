import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { api } from '../api'
import { Card, Drawer, Icon } from '../components/ui'
import { ROLE_LABEL, SOURCE_LABEL } from '../types'
import type {
  AuthConfigData, AuthModule, AuthSourceConfig, AuthUser, Role, Spaces, UsersData, View, Vrf,
} from '../types'
import { shortTime, useLoad, type ViewProps } from './shared'

type Tab = 'users' | 'sources'
type SourceKey = 'ldap' | 'sso'

interface UserForm {
  username: string
  display_name: string
  email: string
  role: Role
  password: string
  enabled: boolean
  modules: View[]
  scopes: string[]
}

const EMPTY_FORM: UserForm = {
  username: '', display_name: '', email: '', role: 'viewer', password: '',
  enabled: true, modules: ['dashboard', 'spaces', 'allocation', 'reports'],
  scopes: ['10.1.0.0/16'],
}

const LDAP_FIELDS: { key: keyof AuthSourceConfig; label: string; placeholder: string; full?: boolean }[] = [
  { key: 'server_url', label: '服务器 URL', placeholder: 'ldap://127.0.0.1:389' },
  { key: 'base_dn', label: 'Base DN', placeholder: 'dc=example,dc=com' },
  { key: 'bind_dn', label: '服务绑定 DN', placeholder: 'cn=admin,dc=example,dc=com' },
  { key: 'bind_password', label: '服务绑定密码', placeholder: '留空表示匿名绑定' },
  { key: 'user_filter', label: '用户过滤器', placeholder: '(uid={username})', full: true },
  { key: 'display_name_attr', label: '显示名属性', placeholder: 'cn' },
  { key: 'email_attr', label: '邮箱属性', placeholder: 'mail' },
]

const SSO_FIELDS: { key: keyof AuthSourceConfig; label: string; placeholder: string; full?: boolean }[] = [
  { key: 'provider', label: '提供商名称', placeholder: '企业统一身份认证' },
  { key: 'issuer', label: 'Issuer / 发现地址', placeholder: 'https://idp.example.com' },
  { key: 'client_id', label: 'Client ID', placeholder: 'ipam-console' },
  { key: 'client_secret', label: 'Client Secret', placeholder: '客户端密钥' },
  { key: 'redirect_uri', label: '回调地址', placeholder: 'http://127.0.0.1:8000/api/auth/sso/callback', full: true },
  { key: 'scope', label: '授权 Scope', placeholder: 'openid profile email', full: true },
]

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" className={`switch${on ? ' on' : ''}`} role="switch"
      aria-checked={on} aria-label={label} title={label} onClick={() => onChange(!on)}><i /></button>
  )
}

function ModulePicker({ modules, value, onChange, disabled }: {
  modules: AuthModule[]
  value: View[]
  onChange: (v: View[]) => void
  disabled?: boolean
}) {
  const groups = [...new Set(modules.map(m => m.group))]
  return (
    <div>
      {groups.map(group => {
        const items = modules.filter(m => m.group === group && m.key !== 'users')
        if (!items.length) return null
        const keys = items.map(m => m.key)
        const allOn = keys.every(k => value.includes(k))
        return (
          <div className="perm-group" key={group}>
            <div className="perm-group-head">
              {group} · {keys.filter(k => value.includes(k)).length}/{keys.length}
              {!disabled && (
                <button type="button" className="mini-link" onClick={() => onChange(
                  allOn ? value.filter(k => !keys.includes(k))
                    : [...new Set([...value, ...keys])])}>
                  {allOn ? '取消全选' : '全选'}
                </button>
              )}
            </div>
            <div className="perm-grid">
              {items.map(m => (
                <label key={m.key} className={`perm-item${value.includes(m.key) ? ' on' : ''}`}>
                  <input type="checkbox" checked={value.includes(m.key)} disabled={disabled}
                    onChange={e => onChange(e.target.checked
                      ? [...value, m.key] : value.filter(k => k !== m.key))} />
                  {m.label}
                </label>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ScopePicker({ candidates, value, onChange, lockedAll, vrfs = [] }: {
  candidates: string[]
  value: string[]
  onChange: (v: string[]) => void
  lockedAll?: boolean
  /** 可选的地址平面列表，用于生成 vrf:CIDR 形式的按平面授权 */
  vrfs?: string[]
}) {
  const [custom, setCustom] = useState('')
  const [customVrf, setCustomVrf] = useState('')
  const all = [...new Set([...candidates, ...value])]
  const selected = lockedAll ? all : value
  return (
    <>
      {lockedAll && (
        <div className="scope-all-badge" id="admin-scope-all">
          <Icon name="check" size={13} /> 全部可见地址范围（不限 CIDR）
        </div>
      )}
      <div className="scope-list" id="scope-picker">
        {all.map(c => (
          <label key={c} className={`scope-chip${selected.includes(c) ? ' on' : ''}${lockedAll ? ' locked' : ''}`}>
            <input type="checkbox" checked={selected.includes(c)} disabled={lockedAll}
              onChange={e => onChange(e.target.checked ? [...value, c] : value.filter(x => x !== c))} />
            <span className="mono">{c}</span>
          </label>
        ))}
      </div>
      {!lockedAll && (
        <>
          <div className="inline" style={{ marginTop: 10, gap: 8, flexWrap: 'wrap' }}>
            {vrfs.length > 0 && (
              <select value={customVrf} onChange={e => setCustomVrf(e.target.value)}
                aria-label="授权适用的地址平面" style={{ flex: '0 0 155px' }}>
                <option value="">所有地址平面</option>
                {vrfs.map(v => <option key={v} value={v}>仅 {v} 平面</option>)}
              </select>
            )}
            <input className="mono" value={custom} placeholder="CIDR，例如 10.9.0.0/16"
              onChange={e => setCustom(e.target.value)} style={{ flex: '1 1 200px' }} />
            <button type="button" className="btn sm" id="add-custom-scope" onClick={() => {
              const text = custom.trim()
              if (!text) return
              // 纯 CIDR 对所有平面生效；vrf:CIDR 只对指定地址平面内的地址生效
              const scope = customVrf ? `${customVrf}:${text}` : text
              if (!value.includes(scope)) onChange([...value, scope])
              setCustom('')
            }}>添加范围</button>
          </div>
          <div className="help" style={{ marginTop: 6, lineHeight: 1.8 }}>
            不勾选 = 不限制地址段；勾选后该用户只能看到这些 CIDR 及其子网。<br />
            <b>按地址平面授权</b>：在左侧下拉选定 VRF 后添加，会生成
            <span className="mono"> vrf:CIDR</span>（如 <span className="mono">vrf-lab:10.1.0.0/16</span>），
            该范围只在对应平面生效；不带前缀的纯 CIDR 对所有平面生效。
            后端按 (VRF, CIDR) 裁剪响应，越权请求统一返回 403。
          </div>
        </>
      )}
      {lockedAll && (
        <div className="help" style={{ marginTop: 6 }}>
          管理员默认拥有全部可见地址范围（所有平面、不限 CIDR），该设置由角色自动锁定，不能手动收窄。
        </div>
      )}
    </>
  )
}

export default function UsersView({ notify, onChanged, refreshKey }: ViewProps) {
  const [tab, setTab] = useState<Tab>('users')
  const { data, loading, reload } = useLoad(
    () => Promise.all([api.users(), api.authConfig(), api.spaces(), api.vrfs()]),
    [refreshKey], notify,
  )
  const [usersData, configData, spaces, vrfData] = data ?? [null, null, null, null] as
    [UsersData | null, AuthConfigData | null, Spaces | null, { items: Vrf[] } | null]
  const [editor, setEditor] = useState<{ mode: 'create' | 'edit'; user?: AuthUser } | null>(null)
  const [form, setForm] = useState<UserForm>(EMPTY_FORM)
  const [formError, setFormError] = useState('')
  const [busy, setBusy] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<AuthUser | null>(null)
  const [ldap, setLdap] = useState<{ enabled: boolean; config: AuthSourceConfig }>(
    { enabled: false, config: {} })
  const [sso, setSso] = useState<{ enabled: boolean; config: AuthSourceConfig }>(
    { enabled: false, config: {} })
  const [testResult, setTestResult] = useState<Record<SourceKey, string>>({ ldap: '', sso: '' })

  const moduleList = usersData?.modules ?? []
  const users = usersData?.items ?? []
  const scopeCandidates = useMemo(
    () => [...new Set((spaces?.prefixes ?? []).map(p => p.cidr))], [spaces])
  const vrfNames = useMemo(
    () => (vrfData?.items ?? []).map(v => v.name), [vrfData])

  useEffect(() => {
    if (!configData) return
    const find = (key: SourceKey) => configData.items.find(i => i.key === key)
    const l = find('ldap'), s = find('sso')
    if (l) setLdap({ enabled: l.enabled, config: { ...l.config } })
    if (s) setSso({ enabled: s.enabled, config: { ...s.config } })
  }, [configData])

  const admins = users.filter(u => u.role === 'admin').length
  const viewers = users.filter(u => u.role === 'viewer').length
  const external = users.filter(u => u.source !== 'local').length

  function openEditor(mode: 'create' | 'edit', user?: AuthUser) {
    setFormError('')
    setForm(user ? {
      username: user.username, display_name: user.display_name, email: user.email ?? '',
      role: user.role, password: '', enabled: user.enabled,
      modules: [...user.modules], scopes: [...user.scopes],
    } : { ...EMPTY_FORM, modules: [...EMPTY_FORM.modules], scopes: [...EMPTY_FORM.scopes] })
    setEditor({ mode, user })
  }

  async function saveUser(e: FormEvent) {
    e.preventDefault()
    if (!editor) return
    setBusy(true); setFormError('')
    try {
      const payload = {
        display_name: form.display_name.trim() || form.username.trim(),
        email: form.email.trim(), role: form.role, enabled: form.enabled,
        modules: form.role === 'admin' ? moduleList.map(m => m.key) : form.modules,
        scopes: form.role === 'admin' ? [] : form.scopes,
        ...(editor.mode === 'create'
          ? { username: form.username.trim(), password: form.password }
          : form.password ? { password: form.password } : {}),
      }
      if (editor.mode === 'create') await api.createUser(payload)
      else await api.updateUser(editor.user!.username, payload)
      notify(`${editor.mode === 'create' ? '已创建' : '已更新'}用户 ${form.username.trim() || editor.user?.username}`)
      setEditor(null); reload(); onChanged()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '保存失败')
    } finally { setBusy(false) }
  }

  async function removeUser() {
    if (!deleteTarget) return
    setBusy(true)
    try {
      await api.deleteUser(deleteTarget.username)
      notify(`已删除用户 ${deleteTarget.username}`)
      setDeleteTarget(null); reload(); onChanged()
    } catch (err) {
      notify(err instanceof Error ? err.message : '删除失败', 'error')
    } finally { setBusy(false) }
  }

  async function saveSource(key: SourceKey) {
    setBusy(true)
    try {
      const state = key === 'ldap' ? ldap : sso
      const res = await api.saveAuthSource(key, state.enabled, state.config)
      notify(`${key.toUpperCase()} 认证源已保存（${res.enabled ? '启用' : '停用'}）`)
      reload()
    } catch (err) {
      notify(err instanceof Error ? err.message : '保存失败', 'error')
    } finally { setBusy(false) }
  }

  async function testSource(key: SourceKey) {
    try {
      const res = await api.testAuthSource(key)
      setTestResult(r => ({ ...r, [key]: `✓ ${res.detail}` }))
    } catch (err) {
      setTestResult(r => ({ ...r, [key]: `✕ ${err instanceof Error ? err.message : '测试失败'}` }))
    }
  }

  const patchConfig = (key: SourceKey, field: string, value: unknown) => {
    const setter = key === 'ldap' ? setLdap : setSso
    setter(state => ({ ...state, config: { ...state.config, [field]: value } }))
  }

  function renderSource(key: SourceKey) {
    const state = key === 'ldap' ? ldap : sso
    const setter = key === 'ldap' ? setLdap : setSso
    const fields = key === 'ldap' ? LDAP_FIELDS : SSO_FIELDS
    const cfg = state.config
    return (
      <Card key={key} title={key === 'ldap' ? 'LDAP / AD 目录认证' : 'SSO / OIDC 单点登录'}
        hint={key === 'ldap' ? 'ldap3 绑定认证' : '授权码 + PKCE S256'} extra={
          <div className="inline">
            <span className="hint">{state.enabled ? '已启用' : '已停用'}</span>
            <Switch on={state.enabled} label="启用认证源"
              onChange={v => setter(s => ({ ...s, enabled: v }))} />
          </div>
        }>
        <div className="auth-card-head" style={{ border: 0, paddingBottom: 0, marginBottom: 10 }}>
          <div>
            <b>{key === 'ldap' ? '企业目录' : '企业身份提供商'}</b>
            <small>{key === 'ldap'
              ? '服务账号检索用户 DN → 用该 DN 与用户密码重新绑定；首次登录自动创建只读账号。'
              : 'OIDC 发现文档 → 授权码 + PKCE → token / userinfo → 自动建号并签发会话。'}</small>
          </div>
        </div>
        <div className="field">
          <label>运行模式</label>
          <div className="tabs" style={{ width: 'fit-content' }}>
            <button type="button" className={`tab${cfg.demo_mode ? ' active' : ''}`}
              onClick={() => patchConfig(key, 'demo_mode', true)}>演示模式（内置模拟）</button>
            <button type="button" className={`tab${!cfg.demo_mode ? ' active' : ''}`}
              onClick={() => patchConfig(key, 'demo_mode', false)}>真实服务器</button>
          </div>
          <div className="help">
            {cfg.demo_mode
              ? (key === 'ldap'
                ? '使用下方内置演示目录校验账号密码，无需外部 LDAP 服务。'
                : '跳转内置模拟 IdP 授权页，完整走一遍授权码 → 回调 → 建会话流程。')
              : (key === 'ldap'
                ? '使用 ldap3 连接真实目录；请先在测试连接中确认服务器可达。'
                : '对接真实 OIDC Provider；需可访问 issuer 的 .well-known/openid-configuration。')}
          </div>
        </div>

        <div className="auth-form-grid">
          {fields.map(f => (
            <div className={`field${f.full ? ' full' : ''}`} key={f.key}>
              <label>{f.label}</label>
              <input className={f.placeholder.includes('/') || f.placeholder.includes('{') ? 'mono' : ''}
                value={(cfg[f.key] as string | undefined) ?? ''} placeholder={f.placeholder}
                type={f.key === 'client_secret' || f.key === 'bind_password' ? 'password' : 'text'}
                onChange={e => patchConfig(key, f.key, e.target.value)} />
            </div>
          ))}
        </div>

        {key === 'ldap' && (
          <div className="field">
            <label>演示目录账号</label>
            {(cfg.demo_users ?? []).map((u, i) => (
              <div className="inline" key={i} style={{ marginBottom: 6 }}>
                <input className="mono" value={u.username} placeholder="账号" style={{ flex: '1 1 110px' }}
                  onChange={e => {
                    const list = [...(cfg.demo_users ?? [])]
                    list[i] = { ...list[i], username: e.target.value }
                    patchConfig(key, 'demo_users', list)
                  }} />
                <input className="mono" value={u.password} placeholder="密码" style={{ flex: '1 1 110px' }}
                  onChange={e => {
                    const list = [...(cfg.demo_users ?? [])]
                    list[i] = { ...list[i], password: e.target.value }
                    patchConfig(key, 'demo_users', list)
                  }} />
                <input value={u.display_name} placeholder="显示名" style={{ flex: '1 1 100px' }}
                  onChange={e => {
                    const list = [...(cfg.demo_users ?? [])]
                    list[i] = { ...list[i], display_name: e.target.value }
                    patchConfig(key, 'demo_users', list)
                  }} />
                <button type="button" className="btn sm" title="移除"
                  onClick={() => patchConfig(key, 'demo_users',
                    (cfg.demo_users ?? []).filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
            <button type="button" className="btn sm" id={`add-demo-${key}`} onClick={() => patchConfig(key,
              'demo_users', [...(cfg.demo_users ?? []),
              { username: '', password: '', display_name: '', email: '' }])}>
              <Icon name="plus" size={12} />新增演示账号
            </button>
            <div className="inline" style={{ marginTop: 10 }}>
              <label style={{ fontSize: 11, color: 'var(--text-2)' }}>使用 TLS</label>
              <Switch on={!!cfg.use_tls} label="使用 TLS" onChange={v => patchConfig(key, 'use_tls', v)} />
            </div>
          </div>
        )}

        <div className="field">
          <label>外部账号默认可见模块</label>
          <ModulePicker modules={moduleList}
            value={(cfg.default_modules ?? []) as View[]}
            onChange={v => patchConfig(key, 'default_modules', v)} />
        </div>
        <div className="field">
          <label>外部账号默认可见地址范围</label>
          <ScopePicker candidates={scopeCandidates} vrfs={vrfNames}
            value={cfg.default_scopes ?? []}
            onChange={v => patchConfig(key, 'default_scopes', v)} />
        </div>

        <div className="auth-test">
          <button type="button" className="btn" id={`test-${key}`} disabled={busy}
            onClick={() => void testSource(key)}><Icon name="plug" size={12} />测试连接</button>
          <button type="button" className="btn primary" id={`save-${key}`} disabled={busy}
            onClick={() => void saveSource(key)}><Icon name="check" size={12} />保存配置</button>
          {testResult[key] && <div className="auth-test-result">{testResult[key]}</div>}
        </div>
      </Card>
    )
  }

  return (
    <>
      <div className="user-stat-row">
        <div className="user-stat"><span>账号总数</span><b>{users.length}</b><small>{loading ? '加载中…' : '含外部认证自动建号'}</small></div>
        <div className="user-stat"><span>管理员</span><b>{admins}</b><small>默认全部功能 · 全部地址范围</small></div>
        <div className="user-stat"><span>只读用户</span><b>{viewers}</b><small>可见范围由管理员手动分配</small></div>
        <div className="user-stat"><span>外部认证账号</span><b>{external}</b><small>LDAP / SSO 首次登录自动创建</small></div>
      </div>

      <div className="user-tabs" id="users-tabs">
        <button className={tab === 'users' ? 'active' : ''} id="users-tab-list"
          onClick={() => setTab('users')}>用户管理</button>
        <button className={tab === 'sources' ? 'active' : ''} id="users-tab-sources"
          onClick={() => setTab('sources')}>认证源配置</button>
      </div>

      {tab === 'users' ? (
        <div className="grid-2">
          <div className="stack-col">
            <Card title="用户列表" hint="角色与可见范围" extra={
              <button className="btn sm primary" id="user-create"
                onClick={() => openEditor('create')}><Icon name="plus" size={12} />新建用户</button>
            }>
              {users.map(u => (
                <div className="user-row" key={u.username}>
                  <div className={`user-avatar ${u.role}`}>{u.display_name.slice(0, 1)}</div>
                  <div className="user-row-main">
                    <b>{u.display_name}
                      <span className={`user-tag ${u.role}`}>{ROLE_LABEL[u.role]}</span>
                      <span className="user-tag">{SOURCE_LABEL[u.source]}</span>
                      {!u.enabled && <span className="user-tag off">已停用</span>}
                    </b>
                    <span className="mono">@{u.username} · 模块 {u.role === 'admin' ? '全部' : `${u.modules.length} 个`}
                      {' · '}范围 {u.role === 'admin' ? '全部（不限）' : u.scopes.length ? u.scopes.join('、') : '不限'}
                      {' · '}最近登录 {shortTime(u.last_login_at)}</span>
                  </div>
                  <div className="inline">
                    <button className="btn sm" id={`user-edit-${u.username}`} title="编辑角色与可见范围"
                      onClick={() => openEditor('edit', u)}><Icon name="edit" size={12} /></button>
                    <button className="btn sm" title="删除用户" disabled={busy}
                      onClick={() => setDeleteTarget(u)}><Icon name="trash" size={12} /></button>
                  </div>
                </div>
              ))}
              {!users.length && <div className="empty">暂无用户</div>}
              <p className="footnote" style={{ marginTop: 12 }}>
                管理员默认拥有全部功能与全部可见地址范围（所有 VRF 平面、不限 CIDR），该权限由角色自动锁定；只读用户只能访问勾选的模块，地址数据在后端按 (VRF, CIDR) 范围裁剪，支持 <span className="mono">vrf:CIDR</span> 形式的按平面授权。
              </p>
            </Card>

            <Card title="活跃会话" hint="HttpOnly Cookie · 12 小时">
              {(usersData?.sessions ?? []).map((s, i) => (
                <div className="session-row" key={i}>
                  <span className={`user-tag ${s.source}`}>{SOURCE_LABEL[s.source]}</span>
                  <b>{s.display_name ?? s.username}</b>
                  <span className="mono">@{s.username}</span>
                  <time>{shortTime(s.last_seen)}</time>
                </div>
              ))}
              {!usersData?.sessions?.length && <div className="empty">暂无活跃会话</div>}
            </Card>
          </div>

          <Card title="权限模型说明" hint="01 接入层">
            <div className="warn-item">
              <div className="warn-head"><b>管理员 admin</b><span className="lvl warn">全模块 · 全范围</span></div>
              <div className="warn-note">默认拥有全部功能与全部可见地址范围；可管理所有模块、分配 / 回收地址、修改前缀与设置、管理用户与认证源。</div>
            </div>
            <div className="warn-item">
              <div className="warn-head"><b>只读用户 viewer</b><span className="lvl warn">按范围只读</span></div>
              <div className="warn-note">可见模块与地址段由管理员手动分配：纯 CIDR 对所有 VRF 平面生效，<span className="mono">vrf:CIDR</span> 只授权指定平面；所有非 GET 请求在后端统一返回 403。</div>
            </div>
            <div className="warn-item">
              <div className="warn-head"><b>可见范围</b><span className="lvl warn">后端裁剪</span></div>
              <div className="warn-note">地址记录、空间树、搜索、看板、位图、对账与工单等响应都会先按当前 VRF 平面隔离，再按授权 CIDR 过滤；跨平面越权与汇总视图下的写操作由后端拒绝，前端隐藏只是体验。</div>
            </div>
            <div className="warn-item">
              <div className="warn-head"><b>会话与锁定</b><span className="lvl warn">PBKDF2</span></div>
              <div className="warn-note">密码 PBKDF2-HMAC-SHA256 20 万轮加盐；连续 5 次失败锁定 5 分钟，登录 / 退出 / 权限变更写审计。</div>
            </div>
            <p className="footnote" style={{ lineHeight: 1.9 }}>
              生产替换位：把会话表换 Redis、为 OIDC 增加 id_token 签名校验与 JWKS 轮换、
              接入企业 LDAP over SSL 与组映射、增加 MFA 与 IP 白名单。
            </p>
          </Card>
        </div>
      ) : (
        <div className="stack-col">
          <Card title="本地账号认证" hint="始终启用，防止锁死系统" extra={
            <span className="hint">不可关闭</span>
          }>
            <div className="form-grid">
              <div><span style={{ fontSize: 11, color: 'var(--text-3)' }}>密码最短长度</span>
                <div className="mono">{configData?.local.password_min_length ?? 8} 位（需含字母与数字）</div></div>
              <div><span style={{ fontSize: 11, color: 'var(--text-3)' }}>会话有效期</span>
                <div className="mono">{configData?.local.session_hours ?? 12} 小时</div></div>
              <div><span style={{ fontSize: 11, color: 'var(--text-3)' }}>失败锁定</span>
                <div className="mono">{configData?.local.lock_threshold ?? 5} 次 / {configData?.local.lock_minutes ?? 5} 分钟</div></div>
              <div><span style={{ fontSize: 11, color: 'var(--text-3)' }}>存储方式</span>
                <div className="mono">PBKDF2-HMAC-SHA256</div></div>
            </div>
          </Card>
          {renderSource('ldap')}
          {renderSource('sso')}
        </div>
      )}

      {editor && (
        <Drawer open title={editor.mode === 'create' ? '新建本地用户' : `编辑用户 · ${editor.user?.username}`}
          sub="角色、可见模块与 CIDR 地址范围" onClose={() => setEditor(null)}>
          <form onSubmit={saveUser} id="user-form">
            <div className="form-grid">
              <div className="field"><label>用户名</label>
                <input className="mono" value={form.username} disabled={editor.mode === 'edit'}
                  onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
                  placeholder="3–32 位字母数字" />
              </div>
              <div className="field"><label>显示名</label>
                <input value={form.display_name}
                  onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))}
                  placeholder="例如 网络运维组" />
              </div>
              <div className="field full"><label>邮箱（可选）</label>
                <input value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="name@example.com" />
              </div>
              <div className="field full"><label>{editor.mode === 'create' ? '初始密码' : '重置密码（留空不修改）'}</label>
                <input type="password" value={form.password}
                  onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                  placeholder="至少 8 位，含字母与数字" />
              </div>
            </div>

            <div className="field"><label>角色</label>
              <div className="tabs" style={{ width: 'fit-content' }}>
                <button type="button" id="role-viewer" className={`tab${form.role === 'viewer' ? ' active' : ''}`}
                  onClick={() => setForm(f => ({
                    ...f, role: 'viewer',
                    // 从管理员降级时回退到只读用户默认授权，避免误存「全部模块 + 不限范围」
                    modules: moduleList.length && f.modules.length >= moduleList.length
                      ? [...EMPTY_FORM.modules] : f.modules,
                    scopes: f.scopes.length ? f.scopes : [...EMPTY_FORM.scopes],
                  }))}>只读用户</button>
                <button type="button" id="role-admin" className={`tab${form.role === 'admin' ? ' active' : ''}`}
                  onClick={() => setForm(f => ({ ...f, role: 'admin' }))}>管理员</button>
              </div>
              <div className="help">
                {form.role === 'admin'
                  ? '管理员默认拥有全部功能与全部可见地址范围（不限 CIDR），由角色自动锁定，不能手动收窄。'
                  : '只读用户所有写操作在后端被拒绝，只能查看下方勾选的模块与地址范围。'}
              </div>
            </div>

            <div className="field"><label>账号状态</label>
              <div className="inline">
                <Switch on={form.enabled} label="启用账号"
                  onChange={v => setForm(f => ({ ...f, enabled: v }))} />
                <span className="help">{form.enabled ? '账号可登录' : '停用后所有会话立即失效'}</span>
              </div>
            </div>

            <div className="field">
              <label>可见模块（手动分配）</label>
              <ModulePicker modules={moduleList} value={form.role === 'admin'
                ? moduleList.map(m => m.key) : form.modules}
                onChange={v => setForm(f => ({ ...f, modules: v }))}
                disabled={form.role === 'admin'} />
            </div>

            <div className="field">
              <label>可见地址范围（VRF + CIDR）
                {form.role === 'admin' && <span className="perm-locked-tag">全部 · 自动锁定</span>}
              </label>
              <ScopePicker candidates={scopeCandidates} vrfs={vrfNames} value={form.scopes}
                onChange={v => setForm(f => ({ ...f, scopes: v }))}
                lockedAll={form.role === 'admin'} />
            </div>

            {formError && <div className="check-note bad">{formError}</div>}
            <div className="drawer-actions">
              <button type="button" className="btn ghost" onClick={() => setEditor(null)}>取消</button>
              <button type="submit" className="btn primary" id="user-save" disabled={busy}>
                {busy ? '保存中…' : '保存用户'}
              </button>
            </div>
          </form>
        </Drawer>
      )}

      {deleteTarget && (
        <Drawer open title="删除用户" sub={deleteTarget.username} onClose={() => setDeleteTarget(null)}>
          <p className="footnote" style={{ marginTop: 0, lineHeight: 1.9 }}>
            确认删除用户 <b className="mono">{deleteTarget.username}</b>（{deleteTarget.display_name}）？
            该账号的全部会话会立即失效；不能删除当前登录账号或最后一个启用状态的管理员。
          </p>
          <div className="drawer-actions">
            <button className="btn ghost" onClick={() => setDeleteTarget(null)}>取消</button>
            <button className="btn primary" id="user-delete-confirm" disabled={busy}
              onClick={() => void removeUser()}>{busy ? '删除中…' : '确认删除'}</button>
          </div>
        </Drawer>
      )}
    </>
  )
}
