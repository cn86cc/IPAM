import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react'
import { api, setApiScope, setApiVrf } from './api'
import type { AuthModule, AuthUser, LoginPayload, MeResult, View } from './types'

interface AuthContextValue {
  user: AuthUser | null
  loading: boolean
  error: string
  modules: AuthModule[]
  isAdmin: boolean
  /** 当前模块是否在可见范围内 */
  can: (view: View) => boolean
  /** 只读用户手动选定的当前可见范围：'all' 或某个 CIDR */
  scope: string
  setScope: (scope: string) => void
  /** 当前 VRF 地址平面：'all' 为跨平面对比视图，其余为独立隔离平面 */
  vrf: string
  setVrf: (vrf: string) => void
  login: (payload: LoginPayload) => Promise<AuthUser>
  logout: () => Promise<void>
  refresh: () => Promise<void>
  changePassword: (oldPassword: string, newPassword: string) => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [modules, setModules] = useState<AuthModule[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [scope, setScopeState] = useState('all')
  /** 系统设置里的默认视图；只有用户没手动切换过时才会跟随它。
   *  出厂默认 'all'：安装完成后先看「全部 VRF · 跨平面对比」（只读）。 */
  const [defaultVrf, setDefaultVrf] = useState('all')
  const [vrf, setVrfState] = useState(() => {
    const saved = localStorage.getItem('ipam.vrf')
    const initial = saved || 'all'
    setApiVrf(initial)
    return initial
  })

  const applyMe = useCallback((res: MeResult) => {
    setUser(res.user)
    setModules(res.modules)
    setScopeState('all')
    setApiScope('all')
    const configured = res.default_vrf || 'all'
    setDefaultVrf(configured)
    // 区分「系统默认」与「用户手动选择」：手动选择写入 localStorage 并优先，
    // 未选择过则跟随设置（改配置后下次登录 / 刷新立即生效，不会被写死）。
    if (!localStorage.getItem('ipam.vrf')) {
      setVrfState(configured)
      setApiVrf(configured)
    }
    setError('')
  }, [])

  const refresh = useCallback(async () => {
    try {
      applyMe(await api.me())
    } catch (err) {
      setUser(null)
      if (err instanceof Error && !err.message.includes('未登录')) setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [applyMe])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    const onUnauthorized = () => { setUser(null); setError('') }
    window.addEventListener('ipam:unauthorized', onUnauthorized)
    return () => window.removeEventListener('ipam:unauthorized', onUnauthorized)
  }, [])

  const login = useCallback(async (payload: LoginPayload) => {
    const res = await api.login(payload)
    setApiScope('all')
    setScopeState('all')
    applyMe(await api.me())
    return res.user
  }, [applyMe])

  const logout = useCallback(async () => {
    try { await api.logout() } catch { /* 会话已失效也要清理前端状态 */ }
    setUser(null)
    setScopeState('all')
    setApiScope('all')
    setVrfState(defaultVrf)
    setApiVrf(defaultVrf)
    localStorage.removeItem('ipam.vrf')
    setError('')
  }, [defaultVrf])

  const setScope = useCallback((next: string) => {
    setScopeState(next || 'all')
    setApiScope(next || 'all')
  }, [])

  const setVrf = useCallback((next: string) => {
    const value = next || 'all'
    setVrfState(value)
    setApiVrf(value)
    localStorage.setItem('ipam.vrf', value)
  }, [])

  const changePassword = useCallback(async (oldPassword: string, newPassword: string) => {
    await api.changePassword(oldPassword, newPassword)
  }, [])

  const isAdmin = user?.role === 'admin'
  const can = useCallback((view: View) => {
    if (!user) return false
    if (user.role === 'admin') return true
    if (view === 'users') return false
    return user.modules.includes(view)
  }, [user])

  const value = useMemo<AuthContextValue>(() => ({
    user, loading, error, modules, isAdmin, can, scope, setScope, vrf, setVrf,
    login, logout, refresh, changePassword,
  }), [user, loading, error, modules, isAdmin, can, scope, setScope, vrf, setVrf,
        login, logout, refresh, changePassword])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用')
  return ctx
}

/** 写操作统一包裹：只读用户默认看不到，可传入只读替代内容。 */
export function AdminOnly({ children, fallback }: { children: ReactNode; fallback?: ReactNode }) {
  const { isAdmin } = useAuth()
  return <>{isAdmin ? children : (fallback ?? null)}</>
}
