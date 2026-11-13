import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { api } from './api'
import { AddressTable, Bar, Card, Icon, Metric, levelOf } from './components/ui'
import GlobalSearch from './components/GlobalSearch'
import { AdminOnly, AuthProvider, useAuth } from './auth'
import {
  PREFIX_KIND_LABEL, ROLE_LABEL, SOURCE_LABEL,
  type AllocTab, type AssetKind, type Dashboard, type JumpTarget, type Overview,
  type Prefix, type Spaces, type Thresholds, type View, type Vrf,
} from './types'
import ReconciliationView from './views/ReconciliationView'
import TicketsView from './views/TicketsView'
import SubnetPlannerView from './views/SubnetPlannerView'
import ReportsView from './views/ReportsView'
import AuditView from './views/AuditView'
import IntegrationsView from './views/IntegrationsView'
import SettingsView from './views/SettingsView'
import VrfPageView from './views/VrfPageView'
import ArchDrawer from './views/ArchDrawer'
import PrefixEditor, { type EditorState } from './views/PrefixEditor'
import AllocationReclaimView from './views/AllocationReclaimView'
import LoginView from './views/LoginView'
import UsersView from './views/UsersView'
import AssetView from './views/AssetView'
import DeviceRolesView from './views/DeviceRolesView'
import RackDetailView from './views/RackDetailView'
import LocationDetailView from './views/LocationDetailView'
import { sortPrefixes as sorted } from './views/shared'

interface Toast { id: number; msg: string; kind: 'ok' | 'error' }

const NAV: { key: View; label: string; icon: string; group: string;
  badge?: 'diffs' | 'tickets' }[] = [
  { key: 'dashboard', label: '概览看板', icon: 'grid', group: '工作台' },
  { key: 'spaces', label: '地址空间树', icon: 'layers', group: '地址管理' },
  { key: 'allocation', label: 'IP 分配/回收', icon: 'swap', group: '地址管理' },
  { key: 'subnets', label: '子网划分', icon: 'split', group: '地址管理' },
  { key: 'vrf', label: 'VRF 地址平面', icon: 'database', group: '地址管理' },
  { key: 'locations', label: '位置', icon: 'network', group: '设备管理' },
  { key: 'racks', label: '机柜', icon: 'database', group: '设备管理' },
  { key: 'devices', label: '设备', icon: 'cpu', group: '设备管理' },
  { key: 'links', label: '链路', icon: 'swap', group: '设备管理' },
  { key: 'device_roles', label: '角色', icon: 'tag', group: '设备管理' },
  { key: 'tickets', label: '分配申请', icon: 'ticket', group: '工单管理' },
  { key: 'approvals', label: '审批工单', icon: 'shield', group: '工单管理', badge: 'tickets' },
  { key: 'reconciliation', label: '发现与对账', icon: 'scan', group: '治理与对账', badge: 'diffs' },
  { key: 'audit', label: '审计日志', icon: 'audit', group: '治理与对账' },
  { key: 'reports', label: '报表中心', icon: 'chart', group: '分析与集成' },
  { key: 'integrations', label: '集成配置', icon: 'plug', group: '分析与集成' },
  { key: 'settings', label: '系统设置', icon: 'settings', group: '分析与集成' },
  { key: 'users', label: '用户与权限', icon: 'shield', group: '访问控制' },
]

const NAV_GROUPS = ['工作台', '地址管理', '设备管理', '工单管理', '治理与对账', '分析与集成', '访问控制']
/** 「工单管理」「设备管理」与「地址管理」「治理与对账」平级，样式与其它分组完全一致。 */
const ASSET_VIEWS: View[] = ['devices', 'racks', 'links', 'locations']

const VIEW_META: Record<View, { title: string; desc: string }> = {
  dashboard: { title: '概览看板', desc: '整体容量、状态分布、高负载网段与 14 天利用率趋势' },
  spaces: { title: '地址空间树', desc: '当前 VRF 地址平面内的多个顶级根空间 → 汇聚前缀 → 子网三级容量视图；行内可新增 / 编辑 / 删除前缀，点击行联动筛选地址记录，每个 IP 地址后可展开行操作' },
  allocation: { title: 'IP 分配/回收', desc: '同一页面内切换「IP 分配」与「IP 回收」标签：分配支持自动取号、手动指定 IP 与子网地址可视化；回收按 IP 精确查询并执行状态机流转，两者共用下方地址记录表；所有操作限定在当前地址平面' },
  subnets: { title: '子网划分', desc: 'CIDR 等分计算、与当前地址平面内已有前缀的重叠校验，勾选后批量划入该平面' },
  tickets: { title: '分配申请', desc: '提交分配 / 回收 / 扩容申请，进入审批队列；工单绑定到当前地址平面' },
  vrf: { title: 'VRF 地址平面', desc: '独立地址平面总览：每个 VRF 拥有彼此隔离的地址空间，同一 CIDR / IP 可跨平面重复登记；支持自定义页面文案、平面增删改与引用级联、逐平面容量统计，并可从顶栏切换当前平面' },
  devices: { title: '设备', desc: '网络设备资产台账：名称、角色、厂商型号、管理 IP、所属位置 / 机柜 U 位、所属 VRF 地址平面与运行状态；可按所属平面筛选与统计，角色字段从「角色」字典中下拉选择，管理 IP 自动回查同平面地址空间树，设备编号可再次编辑' },
  device_roles: { title: '角色', desc: '角色字典：维护新建 / 编辑设备时角色下拉的可选项，预置 8 个角色不可删除，自定义角色可新增、改名、停用与删除；改名自动同步已引用设备，删除前校验引用，停用后不再出现在下拉中' },
  racks: { title: '机柜', desc: '机柜容量与 U 位占用：点击清单进入机柜正视图二级页面，默认完整机柜模式，支持拖拽调整设备 U 位与选中设备直接编辑，机柜编号可再次编辑' },
  links: { title: '链路', desc: '设备端口互联关系：本端 / 对端设备与端口、链路类型、带宽、VLAN 与连通状态，链路编号可再次编辑' },
  locations: { title: '位置', desc: '园区 → 楼宇 → 楼层 → 机房四级位置层级；点击具体位置进入机柜横向平面图，可等宽查看并拖动调整机柜排列，位置编号可再次编辑' },
  reconciliation: { title: '发现与对账', desc: '外部观测回灌生成差异，人工处理后调用状态机完成闭环' },
  approvals: { title: '审批工单', desc: '对待审批工单决策；通过后由领域核心层真实执行分配、回收或扩容' },
  audit: { title: '审计日志', desc: '所有入口写操作的只追加留痕，按动作与关键词检索并导出' },
  reports: { title: '报表中心', desc: '按站点 / VLAN / VRF 地址平面 / 业务 / 状态 / 子网多维聚合，实时导出 CSV；除「按 VRF」跨平面对比外，其余维度只统计当前平面' },
  integrations: { title: '集成配置', desc: '启停数据源、手动触发采集与对账，查看 Webhook 告警事件；发现记录按地址平面隔离' },
  settings: { title: '系统设置', desc: '容量阈值、预留有效期、登录后默认进入的 VRF 地址平面与维护任务' },
  users: { title: '用户与权限', desc: '管理本地账号与角色，为只读用户手动分配可见模块和 CIDR 地址范围（支持「VRF:CIDR」按平面授权）；配置 LDAP / SSO 认证源' },
}

const VIEWS: View[] = [
  'dashboard', 'spaces', 'allocation', 'subnets', 'vrf',
  'devices', 'racks', 'links', 'locations', 'device_roles',
  'tickets', 'approvals',
  'reconciliation', 'audit', 'users', 'reports', 'integrations', 'settings',
]

/**
 * #allocation / #reclaim 都落到同一个「IP 分配/回收」页面，只是初始标签不同。
 * #reclaim 保留为历史链接与可分享的「直接打开回收标签」入口。
 */
function viewFromHash(): { view: View; tab: AllocTab; rackId: string | null;
  locationId: string | null } {
  const raw = window.location.hash.slice(1)
  if (raw === 'reclaim') {
    return { view: 'allocation', tab: 'reclaim', rackId: null, locationId: null }
  }
  if (raw === 'allocation') {
    return { view: 'allocation', tab: 'allocation', rackId: null, locationId: null }
  }
  // 机柜正视图是机柜清单的二级页面：#racks/<机柜编号>，可直接分享 / 刷新恢复
  if (raw.startsWith('racks/')) {
    const rackId = decodeURIComponent(raw.slice(6))
    if (rackId) return { view: 'racks', tab: 'allocation', rackId, locationId: null }
  }
  // 位置机柜平面图：#locations/<位置编号>
  if (raw.startsWith('locations/')) {
    const locationId = decodeURIComponent(raw.slice(10))
    if (locationId) return { view: 'locations', tab: 'allocation', rackId: null, locationId }
  }
  return {
    view: VIEWS.includes(raw as View) ? raw as View : 'dashboard',
    tab: 'allocation',
    rackId: null,
    locationId: null,
  }
}

/* ---------------------------------- 应用外壳 ---------------------------------- */

export default function App() {
  return (
    <AuthProvider>
      <ConsoleGate />
    </AuthProvider>
  )
}

/** 会话校验完成前不挂载主控制台，避免未登录态触发一堆 401 请求。 */
function ConsoleGate() {
  const { user, loading, error } = useAuth()
  if (loading) {
    return (
      <div className="boot-screen">
        <div className="boot-mark">IP</div>
        <p>正在验证会话…</p>
        {error && <small>{error}</small>}
      </div>
    )
  }
  if (!user) return <LoginView />
  return <MainConsole />
}

function MainConsole() {
  const { user, isAdmin, can, scope: visibleScope, setScope: setVisibleScope,
          vrf, setVrf, logout, changePassword } = useAuth()
  const [view, setView] = useState<View>(() => viewFromHash().view)
  const [allocTab, setAllocTab] = useState<AllocTab>(() => viewFromHash().tab)
  const [rackDetail, setRackDetail] = useState<string | null>(() => viewFromHash().rackId)
  const [locationDetail, setLocationDetail] = useState<string | null>(() => viewFromHash().locationId)
  const [scope, setScope] = useState('all')
  const [userMenu, setUserMenu] = useState(false)
  const [pwOpen, setPwOpen] = useState(false)
  const [pwForm, setPwForm] = useState({ old: '', next: '', confirm: '' })
  const [pwBusy, setPwBusy] = useState(false)
  const [pwError, setPwError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const [spaces, setSpaces] = useState<Spaces | null>(null)
  const [dash, setDash] = useState<Dashboard | null>(null)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [vrfList, setVrfList] = useState<Vrf[]>([])
  const [archOpen, setArchOpen] = useState(false)
  const [apiOk, setApiOk] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [jumpIp, setJumpIp] = useState<JumpTarget | null>(null)
  const [jumpAllocIp, setJumpAllocIp] = useState<JumpTarget | null>(null)
  const jumpSeq = useRef(0)

  const notify = useCallback((msg: string, kind: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random()
    setToasts(list => [...list, { id, msg, kind }])
    window.setTimeout(() => setToasts(list => list.filter(t => t.id !== id)), 3200)
  }, [])

  // 标签与两类二级页面都写入 hash，刷新 / 分享链接能直接回到对应位置
  useEffect(() => {
    const target = view === 'racks' && rackDetail
      ? '#racks/' + encodeURIComponent(rackDetail)
      : view === 'locations' && locationDetail
        ? '#locations/' + encodeURIComponent(locationDetail)
        : view === 'allocation'
          ? (allocTab === 'reclaim' ? '#reclaim' : '#allocation')
          : '#' + view
    if (window.location.hash !== target) {
      window.history.replaceState(null, '', target)
    }
  }, [view, allocTab, rackDetail, locationDetail])

  // 侧栏切到其它一级页面时，退出对应二级页面
  useEffect(() => {
    if (view !== 'racks' && rackDetail) setRackDetail(null)
    if (view !== 'locations' && locationDetail) setLocationDetail(null)
  }, [view, rackDetail, locationDetail])

  useEffect(() => {
    const onHash = () => {
      const next = viewFromHash()
      if (next.view === 'allocation') setAllocTab(next.tab)
      setView(next.view)
      setRackDetail(next.rackId)
      setLocationDetail(next.locationId)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    Promise.all([api.spaces(), api.dashboard(), api.overview()])
      .then(([s, d, o]) => {
        if (!alive) return
        setSpaces(s)
        setDash(d)
        setOverview(o)
        setApiOk(true)
        setError('')
      })
      .catch(err => {
        if (!alive) return
        setApiOk(false)
        setError(err instanceof Error ? err.message : '后端服务连接失败')
      })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [refreshKey])

  const refresh = useCallback(() => setRefreshKey(k => k + 1), [])

  // 地址平面清单只用于顶栏切换器；单独请求，避免权限不足时拖垮主数据加载
  useEffect(() => {
    let alive = true
    api.vrfs().then(res => { if (alive) setVrfList(res.items) }).catch(() => {})
    return () => { alive = false }
  }, [refreshKey])

  // 切换地址平面：清空前缀选中态，并让所有子视图按新的 X-IPAM-VRF 重新取数
  const vrfBoot = useRef(vrf)
  useEffect(() => {
    if (vrfBoot.current === vrf) return
    vrfBoot.current = vrf
    setScope('all')
    setVisibleScope('all')
    setJumpIp(null)
    setJumpAllocIp(null)
    refresh()
  }, [vrf, setVisibleScope, refresh])

  /** 编号再次编辑后同步二级页状态；hash 由上面的路由 effect 自动改写。 */
  const handleAssetRenamed = useCallback((kind: AssetKind, previousId: string, nextId: string) => {
    if (kind === 'racks') setRackDetail(cur => cur === previousId ? nextId : cur)
    if (kind === 'locations') setLocationDetail(cur => cur === previousId ? nextId : cur)
  }, [])

  // 搜索结果自带 vrf：跨平面命中时先切到目标平面，避免同 CIDR/IP 多平面串台
  const focusPlane = useCallback((targetVrf?: string) => {
    if (!targetVrf || targetVrf === 'all' || targetVrf === vrf) return
    setVrf(targetVrf)
    notify(`已切换到地址平面 ${targetVrf}`)
  }, [vrf, setVrf, notify])

  // 顶栏搜索结果跳转：地址段在地址空间树中选中；已登记 IP → 回收标签，可用池 IP → 分配标签
  const openIp = useCallback((addr: string, targetVrf?: string) => {
    focusPlane(targetVrf)
    setJumpIp({ addr, vrf: targetVrf, nonce: ++jumpSeq.current })
    setAllocTab('reclaim')
    setView('allocation')
  }, [focusPlane])
  const openPoolIp = useCallback((addr: string, targetVrf?: string) => {
    focusPlane(targetVrf)
    setJumpAllocIp({ addr, vrf: targetVrf, nonce: ++jumpSeq.current })
    setAllocTab('allocation')
    setView('allocation')
  }, [focusPlane])
  const openPrefix = useCallback((cidr: string, targetVrf?: string) => {
    focusPlane(targetVrf)
    setScope(cidr)
    setView('spaces')
  }, [focusPlane])

  // 离开合并页后清除跳转目标，避免下次进入时重复回填
  useEffect(() => {
    if (view !== 'allocation') {
      setJumpIp(null)
      setJumpAllocIp(null)
    }
  }, [view])

  // 只读用户直接输入了无权限页面的 hash 时，回落到第一个可见模块
  useEffect(() => {
    if (!can(view)) {
      const first = NAV.find(n => can(n.key))
      if (first) setView(first.key)
    }
  }, [view, can])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null
      if (el && !el.closest('.user-menu-wrap')) setUserMenu(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  const scopeOptions = useMemo(
    () => [...new Set((spaces?.prefixes ?? [])
      .filter(p => p.kind === 'subnet').map(p => p.cidr))],
    [spaces],
  )

  async function submitPassword(e: FormEvent) {
    e.preventDefault()
    if (pwForm.next !== pwForm.confirm) { setPwError('两次输入的新密码不一致'); return }
    setPwBusy(true); setPwError('')
    try {
      await changePassword(pwForm.old, pwForm.next)
      setPwOpen(false)
      setPwForm({ old: '', next: '', confirm: '' })
      notify('密码已修改')
    } catch (err) {
      setPwError(err instanceof Error ? err.message : '修改失败')
    } finally { setPwBusy(false) }
  }

  // ConsoleGate 已保证登录态；这里再收窄一次，避免 JSX 内反复判空
  if (!user) return null
  const meta = VIEW_META[view]

  return (
    <div className={`app console${isAdmin ? '' : ' readonly'}`}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">IP</div>
          <div>
            <div className="brand-name">IPv4 地址管理</div>
            <div className="brand-sub">IPAM Console · v0.1</div>
          </div>
        </div>
        <div className="env"><i className="dot" />生产地址空间 · {vrf === 'all' ? '全部 VRF（对比）' : `VRF ${vrf}`}</div>
        <nav className="nav">
          {NAV_GROUPS.map(group => {
            const items = NAV.filter(n => n.group === group && can(n.key))
            if (!items.length) return null
            return (
              <div className="nav-group" key={group}>
                <div className="nav-title">{group}</div>
                {items.map(n => {
                  const count = n.badge === 'diffs' ? overview?.open_diffs
                    : n.badge === 'tickets' ? overview?.pending_tickets : 0
                  return (
                    <button key={n.key}
                      className={`nav-item${view === n.key ? ' active' : ''}`}
                      onClick={() => {
                        if (n.key === 'allocation') setAllocTab('allocation')
                        // 再点「机柜」/「位置」侧栏时回到各自清单，而不是停留在二级页面
                        if (n.key === 'racks') setRackDetail(null)
                        if (n.key === 'locations') setLocationDetail(null)
                        setView(n.key)
                      }}>
                      <Icon name={n.icon} />{n.label}
                      {!!count && <span className="nav-badge">{count}</span>}
                    </button>
                  )
                })}
              </div>
            )
          })}
        </nav>
        <div className="side-foot">
          五层架构 · 认证与授权已启用<br />
          <code>v0.5 · {isAdmin ? '管理员' : '只读用户'} · {user.username}</code>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <span className="crumb">IPAM 控制台 / <b>{meta.title}</b></span>
          <GlobalSearch onOpenIp={openIp} onOpenPrefix={openPrefix} onOpenPoolIp={openPoolIp} />
          <div className="top-actions">
            <div className={`scope-switch vrf-switch${vrf === 'all' ? ' scope-all' : ''}`}
              id="global-vrf-switch" title="切换当前 VRF 地址平面；写操作必须先选定具体平面">
              <Icon name="database" size={13} />
              <select id="global-vrf-select" value={vrf}
                aria-label="当前 VRF 地址平面"
                onChange={e => {
                  const next = e.target.value
                  setVrf(next)
                  notify(next === 'all'
                    ? '已切换到全部 VRF 跨平面对比视图（只读）'
                    : `当前地址平面已切换为 ${next}`)
                }}>
                <option value="all">全部 VRF · 跨平面对比</option>
                {vrfList.map(v => <option key={v.name} value={v.name}>{v.name}</option>)}
                {!vrfList.some(v => v.name === vrf) && vrf !== 'all' && (
                  <option value={vrf}>{vrf}</option>
                )}
              </select>
            </div>
            {isAdmin && (
              <div className="scope-switch scope-all" id="admin-all-scope"
                title="管理员默认可见全部地址范围">
                <Icon name="network" size={13} /> 全部地址范围
              </div>
            )}
            {!isAdmin && user.scopes.length > 0 && (
              <div className="scope-switch" title="手动切换当前查看的地址范围">
                <Icon name="network" size={13} />
                <select id="visible-scope" value={visibleScope}
                  onChange={e => {
                    setVisibleScope(e.target.value)
                    refresh()
                    notify(e.target.value === 'all' ? '已切换为全部可见范围' : `查看范围已收窄至 ${e.target.value}`)
                  }}>
                  <option value="all">全部可见范围</option>
                  {scopeOptions.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            )}
            <span className={`api-state${apiOk ? '' : ' off'}`}>
              <i className="dot" />{apiOk ? 'API 已连接' : 'API 未连接'}
            </span>
            <button className="btn" onClick={() => setArchOpen(true)}>
              <Icon name="layers" />架构视图
            </button>
            <button className="icon-btn" title="刷新数据"
              onClick={() => { refresh(); notify('数据已刷新') }}>
              <Icon name="refresh" />
            </button>
            <div className="user-menu-wrap">
              <button className="user-chip" id="user-chip"
                onClick={() => setUserMenu(v => !v)}>
                <div className="avatar">{user.display_name.slice(0, 1)}</div>
                <span>{user.display_name}</span>
                <span className={`user-role-tag ${user.role}`}>{ROLE_LABEL[user.role]}</span>
                <Icon name="chevron" size={11} />
              </button>
              {userMenu && (
                <div className="user-menu-panel" id="user-menu">
                  <div className="user-menu-head">
                    <b>{user.display_name}</b>
                    <span>@{user.username} · {SOURCE_LABEL[user.source]}<br />
                      可见模块 {isAdmin ? '全部' : `${user.modules.length} 个`} ·
                      地址范围 {isAdmin ? '全部（不限）' : user.scopes.length ? user.scopes.join('、') : '不限'}</span>
                  </div>
                  <button className="user-menu-item" id="user-change-password"
                    onClick={() => { setUserMenu(false); setPwError(''); setPwOpen(true) }}>
                    <Icon name="shield" size={13} />修改密码
                  </button>
                  <button className="user-menu-item" id="user-logout"
                    onClick={() => { setUserMenu(false); void logout() }}>
                    <Icon name="undo" size={13} />退出登录
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className="content">
          {error && !spaces && (
            <div className="card">
              <div className="empty">
                <p>{error}</p>
                <p style={{ marginTop: 6 }}>请在项目根目录执行 <code>./start.sh</code> 后重试。</p>
                <button className="btn sm" style={{ marginTop: 12 }} onClick={refresh}>重新连接</button>
              </div>
            </div>
          )}
          {loading && !spaces && !error && (
            <div className="card"><div className="loading">正在加载地址空间数据…</div></div>
          )}

          {spaces && dash && (
            <>
              <div className="page-head">
                <div>
                  <h1>{meta.title}</h1>
                  <p>{meta.desc}</p>
                </div>
                {view === 'spaces' && (
                  <AdminOnly>
                    <button className="btn" onClick={() => { setAllocTab('allocation'); setView('allocation') }}>
                      <Icon name="plus" />去分配 IP
                    </button>
                  </AdminOnly>
                )}
                {view === 'allocation' && (
                  <div className="inline">
                    <button className="btn" id="goto-spaces" onClick={() => setView('spaces')}>
                      <Icon name="layers" />查看地址空间
                    </button>
                    <button className="btn" id="goto-counterpart"
                      onClick={() => setAllocTab(t => t === 'allocation' ? 'reclaim' : 'allocation')}>
                      <Icon name={allocTab === 'allocation' ? 'undo' : 'plus'} />
                      {allocTab === 'allocation' ? '切换到 IP 回收' : '切换到 IP 分配'}
                    </button>
                  </div>
                )}
                {(view === 'reconciliation' || view === 'approvals') && (
                  <button className="btn" onClick={() => setView(view === 'reconciliation' ? 'approvals' : 'reconciliation')}>
                    <Icon name="swap" />{view === 'reconciliation' ? '去审批工单' : '去发现对账'}
                  </button>
                )}
              </div>

              {vrf === 'all' && (
                <div className="readonly-banner all-vrf-banner" id="all-vrf-banner">
                  <Icon name="info" size={14} />
                  <span><b>跨平面对比视图</b> · 当前汇总显示全部 VRF 的数据，同一 CIDR / IP 可能重复出现；
                    建前缀、划子网、分配 / 回收、状态流转等写操作请先从顶栏切换到具体地址平面。</span>
                </div>
              )}
              {!isAdmin && (
                <div className="readonly-banner" id="readonly-banner">
                  <Icon name="shield" size={14} />
                  <span><b>只读模式</b> · 已授权 {user.modules.length} 个模块
                    {user.scopes.length ? `，可见地址段 ${user.scopes.join('、')}` : '，地址范围不限'}；
                    写操作由后端统一拒绝。可在顶栏手动切换当前查看范围。</span>
                </div>
              )}

              {view === 'dashboard' && <DashboardView dash={dash} spaces={spaces} plane={vrf} />}
              {view === 'spaces' && (
                <SpacesView spaces={spaces} dash={dash} thresholds={dash.thresholds}
                  scope={scope} setScope={setScope} plane={vrf} refreshKey={refreshKey}
                  onChanged={refresh} notify={notify} onOpenIp={openIp} />
              )}
              {view === 'vrf' && (
                <VrfPageView refreshKey={refreshKey} onChanged={refresh} notify={notify}
                  onOpenPrefix={(cidr, targetVrf) => {
                    if (targetVrf && targetVrf !== vrf) setVrf(targetVrf)
                    setScope(cidr)
                    setView('spaces')
                  }} />
              )}
              {view === 'allocation' && (
                <AllocationReclaimView spaces={spaces} dash={dash}
                  tab={allocTab} onTabChange={setAllocTab}
                  focusIp={jumpIp} focusAddr={jumpAllocIp}
                  onLocatePrefix={cidr => { setScope(cidr); setView('spaces') }}
                  refreshKey={refreshKey} onChanged={refresh} notify={notify} />
              )}
              {view === 'racks' && rackDetail ? (
                <RackDetailView rackId={rackDetail} refreshKey={refreshKey}
                  onChanged={refresh} notify={notify} onBack={() => setRackDetail(null)}
                  onNavigate={setView} onRenamed={handleAssetRenamed} />
              ) : view === 'locations' && locationDetail ? (
                <LocationDetailView locationId={locationDetail} refreshKey={refreshKey}
                  onChanged={refresh} notify={notify} onBack={() => setLocationDetail(null)}
                  onOpenRack={id => { setView('racks'); setRackDetail(id); setLocationDetail(null) }}
                  onOpenLocation={setLocationDetail} onNavigate={setView}
                  onRenamed={handleAssetRenamed} />
              ) : ASSET_VIEWS.includes(view) && (
                <AssetView kind={view as AssetKind} refreshKey={refreshKey}
                  onChanged={refresh} notify={notify} onNavigate={setView}
                  onRackDetail={setRackDetail} onLocationDetail={setLocationDetail}
                  onRenamed={handleAssetRenamed} />
              )}
              {view === 'device_roles' && (
                <DeviceRolesView refreshKey={refreshKey} onChanged={refresh} notify={notify}
                  onNavigate={setView} />
              )}
              {view === 'subnets' && (
                <SubnetPlannerView refreshKey={refreshKey} onChanged={refresh} notify={notify} />
              )}
              {view === 'tickets' && (
                <TicketsView focus="create" refreshKey={refreshKey} onChanged={refresh} notify={notify} />
              )}
              {view === 'approvals' && (
                <TicketsView focus="approve" refreshKey={refreshKey} onChanged={refresh} notify={notify} />
              )}
              {view === 'reconciliation' && (
                <ReconciliationView refreshKey={refreshKey} onChanged={refresh} notify={notify} />
              )}
              {view === 'audit' && (
                <AuditView refreshKey={refreshKey} onChanged={refresh} notify={notify} />
              )}
              {view === 'reports' && (
                <ReportsView refreshKey={refreshKey} onChanged={refresh} notify={notify} />
              )}
              {view === 'integrations' && (
                <IntegrationsView refreshKey={refreshKey} onChanged={refresh} notify={notify} />
              )}
              {view === 'settings' && (
                <SettingsView refreshKey={refreshKey} onChanged={refresh} notify={notify} />
              )}
              {view === 'users' && isAdmin && (
                <UsersView refreshKey={refreshKey} onChanged={refresh} notify={notify} />
              )}

              <p className="footnote">
                统计口径：当前地址平面 <b>{vrf === 'all' ? '全部 VRF（汇总）' : vrf}</b> 的纳管地址为 {dash.subnet_count} 个子网共 {dash.total.toLocaleString()} 个地址（网段规模按 CIDR 实时推导），
                扣除网络号 / 网关 / 广播 {dash.retained} 个；可用地址按前缀区间减去已登记占用实时推导，不预生成数据行。
                唯一键为 (VRF, CIDR) / (VRF, IP)，同一网段可跨平面复用；容量阈值 {dash.thresholds.warn}% / {dash.thresholds.crit}%。
              </p>
            </>
          )}
        </main>
      </div>

      <div className="toast-wrap">
        {toasts.map(t => <div key={t.id} className={`toast${t.kind === 'error' ? ' error' : ''}`}>{t.msg}</div>)}
      </div>

      <ArchDrawer open={archOpen} onClose={() => setArchOpen(false)}
        onNavigate={setView} current={view} />

      {pwOpen && (
        <div className="pw-modal" onClick={() => setPwOpen(false)}>
          <form className="pw-card" id="password-form"
            onClick={e => e.stopPropagation()} onSubmit={submitPassword}>
            <h3>修改密码</h3>
            <p className="help">密码至少 8 位，需同时包含字母和数字；修改后当前会话保持有效。</p>
            <div className="field"><label>原密码</label>
              <input id="pw-old" type="password" value={pwForm.old}
                onChange={e => setPwForm(f => ({ ...f, old: e.target.value }))} />
            </div>
            <div className="field"><label>新密码</label>
              <input id="pw-new" type="password" value={pwForm.next}
                onChange={e => setPwForm(f => ({ ...f, next: e.target.value }))} />
            </div>
            <div className="field"><label>确认新密码</label>
              <input id="pw-confirm" type="password" value={pwForm.confirm}
                onChange={e => setPwForm(f => ({ ...f, confirm: e.target.value }))} />
            </div>
            {pwError && <div className="check-note bad">{pwError}</div>}
            <div className="drawer-actions">
              <button type="button" className="btn ghost" onClick={() => setPwOpen(false)}>取消</button>
              <button type="submit" className="btn primary" disabled={pwBusy}>
                {pwBusy ? '保存中…' : '保存新密码'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}

/* -------------------------------- 视图一：地址空间树 -------------------------------- */

function SpacesView({ spaces, dash, thresholds, scope, setScope, plane, refreshKey,
  onChanged, notify, onOpenIp }: {
  spaces: Spaces
  dash: Dashboard
  thresholds: Thresholds
  scope: string
  setScope: (v: string) => void
  /** 当前全局地址平面；'all' 时树中会出现多个平面里的相同 CIDR */
  plane: string
  refreshKey: number
  onChanged: () => void
  notify: (msg: string, kind?: 'ok' | 'error') => void
  onOpenIp: (addr: string) => void
}) {
  const { isAdmin } = useAuth()
  const prefixes = useMemo(() => sorted(spaces.prefixes), [spaces.prefixes])
  // 树内不再提供 VRF 下拉筛选，地址平面统一由顶栏的全局切换器决定
  const visiblePrefixes = prefixes
  // 顶级空间可以有多个（如 RFC1918 三段私有地址），彼此平级、互不重叠
  const roots = useMemo(
    () => visiblePrefixes.filter(p => p.kind === 'root' || !p.parent_cidr), [visiblePrefixes])
  const current = prefixes.find(p => p.cidr === scope) ?? roots[0] ?? prefixes[0]
  const all = scope === 'all'
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [vrfs, setVrfs] = useState<Vrf[]>([])

  useEffect(() => {
    let alive = true
    api.vrfs().then(res => { if (alive) setVrfs(res.items) }).catch(() => {})
    return () => { alive = false }
  }, [refreshKey])

  const toggle = (cidr: string) => setCollapsed(c => ({ ...c, [cidr]: !c[cidr] }))
  // 跨平面汇总时父子关系必须落在同一个 VRF 内，避免相同 CIDR 的祖先串台
  const childrenOf = (cidr: string, vrf: string) =>
    visiblePrefixes.filter(p => p.parent_cidr === cidr && p.vrf === vrf)

  function row(p: Prefix, depth: number) {
    const kids = childrenOf(p.cidr, p.vrf)
    const open = !collapsed[`${p.vrf}:${p.cidr}`]
    const level = p.util >= thresholds.crit ? ' crit' : p.util >= thresholds.warn ? ' hot' : ''
    return (
      <div key={`${p.vrf}:${p.cidr}`}>
        <div
          className={`tree-row ${p.kind}${kids.length && !open ? ' collapsed' : ''}${scope === p.cidr ? ' selected' : ''}`}
          style={{ paddingLeft: 8 + depth * 20 }}
          onClick={() => setScope(p.cidr)}
        >
          <span className="tree-caret" onClick={e => {
            if (kids.length) { e.stopPropagation(); toggle(`${p.vrf}:${p.cidr}`) }
          }}>
            {kids.length > 0 && <Icon name="chevron" size={12} />}
          </span>
          <Icon name={p.kind === 'subnet' ? 'split' : p.kind === 'root' ? 'network' : 'layers'} size={14} />
          <span className="tree-cidr mono">{p.cidr}</span>
          {plane === 'all' && <span className="tree-vrf-tag mono">{p.vrf}</span>}
          <span className="tree-name">{p.name}{p.vlan ? ` · VLAN ${p.vlan}` : ''}</span>
          <div className={`minibar${level}`}><i style={{ width: `${Math.min(100, p.util)}%` }} /></div>
          <span className="tree-pct">{p.util}%</span>
          {isAdmin && (
            <div className="tree-actions">
              {p.kind !== 'subnet' && (
                <button className="tree-act" title="在此节点下新增前缀" onClick={e => {
                  e.stopPropagation(); setEditor({ mode: 'create', parent: p.cidr })
                }}><Icon name="plus" size={13} /></button>
              )}
              <button className="tree-act" title="编辑此前缀" onClick={e => {
                e.stopPropagation(); setEditor({ mode: 'edit', cidr: p.cidr })
              }}><Icon name="edit" size={13} /></button>
              {(p.kind !== 'root' || roots.length > 1) && (
                <button className="tree-act danger" title="删除此前缀" onClick={e => {
                  e.stopPropagation(); setEditor({ mode: 'edit', cidr: p.cidr, focusDelete: true })
                }}><Icon name="trash" size={13} /></button>
              )}
            </div>
          )}
        </div>
        {kids.length > 0 && open && kids.map(k => row(k, depth + 1))}
      </div>
    )
  }

  if (!current) return <div className="card"><div className="empty">暂无地址空间</div></div>

  // 清除范围时展示全局汇总，避免多根环境下误把某一个顶级空间当作全局数据
  const detail = all ? {
    cidr: `${roots.length} 个顶级空间`,
    name: '全部地址空间',
    kindLabel: '汇总视图',
    site: '全局',
    vlanVrf: '— / —',
    child_count: dash.subnet_count,
    occupied: dash.occupied,
    reserved: dash.reserved,
    free: dash.free,
    updated_at: null as string | null,
    util: dash.util,
    description: '',
  } : {
    cidr: current.cidr,
    name: current.name,
    kindLabel: PREFIX_KIND_LABEL[current.kind],
    site: current.site ?? '—',
    vlanVrf: `${current.vlan ?? '—'} / ${current.vrf}`,
    child_count: current.child_count,
    occupied: current.occupied,
    reserved: current.reserved,
    free: current.free,
    updated_at: current.updated_at,
    util: current.util,
    description: current.description ?? '',
  }

  return (
    <>
      <div className="grid-2">
        <Card title="地址空间树" tight extra={
          <div className="inline">
            <AdminOnly>
              <button className="btn sm ghost" onClick={() => setEditor({ mode: 'create', kind: 'root' })}>
                <Icon name="network" size={12} />新增顶级空间
              </button>
              <button className="btn sm" onClick={() => setEditor({ mode: 'create', parent: roots[0]?.cidr })}>
                <Icon name="plus" size={12} />新增前缀
              </button>
            </AdminOnly>
            <button className="btn sm ghost" onClick={() => setScope('all')}>清除范围</button>
          </div>
        }>
          <div className="toolbar tree-vrf-filter" id="tree-vrf-filter">
            <span className="hint">VRF 地址平面</span>
            <span className="hint">
              {plane === 'all'
                ? `跨平面对比 · 显示 ${visiblePrefixes.length} / ${prefixes.length} 个前缀 · 同一 CIDR 可出现在多个平面`
                : `当前平面 ${plane} · 共 ${prefixes.length} 个前缀 · 切换顶栏「当前地址平面」可查看其它 VRF`}
            </span>
          </div>
          {roots.length ? roots.map((r, i) => (
            <div key={`${r.vrf}:${r.cidr}`}>
              <div className={`tree-group-head${i === 0 ? ' first' : ''}`}>
                顶级地址空间 {i + 1} / {roots.length}
              </div>
              {row(r, 0)}
            </div>
          )) : <div className="empty">当前地址平面暂无地址空间</div>}
          <div className="tree-legend">
            <span><i style={{ background: 'var(--blue)' }} />正常 &lt;{thresholds.warn}%</span>
            <span><i style={{ background: 'var(--amber)' }} />预警 ≥{thresholds.warn}%</span>
            <span><i style={{ background: 'var(--red)' }} />告警 ≥{thresholds.crit}%</span>
            <span>点击行联动地址记录 · 行尾按钮可新增 / 编辑 / 删除前缀 · IP 后的「操作」可编辑登记信息</span>
          </div>
          <div className="footnote" style={{ margin: '0 18px 14px' }}>
            顶级空间容量按已划入的子网实时汇总；尚未划分子网的根空间显示 0%。
          </div>
        </Card>

        <div className="stack-col">
          <Card title={all ? '全局汇总' : '前缀详情'} extra={
            <div className="inline">
              <span className="hint">{all ? '点击左侧树选择具体前缀' : '当前选中'}</span>
              {!all && isAdmin && (
                <button className="btn sm" onClick={() => setEditor({ mode: 'edit', cidr: current.cidr })}>
                  <Icon name="edit" size={12} />编辑
                </button>
              )}
            </div>
          }>
            <div className="kv">
              <div><span>CIDR</span><b className={all ? '' : 'mono'}>{detail.cidr}</b></div>
              <div><span>名称</span><b>{detail.name}</b></div>
              <div><span>层级</span><b>{detail.kindLabel}</b></div>
              <div><span>站点</span><b>{detail.site}</b></div>
              <div><span>VLAN / 地址平面</span><b>{detail.vlanVrf}</b></div>
              <div><span>子网数</span><b>{!all && current.kind === 'subnet' ? '—' : detail.child_count}</b></div>
              <div><span>已登记占用</span><b>{detail.occupied.toLocaleString()}</b></div>
              <div><span>其中预留</span><b>{detail.reserved}</b></div>
              <div><span>可用地址</span><b>{detail.free.toLocaleString()}</b></div>
              <div><span>最后更新</span><b className="mono" style={{ fontSize: 11 }}>{detail.updated_at ?? '—'}</b></div>
            </div>
            {detail.description && (
              <div className="footnote" style={{ marginTop: 10 }}>备注：{detail.description}</div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-3)', marginTop: 12 }}>
              <span>利用率</span><b style={{ color: 'var(--text)' }}>{detail.util}%</b>
            </div>
            <Bar value={detail.util} level={levelOf(detail.util, thresholds.warn, thresholds.crit)} />
          </Card>

          <Card title="容量预警" hint={`≥${thresholds.warn}% 预警 / ≥${thresholds.crit}% 告警`}>
            {dash.alerts.length === 0 ? <div className="empty">当前无高负载网段</div> :
              dash.alerts.slice(0, 3).map(a => (
                <div className="warn-item" key={a.cidr}>
                  <div className="warn-head">
                    <b className="mono">{a.cidr}</b>
                    <span className={`lvl ${a.util >= thresholds.crit ? 'crit' : 'warn'}`}>{a.util}%</span>
                  </div>
                  <div className="warn-note">{a.name} · {a.site} · 剩余 {a.free} 个可用地址</div>
                  <Bar value={a.util} level={levelOf(a.util, thresholds.warn, thresholds.crit)} />
                </div>
              ))}
          </Card>
        </div>
      </div>

      <AddressTable prefix={scope} menu={isAdmin} actions={isAdmin} refreshKey={refreshKey}
        onChanged={onChanged} notify={notify} onOpenIp={onOpenIp} onLocatePrefix={setScope} />

      {editor && isAdmin && (
        <PrefixEditor state={editor} prefixes={prefixes} vrfs={vrfs}
          onClose={() => setEditor(null)}
          onSaved={({ cidr, previous }) => {
            setEditor(null)
            if (previous && previous !== cidr && scope === previous) setScope(cidr)
            onChanged()
          }}
          onDeleted={cidr => {
            setEditor(null)
            if (scope === cidr) setScope('all')
            onChanged()
          }}
          notify={notify} />
      )}
    </>
  )
}

/* ------------------------------- 视图三：利用率看板 ------------------------------- */

function TrendChart({ data }: { data: Dashboard['trend'] }) {
  if (data.length < 2) return <div className="empty">暂无趋势数据</div>
  const W = 560, H = 160, L = 36, R = 10, T = 12, B = 26
  const vals = data.map(d => d.util)
  const min = Math.floor((Math.min(...vals) - 1) / 5) * 5
  const max = Math.ceil((Math.max(...vals) + 1) / 5) * 5
  const span = Math.max(5, max - min)
  const ticks = Math.round(span / 5)
  const x = (i: number) => L + i * (W - L - R) / (data.length - 1)
  const y = (v: number) => T + (max - v) / span * (H - T - B)
  const pts = data.map((d, i) => `${x(i).toFixed(1)},${y(d.util).toFixed(1)}`).join(' ')
  const area = `${L},${H - B} ${pts} ${x(data.length - 1).toFixed(1)},${H - B}`

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}
      role="img" aria-label="14 天利用率趋势">
      {Array.from({ length: ticks + 1 }, (_, i) => {
        const yy = T + i * (H - T - B) / ticks
        return (
          <g key={i}>
            <line x1={L} y1={yy} x2={W - R} y2={yy} stroke="#E6EAF0" strokeDasharray="3 3" />
            <text x={2} y={yy + 3} fontSize="9" fill="#93A0B0">{max - i * 5}%</text>
          </g>
        )
      })}
      <polygon points={area} fill="#E6F1FB" />
      <polyline points={pts} fill="none" stroke="#185FA5" strokeWidth="2"
        strokeLinejoin="round" strokeLinecap="round" />
      {data.map((d, i) => (i % 3 === 0 || i === data.length - 1) ? (
        <circle key={i} cx={x(i)} cy={y(d.util)} r="2.5" fill="#fff" stroke="#185FA5" strokeWidth="1.5" />
      ) : null)}
      <text x={L} y={H - 6} fontSize="9" fill="#93A0B0">{data[0].day.slice(5)}</text>
      <text x={W - R} y={H - 6} fontSize="9" fill="#93A0B0" textAnchor="end">
        {data[data.length - 1].day.slice(5)}
      </text>
    </svg>
  )
}

function DashboardView({ dash, spaces, plane }: { dash: Dashboard; spaces: Spaces; plane: string }) {
  const th = dash.thresholds
  const parts = [
    { label: '已分配', n: dash.status.assigned ?? 0, color: 'var(--teal)' },
    { label: '预留', n: dash.status.reserved ?? 0, color: 'var(--amber)' },
    { label: '待回收', n: dash.status.deprecated ?? 0, color: '#A9A7A0' },
    { label: '冲突', n: dash.status.conflict ?? 0, color: 'var(--red)' },
    { label: '可用', n: dash.free, color: 'var(--blue)' },
  ]
  const sum = Math.max(1, parts.reduce((s, p) => s + p.n, 0))
  // 地址平面容量对比：每个 VRF 独立统计，同一 CIDR 可同时计入多个平面
  const vrfRows = useMemo(() => {
    // 分组覆盖全部前缀（根 / 汇聚也在平面内），容量只累计可分配子网，避免重复计数
    const map = new Map<string, { label: string; prefixes: number; subnets: number;
      occupied: number; free: number }>()
    spaces.prefixes.forEach(p => {
      const key = p.vrf || 'default'
      const b = map.get(key) ?? { label: key, prefixes: 0, subnets: 0, occupied: 0, free: 0 }
      b.prefixes += 1
      if (p.kind === 'subnet') {
        b.subnets += 1
        b.occupied += p.occupied
        b.free += p.free
      }
      map.set(key, b)
    })
    return [...map.values()].sort((a, b) => (b.prefixes - a.prefixes) || (b.occupied - a.occupied))
  }, [spaces.prefixes])
  const maxVrfPrefixes = Math.max(1, ...vrfRows.map(r => r.prefixes))

  return (
    <>
      <div className="metrics">
        <Metric label="纳管地址" value={dash.total.toLocaleString()} unit="个" icon="ip"
          foot={`${dash.subnet_count} 个子网 · 保留 ${dash.retained} 个`} />
        <Metric label="已登记占用" value={dash.occupied.toLocaleString()} unit="个" icon="network"
          foot={`其中预留 ${dash.reserved} 个 · 冲突 ${dash.status.conflict ?? 0} 个`} />
        <Metric label="可用地址" value={dash.free.toLocaleString()} unit="个" icon="plus"
          foot="由前缀区间实时推导，不落库" />
        <Metric label="整体利用率" value={dash.util} unit="%" icon="chart" bar={dash.util}
          level={levelOf(dash.util, th.warn, th.crit)} foot={`阈值：${th.warn}% 预警 / ${th.crit}% 告警`} />
      </div>

      <div className="grid-2">
        <Card title="14 天利用率趋势" hint="每日快照 · 扣除保留地址后口径">
          <TrendChart data={dash.trend} />
          <div className="trend-note">
            {dash.trend.length > 1
              ? `较 14 天前上升 ${(dash.trend[dash.trend.length - 1].util - dash.trend[0].util).toFixed(1)} 个百分点，已登记占用 ${dash.occupied - dash.trend[0].occupied >= 0 ? '+' : ''}${dash.occupied - dash.trend[0].occupied} 个。`
              : '暂无历史快照，分配地址后将按日沉淀利用率趋势数据。'}
          </div>
        </Card>

        <Card title="地址状态分布" hint="含未登记可用地址">
          <div className="stack">
            {parts.map(p => (
              <i key={p.label} style={{ width: `${p.n / sum * 100}%`, background: p.color }} />
            ))}
          </div>
          <div className="legend">
            {parts.map(p => (
              <div key={p.label}>
                <i style={{ background: p.color }} />{p.label}
                <b>{p.n.toLocaleString()}</b>
              </div>
            ))}
          </div>
          <p className="footnote">
            状态流转由后端状态机统一约束，页面不能直接改写 IP 状态；释放校验通过后删除地址行，即可回到可用池。
          </p>
        </Card>
      </div>

      <div className="grid-2 even">
        <Card title="网段利用率排行" hint="按利用率降序 · Top 8">
          {dash.ranking.slice(0, 8).map((r, i) => (
            <div className="rank-row" key={r.cidr}>
              <div className="label">
                <b className="mono">{r.cidr}</b>
                <span>{i + 1}. {r.name} · 余 {r.free}</span>
              </div>
              <div className="track">
                <i style={{
                  width: `${Math.min(100, r.util)}%`,
                  background: r.util >= th.crit ? 'var(--red)' : r.util >= th.warn ? 'var(--amber)' : 'var(--blue)',
                }} />
              </div>
              <div className="pct">{r.util}%</div>
            </div>
          ))}
        </Card>

        <div className="stack-col">
          <Card title="容量预警" hint="需要关注的网段">
            {dash.alerts.length === 0 ? <div className="empty">当前无高负载网段</div> :
              dash.alerts.map(a => (
                <div className="warn-item" key={a.cidr}>
                  <div className="warn-head">
                    <b className="mono">{a.cidr}</b>
                    <span className={`lvl ${a.util >= th.crit ? 'crit' : 'warn'}`}>
                      {a.util >= th.crit ? '告警' : '预警'} {a.util}%
                    </span>
                  </div>
                  <div className="warn-note">{a.site} · {a.name} · VLAN {a.vlan ?? '—'} · 仅余 {a.free} 个地址</div>
                  <Bar value={a.util} level={levelOf(a.util, th.warn, th.crit)} />
                </div>
              ))}
          </Card>
          <Card title="VRF 地址平面容量" hint={plane === 'all' ? '跨平面对比' : `当前平面 ${plane}`}>
            {vrfRows.length === 0 ? <div className="empty">暂无前缀数据</div> :
              vrfRows.map(r => (
                <div className="rank-row" key={r.label}>
                  <div className="label">
                    <b className="mono">{r.label}</b>
                    <span>{r.prefixes} 个前缀 · {r.subnets} 个子网 · 占用 {r.occupied} · 可用 {r.free}</span>
                  </div>
                  <div className="track">
                    <i style={{ width: `${r.prefixes / maxVrfPrefixes * 100}%`,
                      background: 'var(--blue)' }} />
                  </div>
                  <div className="pct">{r.prefixes}</div>
                </div>
              ))}
            <p className="footnote" style={{ marginTop: 10 }}>
              每个 VRF 是独立地址平面，唯一键为 (VRF, CIDR)：同一 CIDR / IP 可在不同平面重复登记且互不冲突。
              {plane !== 'all' && ' 切到顶栏「全部 VRF」可跨平面比较容量。'}
            </p>
          </Card>
          <Card title="口径说明" hint="统计与替换位">
            <p className="footnote" style={{ marginTop: 0, lineHeight: 1.8 }}>
              利用率 =（已登记占用 − 预留）/（网段地址数 − 保留地址）。<br />
              保留地址 = 网络号 + 默认网关 + 广播地址，网段规模按 CIDR 推导。<br />
              趋势为每日占用快照；分配、回收、状态流转与前缀变更均写入审计日志。<br />
              生产替换位：SSO/LDAP、PostgreSQL inet/GiST、Redis 分布式锁、定时邮件报表。
            </p>
          </Card>
        </div>
      </div>
    </>
  )
}
