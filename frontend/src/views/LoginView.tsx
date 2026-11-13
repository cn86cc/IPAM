import { useEffect, useState, type FormEvent } from 'react'
import { api } from '../api'
import { Icon } from '../components/ui'
import { useAuth } from '../auth'
import type { PublicSources } from '../types'

type Method = 'local' | 'ldap' | 'sso'

const METHOD_META: { key: Method; label: string; hint: string }[] = [
  { key: 'local', label: '本地账号', hint: '用户名 + 密码，PBKDF2 哈希存储' },
  { key: 'ldap', label: 'LDAP / AD', hint: '企业目录绑定认证' },
  { key: 'sso', label: 'SSO', hint: 'OIDC 授权码 + PKCE' },
]

export default function LoginView() {
  const { login, loading: authLoading, error: authError } = useAuth()
  const [sources, setSources] = useState<PublicSources | null>(null)
  const [method, setMethod] = useState<Method>('local')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [urlError] = useState(() => {
    const value = new URLSearchParams(window.location.search).get('auth_error')
    return value ? decodeURIComponent(value) : ''
  })

  useEffect(() => {
    let alive = true
    api.authSources().then(res => { if (alive) setSources(res) }).catch(() => {})
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (urlError) {
      setError(urlError)
      window.history.replaceState(null, '', window.location.pathname + '#login')
    }
  }, [urlError])

  const active = METHOD_META.find(m => m.key === method)!
  const enabled = (key: Method) => key === 'local' || !!sources?.[key]?.enabled

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (method === 'sso') return
    setError('')
    setBusy(true)
    try {
      await login({ method, username: username.trim(), password })
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setBusy(false)
    }
  }

  async function startSso() {
    setError('')
    setBusy(true)
    try {
      const res = await api.ssoStart()
      window.location.assign(res.authorize_url)
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法发起 SSO 登录')
      setBusy(false)
    }
  }

  return (
    <div className="login-shell">
      <section className="login-brand">
        <div className="login-brand-inner">
          <div className="login-logo">
            <div className="login-logo-mark">IP</div>
            <div>
              <b>IPv4 地址管理平台</b>
              <span>IPAM Console · 五层架构</span>
            </div>
          </div>

          <div className="login-slogan">
            <div className="login-kicker">ADDRESS SPACE, UNDER CONTROL</div>
            <h2>让每一段地址空间<br />都有明确的归属</h2>
            <p>地址空间树、分配与回收、容量看板、发现对账与审计留痕，
              在同一套领域核心层之上协同工作。</p>
          </div>

          <div className="login-features">
            <div><span className="login-feature-ico"><Icon name="layers" size={14} /></span>
              <div><b>地址空间树</b><small>多根空间 · 前缀层级 · 容量联动</small></div></div>
            <div><span className="login-feature-ico"><Icon name="shield" size={14} /></span>
              <div><b>领域核心层</b><small>状态机 · 冲突校验 · 并发锁</small></div></div>
            <div><span className="login-feature-ico"><Icon name="audit" size={14} /></span>
              <div><b>全链路留痕</b><small>写操作只追加审计与事件</small></div></div>
          </div>

          <div className="login-foot">v0.5 · 本地认证 / RBAC / LDAP / OIDC / 设备管理</div>
        </div>
      </section>

      <section className="login-panel">
        <div className="login-box">
          <h1>登录控制台</h1>
          <p className="login-sub">请选择认证方式，登录后可访问被授权的模块与地址范围。</p>

          <div className="login-tabs" id="login-methods">
            {METHOD_META.map(m => (
              <button type="button" key={m.key} id={`login-tab-${m.key}`}
                className={`login-tab${method === m.key ? ' active' : ''}`}
                disabled={!enabled(m.key)}
                title={enabled(m.key) ? m.hint : '该认证源未启用，请联系管理员'}
                onClick={() => { setMethod(m.key); setError('') }}>
                {m.label}
                {!enabled(m.key) && <i className="login-off">未启用</i>}
              </button>
            ))}
          </div>

          {(error || urlError || authError) && (
            <div className="login-error" id="login-error">
              <Icon name="alert" size={13} />{error || urlError || authError}
            </div>
          )}

          {method === 'sso' ? (
            <div className="login-sso">
              <div className="login-sso-card">
                <span className="login-sso-ico"><Icon name="swap" size={20} /></span>
                <div>
                  <b>{sources?.sso?.label ?? '企业统一身份认证'}</b>
                  <small>OIDC 授权码流程 · PKCE S256 · 首次登录自动创建只读账号</small>
                </div>
              </div>
              {sources?.sso?.demo_mode && (
                <div className="login-demo-tag">演示模式：将跳转至内置模拟 IdP 授权页</div>
              )}
              <button className="btn primary login-submit" type="button" id="login-sso-go"
                disabled={busy || !enabled('sso')} onClick={() => void startSso()}>
                <Icon name="swap" />{busy ? '正在跳转…' : '使用企业 SSO 登录'}
              </button>
              <p className="login-note">跳转后由身份提供商完成认证，回调成功后自动建立会话。</p>
            </div>
          ) : (
            <form className="login-form" onSubmit={submit}>
              <div className="login-field">
                <label>{method === 'ldap' ? '域账号' : '用户名'}</label>
                <div className="login-input-wrap">
                  <Icon name="ip" size={15} />
                  <input id="login-username" value={username} autoComplete="username"
                    onChange={e => setUsername(e.target.value)}
                    placeholder={method === 'ldap' ? '请输入域账号' : '请输入用户名'} />
                </div>
              </div>
              <div className="login-field">
                <label>密码</label>
                <div className="login-input-wrap">
                  <Icon name="shield" size={15} />
                  <input id="login-password" type={showPassword ? 'text' : 'password'}
                    value={password} autoComplete="current-password"
                    onChange={e => setPassword(e.target.value)} placeholder="请输入密码" />
                  <button type="button" className="login-eye" title={showPassword ? '隐藏密码' : '显示密码'}
                    onClick={() => setShowPassword(v => !v)}>{showPassword ? '隐藏' : '显示'}</button>
                </div>
              </div>
              <div className="login-hint">{active.hint}</div>
              <button className="btn primary login-submit" type="submit" id="login-submit"
                disabled={busy || authLoading || !username.trim() || !password}>
                <Icon name="check" />{busy ? '正在验证…' : '登录'}
              </button>
            </form>
          )}

          <p className="login-note">
            会话使用 HttpOnly Cookie，12 小时后自动失效；连续 5 次密码错误锁定 5 分钟。
            所有登录、退出与权限变更均写入审计日志。
          </p>
        </div>
      </section>
    </div>
  )
}
