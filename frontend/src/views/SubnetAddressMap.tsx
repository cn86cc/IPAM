import { useEffect, useState } from 'react'
import { api } from '../api'
import { Card, Icon } from '../components/ui'
import type { AddressCell, AddressMap } from '../types'
import type { Notify } from './shared'

interface Props {
  cidr: string
  currentAddr: string
  onPick: (addr: string) => void
  refreshKey: number
  notify: Notify
}

const LEGEND: { state: string; label: string }[] = [
  { state: 'available', label: '可用' },
  { state: 'assigned', label: '已分配' },
  { state: 'reserved', label: '预留' },
  { state: 'deprecated', label: '待回收' },
  { state: 'conflict', label: '冲突' },
  { state: 'retained', label: '保留地址' },
  { state: 'child', label: '更细子网' },
]

function detailOf(cell: AddressCell, map: AddressMap): string {
  if (cell.state === 'available') {
    return `该地址在可用池中，可直接指定分配。可分配范围 ${map.info.first_host} – ${map.info.last_host}；当前块可用 ${map.block_counts.available ?? 0} 个。`
  }
  if (cell.state === 'retained') {
    return `${cell.addr} 是 ${map.cidr} 的${cell.retained_label ?? '保留地址'}，属保留地址，不参与分配。`
  }
  if (cell.state === 'child') {
    return `该地址已划入更细子网 ${cell.child_prefix ?? '—'}，请切换到该子网后再分配。`
  }
  return [
    `登记归属 ${cell.prefix_cidr ?? map.cidr}`,
    `主机名 ${cell.hostname ?? '—'}`,
    `业务系统 ${cell.business ?? '—'}`,
    `负责人 ${cell.owner ?? '—'}`,
    `更新于 ${cell.updated_at ?? '—'}`,
    '如需释放该地址，请切换到本页顶部「IP 回收」标签执行状态流转。',
  ].join(' · ')
}

/** 手动指定 IP 时展示所选子网内全部地址的使用状况（按 256 地址块可视化）。 */
export default function SubnetAddressMap({
  cidr, currentAddr, onPick, refreshKey, notify,
}: Props) {
  const [data, setData] = useState<AddressMap | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [block, setBlock] = useState(0)
  const [picked, setPicked] = useState<AddressCell | null>(null)
  const [tick, setTick] = useState(0)

  // 切换目标子网时回到第一块并清空选中态
  useEffect(() => {
    setData(null); setPicked(null); setBlock(0)
  }, [cidr])

  // 表单里手工输入地址时，以输入框为准，取消上一次格子选中
  useEffect(() => { setPicked(null) }, [currentAddr, cidr])

  useEffect(() => {
    if (!cidr) return
    let alive = true
    setLoading(true)
    setError('')
    api.addressMap(cidr, block)
      .then(res => { if (alive) setData(res) })
      .catch(err => {
        if (!alive) return
        const msg = err instanceof Error ? err.message : '子网地址加载失败'
        setData(null)
        setError(msg)
        notify(msg, 'error')
      })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [cidr, block, refreshKey, tick, notify])

  const active = picked ?? data?.cells.find(c => c.addr === currentAddr.trim()) ?? null
  const counts = data?.counts

  return (
    <Card className="ipmap-card" title="可视化子网显示" extra={
      <div className="inline" style={{ gap: 8 }}>
        {data && data.block_count > 1 && (
          <>
            <button type="button" className="btn sm" id="ipmap-prev"
              disabled={loading || block <= 0}
              onClick={() => setBlock(b => Math.max(0, b - 1))}>上一块</button>
            <select id="ipmap-block" value={block} disabled={loading}
              onChange={e => setBlock(Number(e.target.value))}>
              {data.blocks.map(b => (
                <option key={b.index} value={b.index}>{b.label}</option>
              ))}
            </select>
            <button type="button" className="btn sm" id="ipmap-next"
              disabled={loading || block >= data.block_count - 1}
              onClick={() => setBlock(b => b + 1)}>下一块</button>
          </>
        )}
        <button type="button" className="btn sm" id="ipmap-refresh" disabled={loading}
          onClick={() => setTick(t => t + 1)}>
          <Icon name="refresh" size={12} />刷新
        </button>
      </div>
    }>
      {loading && !data ? (
        <div className="empty">正在加载子网地址…</div>
      ) : error ? (
        <div className="check-note bad">{error}</div>
      ) : data && counts ? (
        <>
          <div className="ipmap-meta" id="ipmap-meta">
            <b className="mono">{data.cidr}</b> · {data.name} · 地址平面 {data.vrf} ·
            VLAN {data.vlan ?? '—'} · 掩码 {data.info.mask} ·
            网络号 <span className="mono">{data.info.network}</span> ·
            广播 <span className="mono">{data.info.broadcast}</span> ·
            可分配 <span className="mono">{data.info.first_host} – {data.info.last_host}</span>
          </div>

          <div className="ipmap-stats" id="ipmap-stats">
            <span className="ipmap-stat">总地址<b>{counts.total}</b></span>
            <span className="ipmap-stat">保留<b>{counts.retained}</b></span>
            <span className="ipmap-stat">可用<b>{counts.available}</b></span>
            <span className="ipmap-stat">已分配<b>{counts.assigned}</b></span>
            <span className="ipmap-stat">预留<b>{counts.reserved}</b></span>
            <span className="ipmap-stat">待回收<b>{counts.deprecated}</b></span>
            <span className="ipmap-stat">冲突<b>{counts.conflict}</b></span>
            {counts.child > 0 && <span className="ipmap-stat">更细子网<b>{counts.child}</b></span>}
            <span className="ipmap-stat">利用率<b>{counts.util}%</b></span>
          </div>

          <div className="ipmap-legend" id="ipmap-legend">
            {LEGEND.map(x => (
              <span key={x.state}><i className={`lg-${x.state}`} />{x.label}</span>
            ))}
            <span className="ipmap-block-note">
              当前显示 {data.blocks[data.block]?.label}（第 {data.block + 1} / {data.block_count} 块）
            </span>
          </div>

          <div className="ipmap-grid" id="ipmap-grid">
            {data.cells.map(cell => (
              <button type="button" key={cell.addr}
                id={`ipmap-cell-${cell.host}`}
                data-state={cell.state}
                title={`${cell.addr} · ${cell.label}${cell.hostname ? ' · ' + cell.hostname : ''}`}
                className={`ipmap-cell ${cell.state}${active?.addr === cell.addr ? ' picked' : ''}`}
                onClick={() => {
                  setPicked(cell)
                  if (cell.state === 'available') onPick(cell.addr)
                }}>
                {cell.host}
              </button>
            ))}
          </div>

          <div className="ipmap-note">
            格子数字为 IPv4 地址最后一段，覆盖该网段全部地址（含网络号、网关与广播地址）。
            点击「可用」格子可一键填入上方「指定 IP 地址」；地址分配 / 回收后本图会自动刷新。
            大网段按每块 256 个地址分页展示。
          </div>

          {active && (
            <div className={`ipmap-detail ${active.state}`} id="ipmap-detail">
              <div className="ipmap-detail-head">
                <b className="mono">{active.addr}</b>
                <span className={`ipmap-badge ${active.state}`}>{active.label}</span>
                {active.state === 'available' && (
                  <button type="button" className="mini-link" id="ipmap-fill"
                    onClick={() => onPick(active.addr)}>填入指定 IP</button>
                )}
              </div>
              <div className="ipmap-detail-body">{detailOf(active, data)}</div>
            </div>
          )}
        </>
      ) : (
        <div className="empty">暂无子网地址数据</div>
      )}
    </Card>
  )
}
