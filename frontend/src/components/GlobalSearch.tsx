import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { useAuth } from '../auth'
import {
  PREFIX_KIND_LABEL, type SearchIp, type SearchPool, type SearchPrefix, type SearchResult,
} from '../types'
import { Icon, Pill } from './ui'

type Item =
  | { type: 'pool'; data: SearchPool }
  | { type: 'ip'; data: SearchIp }
  | { type: 'prefix'; data: SearchPrefix }

interface Props {
  onOpenIp: (addr: string, vrf?: string) => void
  onOpenPrefix: (cidr: string, vrf?: string) => void
  onOpenPoolIp: (addr: string, vrf?: string) => void
}

/** 全站顶栏模糊搜索：IP 地址、CIDR 地址段与可用池地址，结果带 VRF 并跳转到对应平面。 */
export default function GlobalSearch({ onOpenIp, onOpenPrefix, onOpenPoolIp }: Props) {
  const { vrf: plane } = useAuth()
  const [q, setQ] = useState('')
  const [data, setData] = useState<SearchResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // 防抖搜索：只做只读查询，卸载或输入变化后丢弃过期响应
  useEffect(() => {
    const text = q.trim()
    if (!text) { setData(null); setLoading(false); setError(''); return }
    let alive = true
    setLoading(true)
    const timer = window.setTimeout(() => {
      api.search(text)
        .then(res => { if (alive) { setData(res); setError('') } })
        .catch(err => {
          if (alive) {
            setData(null)
            setError(err instanceof Error ? err.message : '搜索失败')
          }
        })
        .finally(() => { if (alive) setLoading(false) })
    }, 220)
    return () => { alive = false; window.clearTimeout(timer) }
  }, [q])

  // 快捷键：⌘K / Ctrl+K 全局聚焦，非输入态按 / 也可聚焦
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const editable = !!el && (
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
        setOpen(true)
      } else if (e.key === '/' && !editable) {
        e.preventDefault()
        inputRef.current?.focus()
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  const flat = useMemo<Item[]>(() => {
    if (!data) return []
    const out: Item[] = []
    if (data.pool) out.push({ type: 'pool', data: data.pool })
    data.ips.forEach(x => out.push({ type: 'ip', data: x }))
    data.prefixes.forEach(x => out.push({ type: 'prefix', data: x }))
    return out
  }, [data])

  function choose(item: Item) {
    setOpen(false)
    setQ('')
    setData(null)
    setError('')
    setActive(0)
    inputRef.current?.blur()
    if (item.type === 'ip') onOpenIp(item.data.addr, item.data.vrf)
    else if (item.type === 'prefix') onOpenPrefix(item.data.cidr, item.data.vrf)
    else onOpenPoolIp(item.data.addr, item.data.vrf)
  }

  function row(item: Item, idx: number) {
    const cls = `gs-item${active === idx ? ' active' : ''}`
    // 汇总视图下同一 CIDR / IP 会来自多个地址平面，标签用于区分且键必须带上 vrf
    const vrfTag = plane === 'all'
      ? <span className="gs-tag light">VRF {item.data.vrf}</span> : null
    if (item.type === 'pool') {
      const p = item.data
      return (
        <button type="button" key={`pool-${p.vrf}-${p.addr}`} id="gs-pool-item" className={cls}
          onMouseEnter={() => setActive(idx)} onClick={() => choose(item)}>
          <div className="gs-item-main">
            <span className="mono gs-addr">{p.addr}</span>
            <span className="gs-tag teal">可用池 · 未登记</span>
            {vrfTag}
          </div>
          <div className="gs-item-sub">
            {p.finest
              ? `归属最细子网 ${p.finest} · 共 ${p.prefixes.length} 个包含网段 · 点击前往「IP 分配」标签并预填`
              : '不属于任何已纳管地址段 · 点击前往「IP 分配」标签并预填'}
          </div>
        </button>
      )
    }
    if (item.type === 'ip') {
      const ip = item.data
      return (
        <button type="button" key={`ip-${ip.vrf}-${ip.addr}`} className={cls}
          onMouseEnter={() => setActive(idx)} onClick={() => choose(item)}>
          <div className="gs-item-main">
            <span className="mono gs-addr">{ip.addr}</span>
            <Pill status={ip.status} />
            {vrfTag}
          </div>
          <div className="gs-item-sub">
            {ip.prefix_cidr} · {ip.hostname} · {ip.business} / {ip.owner} · 点击前往「IP 回收」标签查看状态
          </div>
        </button>
      )
    }
    const p = item.data
    return (
    <button type="button" key={`prefix-${p.vrf}-${p.cidr}`} className={cls}
          onMouseEnter={() => setActive(idx)} onClick={() => choose(item)}>
          <div className="gs-item-main">
            <span className="mono gs-addr">{p.cidr}</span>
            <span className="gs-tag">{PREFIX_KIND_LABEL[p.kind]}</span>
            <span className="gs-tag light">{p.relation}</span>
            {vrfTag}
          </div>
        <div className="gs-item-sub">
          {p.name} · {p.site ?? '—'} · VLAN {p.vlan ?? '—'} · 利用率 {p.util}% · 可用 {p.free} · 点击在地址空间树中定位
        </div>
      </button>
    )
  }

  const offsetIp = data?.pool ? 1 : 0
  const offsetPrefix = offsetIp + (data?.ips.length ?? 0)

  return (
    <div className="global-search" ref={boxRef} id="global-search">
      <div className={`gs-box${open ? ' focus' : ''}`} id="global-search-box">
        <Icon name="search" size={14} />
        <input id="global-search-input" ref={inputRef} value={q}
          role="combobox" aria-expanded={open && !!q.trim()} aria-label="全站搜索 IP 地址或地址段"
          placeholder="搜索 IP 地址或地址段…" autoComplete="off"
          onChange={e => { setQ(e.target.value); setOpen(true); setActive(0) }}
          onFocus={() => setOpen(true)}
          onKeyDown={e => {
            if (e.key === 'Escape') { setOpen(false); inputRef.current?.blur() }
            else if (e.key === 'ArrowDown') {
              e.preventDefault(); setOpen(true)
              setActive(i => Math.min(i + 1, Math.max(0, flat.length - 1)))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault(); setActive(i => Math.max(0, i - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const item = flat[active] ?? flat[0]
              if (item) choose(item)
            }
          }} />
        {q ? (
          <button type="button" className="gs-clear" id="gs-clear" title="清空"
            onClick={() => { setQ(''); setData(null); setOpen(false); inputRef.current?.focus() }}>×</button>
        ) : (
          <kbd className="gs-kbd">⌘K</kbd>
        )}
      </div>

      {open && !!q.trim() && (
        <div className="gs-panel" id="global-search-panel" role="listbox">
          {loading ? (
            <div className="gs-empty">正在搜索…</div>
          ) : error ? (
            <div className="gs-empty bad">{error}</div>
          ) : !data || flat.length === 0 ? (
            <div className="gs-empty" id="gs-no-result">
              未找到匹配的 IP 地址或地址段<br />
              <span>可尝试完整 IP、CIDR 网段、网段名称、主机名或业务系统</span>
            </div>
          ) : (
            <>
              {data.pool && (
                <div className="gs-group">
                  <div className="gs-group-head">可用池地址</div>
                  {row({ type: 'pool', data: data.pool }, 0)}
                </div>
              )}
              {data.ips.length > 0 && (
                <div className="gs-group">
                  <div className="gs-group-head">
                    IP 地址
                    <span>{data.ip_total > data.ips.length
                      ? `显示前 ${data.ips.length} / ${data.ip_total} 条` : `${data.ip_total} 条`}</span>
                  </div>
                  {data.ips.map((ip, i) => row({ type: 'ip', data: ip }, offsetIp + i))}
                </div>
              )}
              {data.prefixes.length > 0 && (
                <div className="gs-group">
                  <div className="gs-group-head">
                    地址段
                    <span>{data.prefix_total > data.prefixes.length
                      ? `显示前 ${data.prefixes.length} / ${data.prefix_total} 条` : `${data.prefix_total} 条`}</span>
                  </div>
                  {data.prefixes.map((p, i) => row({ type: 'prefix', data: p }, offsetPrefix + i))}
                </div>
              )}
              <div className="gs-foot">
                <span>↑↓ 选择 · Enter 打开 · Esc 关闭</span>
                <span>已登记 IP → 回收标签 · 地址段 → 地址空间树 · 可用池 → 分配标签 · 均落在「IP 分配/回收」</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
