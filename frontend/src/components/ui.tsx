import {
  useEffect, useLayoutEffect, useRef, useState,
  type FormEvent, type MouseEvent as ReactMouseEvent, type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api'
import { useAuth } from '../auth'
import {
  STATUS_LABEL, type Action, type IPList, type IPRecord, type IPUpdatePayload, type Status,
} from '../types'

const ICONS: Record<string, ReactNode> = {
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
  layers: <><path d="m12 3 9 5-9 5-9-5z"/><path d="M3 12l9 5 9-5M3 16l9 5 9-5"/></>,
  network: <><rect x="9" y="3" width="6" height="5" rx="1"/><rect x="3" y="16" width="6" height="5" rx="1"/><rect x="15" y="16" width="6" height="5" rx="1"/><path d="M12 8v4M6 16v-2h12v2"/></>,
  swap: <><path d="M4 8h14M14 4l4 4-4 4M20 16H6M10 12l-4 4 4 4"/></>,
  chart: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></>,
  search: <><circle cx="11" cy="11" r="7"/><path d="m16.5 16.5 4 4"/></>,
  refresh: <><path d="M20 11a8 8 0 1 0-2 6M20 4v7h-7"/></>,
  plus: <><path d="M12 5v14M5 12h14"/></>,
  check: <><path d="m4 12 5 5L20 6"/></>,
  undo: <><path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3"/></>,
  alert: <><path d="M12 3 2 20h20zM12 9v5M12 17h.01"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  chevron: <path d="m6 9 6 6 6-6"/>,
  ip: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h4"/></>,
  split: <><path d="M4 4h6v6H4zM14 14h6v6h-6zM10 7h4a3 3 0 0 1 3 3v4"/></>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></>,
  download: <><path d="M12 3v12M7 11l5 5 5-5M4 20h16"/></>,
  scan: <><path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3M3 12h18"/></>,
  ticket: <><path d="M4 6h16v3a2 2 0 0 0 0 4v3H4v-3a2 2 0 0 0 0-4zM11 6v2M11 11v2M11 16v2"/></>,
  plug: <><path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6zM12 17v4"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1 1.56V21h-4v-.09a1.7 1.7 0 0 0-1-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1H3v-4h.09a1.7 1.7 0 0 0 1.56-1 1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.56V3h4v.09a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9v.09A1.7 1.7 0 0 0 21 10h.09"/></>,
  audit: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5"/></>,
  shield: <><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/></>,
  close: <><path d="M6 6l12 12M18 6 6 18"/></>,
  edit: <><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></>,
  trash: <><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6"/></>,
  database: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></>,
  cpu: <><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/></>,
  tag: <><path d="M20 13 13 20 3 10V4h6z"/><circle cx="7.5" cy="7.5" r="1.1"/></>,
}

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg className="ico" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {ICONS[name] ?? ICONS.info}
    </svg>
  )
}

export function Card({ title, hint, extra, children, className = '', tight = false }: {
  title?: string; hint?: string; extra?: ReactNode; children: ReactNode; className?: string; tight?: boolean
}) {
  return (
    <div className={`card ${className}`}>
      {title && (
        <div className="card-head">
          <h2>{title}</h2>
          {extra ?? (hint && <span className="hint">{hint}</span>)}
        </div>
      )}
      <div className={`card-body${tight ? ' tight' : ''}`}>{children}</div>
    </div>
  )
}

export function Metric({ label, value, unit, foot, icon, bar, level }: {
  label: string; value: string | number; unit?: string; foot?: string; icon?: string
  bar?: number; level?: 'warn' | 'crit'
}) {
  return (
    <div className="card metric">
      <div className="metric-top"><span>{label}</span>{icon && <Icon name={icon} />}</div>
      <div className="metric-num">{value}{unit && <small>{unit}</small>}</div>
      {foot && <div className="metric-foot">{foot}</div>}
      {bar !== undefined && (
        <div className={`bar${level ? ' ' + level : ''}`}>
          <i style={{ width: `${Math.min(100, bar)}%` }} />
        </div>
      )}
    </div>
  )
}

export function Pill({ status }: { status: Status }) {
  return <span className={`pill ${status}`}><i />{STATUS_LABEL[status] ?? status}</span>
}

export function Bar({ value, level }: { value: number; level?: 'warn' | 'crit' }) {
  return <div className={`bar${level ? ' ' + level : ''}`}><i style={{ width: `${Math.min(100, value)}%` }} /></div>
}

export function levelOf(value: number, warn = 80, crit = 90): 'warn' | 'crit' | undefined {
  return value >= crit ? 'crit' : value >= warn ? 'warn' : undefined
}

export function Tag({ text, tone = 'neutral' }: { text: string; tone?: 'neutral' | 'red' | 'amber' | 'teal' | 'blue' }) {
  return <span className={`tag ${tone}`}>{text}</span>
}

export function MiniStat({ label, value, foot, tone }: {
  label: string; value: string | number; foot?: string; tone?: 'red' | 'amber' | 'teal' | 'blue'
}) {
  return (
    <div className={`mini-stat${tone ? ' ' + tone : ''}`}>
      <span>{label}</span>
      <b>{value}</b>
      {foot && <small>{foot}</small>}
    </div>
  )
}

export function Segmented<T extends string>({ value, options, onChange }: {
  value: T; options: { key: T; label: string }[]; onChange: (v: T) => void
}) {
  return (
    <div className="seg">
      {options.map(o => (
        <button key={o.key} className={value === o.key ? 'on' : ''} onClick={() => onChange(o.key)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Drawer({ open, title, sub, onClose, children }: {
  open: boolean; title: string; sub?: string; onClose: () => void; children: ReactNode
}) {
  if (!open) return null
  return (
    <div className="drawer-mask" onClick={onClose}>
      <aside className="drawer" onClick={e => e.stopPropagation()}>
        <div className="drawer-head">
          <div><h2>{title}</h2>{sub && <p>{sub}</p>}</div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭"><Icon name="close" /></button>
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  )
}

const TABS: { key: string; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'assigned', label: '已分配' },
  { key: 'reserved', label: '预留' },
  { key: 'deprecated', label: '待回收' },
  { key: 'conflict', label: '冲突' },
]

export const ROW_ACTION: Record<string, { action: Action; label: string }> = {
  assigned: { action: 'release', label: '发起回收' },
  reserved: { action: 'confirm', label: '确认分配' },
  deprecated: { action: 'reclaim', label: '释放归还' },
  conflict: { action: 'resolve', label: '处理冲突' },
}

/* -------------------- 地址记录行操作：IP 地址后的下拉选项 -------------------- */

interface RowActionHandlers {
  onEdit: (record: IPRecord) => void
  onTransition: (addr: string, action: Action) => void
  onCopy: (addr: string) => void
  onLocatePrefix?: (cidr: string) => void
  onOpenIp?: (addr: string) => void
}

/** 挂在 IP 地址文本之后；下拉用 portal + fixed 定位，避免被表格的 overflow 容器裁剪。 */
function AddressRowActions({ record, busy, ...handlers }: {
  record: IPRecord
  busy: boolean
} & RowActionHandlers) {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState({ left: 0, top: 0, bottom: 0 })
  const [pos, setPos] = useState({ left: 0, top: 0 })
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const op = ROW_ACTION[record.status]

  function toggle(e: ReactMouseEvent<HTMLButtonElement>) {
    e.stopPropagation()
    if (open) { setOpen(false); return }
    const rect = e.currentTarget.getBoundingClientRect()
    // 先用预估高度决定方向，避免菜单首帧就超出视口底部；渲染后由 layout effect 精修
    const EST_W = 214, EST_H = 350
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - EST_W - 8))
    const desired = rect.bottom + 5 + EST_H > window.innerHeight - 8
      ? rect.top - EST_H - 5
      : rect.bottom + 5
    const top = Math.max(8, Math.min(desired, window.innerHeight - EST_H - 8))
    setAnchor({ left: rect.left, top: rect.top, bottom: rect.bottom })
    setPos({ left, top })
    setOpen(true)
  }

  // 菜单渲染后按真实尺寸修正位置：靠近视口右侧 / 底部时自动翻转
  useLayoutEffect(() => {
    if (!open || !menuRef.current) return
    const box = menuRef.current.getBoundingClientRect()
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - box.width - 8))
    const desired = anchor.bottom + 5 + box.height > window.innerHeight - 8
      ? anchor.top - box.height - 5
      : anchor.bottom + 5
    // 收敛到视口内：表格行可能在首屏之外，此时不跟随按钮而贴住视口底部
    const top = Math.max(8, Math.min(desired, window.innerHeight - box.height - 8))
    setPos(p => (p.left === left && p.top === top ? p : { left, top }))
  }, [open, anchor])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (menuRef.current?.contains(target) || btnRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const close = () => setOpen(false)
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [open])

  const run = (fn: () => void) => { setOpen(false); fn() }

  return (
    <>
      <button ref={btnRef} type="button" className={`ip-act-btn${open ? ' on' : ''}`}
        title={`${record.addr} 的操作选项`} aria-expanded={open} onClick={toggle}>
        操作<Icon name="chevron" size={11} />
      </button>
      {open && createPortal(
        <div className="ip-menu" id="ip-row-menu" ref={menuRef}
          style={{ left: pos.left, top: pos.top }} onClick={e => e.stopPropagation()}>
          <div className="ip-menu-head">
            <b className="mono">{record.addr}</b><span>{STATUS_LABEL[record.status]}</span>
          </div>

          <div className="ip-menu-group">登记信息</div>
          <button className="ip-menu-item" onClick={() => run(() => handlers.onEdit(record))}>
            <Icon name="edit" size={13} />
            <span><b>编辑登记信息</b><small>主机名 / 业务 / 负责人 / VLAN</small></span>
          </button>

          {op && (
            <>
              <div className="ip-menu-group">状态流转</div>
              <button className="ip-menu-item" disabled={busy}
                onClick={() => run(() => handlers.onTransition(record.addr, op.action))}>
                <Icon name="undo" size={13} />
                <span><b>{op.label}</b><small>按状态机流转并写审计留痕</small></span>
              </button>
            </>
          )}

          <div className="ip-menu-group">快捷操作</div>
          <button className="ip-menu-item" onClick={() => run(() => handlers.onCopy(record.addr))}>
            <Icon name="ip" size={13} />
            <span><b>复制 IP 地址</b><small>写入系统剪贴板</small></span>
          </button>
          {handlers.onLocatePrefix && (
            <button className="ip-menu-item"
              onClick={() => run(() => handlers.onLocatePrefix?.(record.prefix_cidr))}>
              <Icon name="layers" size={13} />
              <span><b>定位所属网段</b><small>{record.prefix_cidr}</small></span>
            </button>
          )}
          {handlers.onOpenIp && (
            <button className="ip-menu-item" onClick={() => run(() => handlers.onOpenIp?.(record.addr))}>
              <Icon name="swap" size={13} />
              <span><b>前往 IP 分配/回收</b><small>切到回收标签并精确查询此地址</small></span>
            </button>
          )}
        </div>, document.body,
      )}
    </>
  )
}

/** 编辑抽屉：只允许改描述性字段，状态变更仍走状态机。 */
function IPEditDrawer({ record, onClose, onSaved, notify }: {
  record: IPRecord
  onClose: () => void
  onSaved: () => void
  notify: (msg: string, kind?: 'ok' | 'error') => void
}) {
  const origin = {
    hostname: record.hostname ?? '',
    business: record.business ?? '',
    owner: record.owner ?? '',
    vlan: record.vlan == null ? '' : String(record.vlan),
  }
  const [form, setForm] = useState(origin)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const set = (key: keyof typeof origin, value: string) => setForm(f => ({ ...f, [key]: value }))
  const LABELS = { hostname: '主机名', business: '业务系统', owner: '负责人' } as const

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setErr('')
    const payload: IPUpdatePayload = {}
    for (const key of ['hostname', 'business', 'owner'] as const) {
      const value = form[key].trim()
      if (value !== origin[key]) payload[key] = value
    }
    if (form.vlan.trim() !== origin.vlan) {
      payload.vlan = form.vlan.trim() === '' ? null : form.vlan.trim()
    }
    if (Object.keys(payload).length === 0) {
      notify('没有需要修改的字段'); onClose(); return
    }
    for (const key of ['hostname', 'business', 'owner'] as const) {
      const value = payload[key]
      if (value === '') { setErr(`${LABELS[key]}不能为空`); return }
      if (value !== undefined && value.length > 64) {
        setErr(`${LABELS[key]}长度不能超过 64 个字符`); return
      }
    }
    if (payload.vlan !== undefined && payload.vlan !== null &&
      (!/^\d+$/.test(String(payload.vlan)) || Number(payload.vlan) < 1 || Number(payload.vlan) > 4094)) {
      setErr('VLAN 必须是 1–4094 的整数，留空表示清除'); return
    }
    setBusy(true)
    try {
      const res = await api.updateIp(record.addr, payload)
      notify(`${record.addr} 登记信息已更新（${res.changes.length} 项变更）`)
      onSaved()
    } catch (error) {
      setErr(error instanceof Error ? error.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer open title="编辑 IP 登记信息"
      sub={`${record.addr} · ${STATUS_LABEL[record.status]} · ${record.prefix_cidr}`}
      onClose={onClose}>
      <div className="ip-edit-meta">
        <div><span>IP 地址</span><b className="mono">{record.addr}</b></div>
        <div><span>当前状态</span><Pill status={record.status} /></div>
        <div><span>所属前缀</span><b className="mono">{record.prefix_cidr}</b></div>
        <div><span>地址平面</span><b className="mono">{record.vrf}</b></div>
        <div><span>最后更新</span><b>{record.updated_at}</b></div>
      </div>
      <form onSubmit={submit} style={{ marginTop: 16 }}>
        <div className="field">
          <label>主机名</label>
          <input value={form.hostname} disabled={busy}
            onChange={e => set('hostname', e.target.value)} placeholder="例如 srv-core-01" />
        </div>
        <div className="field">
          <label>业务系统</label>
          <input value={form.business} disabled={busy}
            onChange={e => set('business', e.target.value)} placeholder="例如 核心交易平台" />
        </div>
        <div className="field">
          <label>负责人</label>
          <input value={form.owner} disabled={busy}
            onChange={e => set('owner', e.target.value)} placeholder="例如 张伟" />
        </div>
        <div className="field">
          <label>VLAN（1–4094，留空表示清除）</label>
          <input value={form.vlan} disabled={busy} inputMode="numeric"
            onChange={e => set('vlan', e.target.value)} placeholder="例如 101" />
          <div className="help">留空只清除该地址记录的 VLAN 标记，不会改动所属前缀的配置。</div>
        </div>
        {err && <div className="check-note bad" style={{ marginBottom: 12 }}>{err}</div>}
        <div className="drawer-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>取消</button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? '保存中…' : '保存变更'}
          </button>
        </div>
      </form>
      <div className="footnote" style={{ marginTop: 14 }}>
        仅修改描述性字段；状态变更请通过菜单中的状态流转，或「IP 分配/回收」页的回收标签执行。保存会写入审计日志与 Webhook 事件。
      </div>
    </Drawer>
  )
}

export function AddressTable({ prefix, actions = false, menu = false, refreshKey,
  onChanged, notify, onOpenIp, onLocatePrefix }: {
  prefix?: string
  actions?: boolean
  /** 在 IP 地址文本之后显示「操作」下拉选项（地址空间树页面使用） */
  menu?: boolean
  refreshKey: number
  onChanged?: () => void
  notify: (msg: string, kind?: 'ok' | 'error') => void
  onOpenIp?: (addr: string) => void
  onLocatePrefix?: (cidr: string) => void
}) {
  // 只读用户与「全部 VRF」汇总视图一律不显示行内写操作，后端同时用 403 兜底
  const { isAdmin, vrf: plane } = useAuth()
  const planeWritable = plane !== 'all'
  const writable = actions && isAdmin && planeWritable
  const rowMenu = menu && isAdmin && planeWritable
  const showVrfCol = plane === 'all'
  const [status, setStatus] = useState('all')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [tick, setTick] = useState(0)
  const [data, setData] = useState<IPList | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [editing, setEditing] = useState<IPRecord | null>(null)

  useEffect(() => setPage(1), [prefix, status, q])

  useEffect(() => {
    let alive = true
    setLoading(true)
    api.ips({ prefix, status, q, page, page_size: 8 })
      .then(res => { if (alive) setData(res) })
      .catch(err => { if (alive) notify(err.message, 'error') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
    // notify 由父组件用 useCallback 保持稳定
  }, [prefix, status, q, page, refreshKey, tick, notify])

  async function act(addr: string, action: Action, vrf?: string) {
    setBusy(`${vrf ?? plane}:${addr}`)
    try {
      const res = await api.transition(addr, action)
      notify(`${addr} · ${res.label}`)
      setTick(t => t + 1)
      onChanged?.()
    } catch (err) {
      notify(err instanceof Error ? err.message : '操作失败', 'error')
    } finally {
      setBusy(null)
    }
  }

  function copyAddr(addr: string) {
    const done = () => notify(`${addr} 已复制到剪贴板`)
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(addr).then(done).catch(() => fallbackCopy(addr))
      return
    }
    fallbackCopy(addr)
  }

  function fallbackCopy(addr: string) {
    try {
      const ta = document.createElement('textarea')
      ta.value = addr
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      if (ok) notify(`${addr} 已复制到剪贴板`)
      else notify(`当前环境无法自动复制，请手动复制 ${addr}`, 'error')
    } catch {
      notify(`当前环境无法自动复制，请手动复制 ${addr}`, 'error')
    }
  }

  const rows = data?.items ?? []
  const pages = data?.pages ?? 1
  const colCount = 8 + (showVrfCol ? 1 : 0) + (writable ? 1 : 0)
  const rowKey = (r: IPRecord) => `${r.vrf}:${r.addr}`
  const pageStart = Math.max(1, Math.min(page - 2, pages - 4))
  const pageNums = Array.from({ length: Math.min(5, pages) }, (_, i) => pageStart + i).filter(p => p <= pages)
  return (
    <>
    <div className="card">
      <div className="card-head">
        <h2>地址记录</h2>
        <span className="hint">
          {!planeWritable ? '跨平面对比视图：行内写操作已隐藏，请从顶栏选定具体 VRF 地址平面'
            : rowMenu ? 'IP 地址后可展开操作选项：编辑登记信息、状态流转与快捷定位'
              : isAdmin ? '可用地址不落库，由前缀区间减去占用集合推导'
                : '只读模式：可查询与筛选，写操作已隐藏'}
        </span>
      </div>
      <div className="table-tools">
        <div className="tabs">
          {TABS.map(t => (
            <button key={t.key} className={`tab${status === t.key ? ' active' : ''}`} onClick={() => setStatus(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
        {prefix && <span className="scope">范围：<b>{prefix === 'all' ? '全部地址空间' : prefix}</b></span>}
        <div className="search">
          <Icon name="search" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索 IP / 主机 / 业务 / 负责人" />
        </div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>IP 地址</th>{showVrfCol && <th>地址平面</th>}<th>状态</th><th>主机名</th><th>所属前缀</th>
              <th>业务系统</th><th>负责人</th><th>VLAN</th><th>最后更新</th>
              {writable && <th>操作</th>}
            </tr>
          </thead>
          <tbody>
            {loading && !data ? (
              <tr><td colSpan={colCount}><div className="loading">加载中…</div></td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={colCount}><div className="empty">没有符合条件的地址记录</div></td></tr>
            ) : rows.map(r => {
              const op = ROW_ACTION[r.status]
              return (
                <tr key={rowKey(r)}>
                  <td className="mono ip-addr-cell">
                    <span className="ip-addr-text">{r.addr}</span>
                    {rowMenu && (
                      <AddressRowActions record={r} busy={busy === rowKey(r)}
                        onEdit={setEditing}
                        onTransition={(addr, action) => void act(addr, action, r.vrf)}
                        onCopy={copyAddr}
                        onLocatePrefix={onLocatePrefix}
                        onOpenIp={onOpenIp} />
                    )}
                  </td>
                  {showVrfCol && <td className="mono" style={{ color: 'var(--text-2)' }}>{r.vrf}</td>}
                  <td><Pill status={r.status} /></td>
                  <td>{r.hostname}</td>
                  <td className="mono" style={{ color: 'var(--text-2)' }}>{r.prefix_cidr}</td>
                  <td>{r.business}</td>
                  <td>{r.owner}</td>
                  <td>{r.vlan}</td>
                  <td style={{ color: 'var(--text-3)' }}>{r.updated_at}</td>
                  {writable && (
                    <td>
                      {op ? (
                        <button className="row-act" disabled={busy === rowKey(r)}
                          onClick={() => act(r.addr, op.action, r.vrf)}>{op.label}</button>
                      ) : <span style={{ color: 'var(--text-3)', fontSize: 11 }}>—</span>}
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="table-foot">
        <span>共 {data?.total ?? 0} 条 · 第 {data?.page ?? 1} / {data?.pages ?? 1} 页</span>
        <div className="pager">
          <button disabled={page <= 1} onClick={() => setPage(p => p - 1)}>上一页</button>
          {pageNums.map(p => (
            <button key={p} className={p === page ? 'on' : ''} onClick={() => setPage(p)}>{p}</button>
          ))}
          <button disabled={page >= (data?.pages ?? 1)} onClick={() => setPage(p => p + 1)}>下一页</button>
        </div>
      </div>
    </div>
    {editing && (
      <IPEditDrawer key={rowKey(editing)} record={editing} notify={notify}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); setTick(t => t + 1); onChanged?.() }} />
    )}
    </>
  )
}
