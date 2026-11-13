import { useState } from 'react'
import { api } from '../api'
import { Card, Icon, MiniStat, Segmented, Tag } from '../components/ui'
import { DIFF_TYPE_LABEL, type Diff } from '../types'
import { shortTime, useLoad, type ViewProps } from './shared'

type DiffStatus = 'open' | 'resolved' | 'ignored' | 'all'
const STATUS_OPTIONS: { key: DiffStatus; label: string }[] = [
  { key: 'open', label: '待处理' }, { key: 'resolved', label: '已处理' },
  { key: 'ignored', label: '已忽略' }, { key: 'all', label: '全部' },
]

const ACTIONS: { key: string; label: string }[] = [
  { key: 'register', label: '补登' },
  { key: 'conflict', label: '标记冲突' },
  { key: 'reclaim', label: '发起回收' },
  { key: 'ignore', label: '忽略' },
]

export default function ReconciliationView({ notify, onChanged, refreshKey }: ViewProps) {
  const [status, setStatus] = useState<'open' | 'resolved' | 'ignored' | 'all'>('open')
  const [type, setType] = useState('all')
  const [busy, setBusy] = useState<number | null>(null)
  const [syncing, setSyncing] = useState<string | null>(null)

  const { data, loading, reload } = useLoad(
    () => Promise.all([api.reconciliation(status, type), api.discovery(), api.integrations()]),
    [status, type, refreshKey], notify,
  )
  const [diffData, discovery, integrations] = data ?? [null, null, null]
  const diffs = diffData?.items ?? []
  const sources = integrations?.items ?? []

  async function resolve(diff: Diff, action: string) {
    setBusy(diff.id)
    try {
      const res = await api.resolveDiff(diff.id, action, '控制台处理')
      notify(`${diff.addr} · ${res.outcome}`)
      reload()
      onChanged()
    } catch (err) {
      notify(err instanceof Error ? err.message : '处理失败', 'error')
    } finally {
      setBusy(null)
    }
  }

  async function sync(id: string) {
    setSyncing(id)
    try {
      const res = await api.syncSource(id)
      notify(`${id} 同步完成：发现 ${res.records} 条，新增差异 ${res.new_diffs} 条`)
      reload()
      onChanged()
    } catch (err) {
      notify(err instanceof Error ? err.message : '同步失败', 'error')
    } finally {
      setSyncing(null)
    }
  }

  return (
    <>
      <div className="stat-row">
        <MiniStat label="待处理差异" value={diffData?.open ?? 0} foot="需人工确认后闭环" tone="red" />
        <MiniStat label="已处理" value={diffData?.resolved ?? 0} foot="登记 / 冲突 / 回收" tone="teal" />
        <MiniStat label="已忽略" value={diffData?.ignored ?? 0} foot="人工判定无需处理" />
        <MiniStat label="发现记录" value={discovery?.items.length ?? 0} foot="外部数据源观测快照" tone="blue" />
      </div>

      <div className="grid-2">
        <Card title="对账差异" hint="登记 → 使用 → 对账 → 回收" extra={
          <span className="hint">{loading ? '加载中…' : `共 ${diffs.length} 条`}</span>
        }>
          <div className="toolbar">
            <Segmented value={status} options={STATUS_OPTIONS} onChange={setStatus} />
            <select className="small" value={type} onChange={e => setType(e.target.value)}
              style={{ height: 30, border: '1px solid var(--border-2)', borderRadius: 8, padding: '0 8px' }}>
              <option value="all">全部类型</option>
              {Object.entries(DIFF_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>

          {diffs.length === 0 ? <div className="empty">当前筛选下没有差异记录</div> : diffs.map(d => (
            <div className={`diff-row${d.status !== 'open' ? ' done' : ''}`} key={d.id}>
              <div className="diff-top">
                <b className="addr mono">{d.addr}</b>
                <Tag text={d.type_label} tone={d.severity === 'high' ? 'red' : 'amber'} />
                <Tag text={d.source.toUpperCase()} tone="blue" />
                <span className="muted small">{d.prefix_cidr}</span>
                <span style={{ marginLeft: 'auto' }}>
                  <Tag text={d.status === 'open' ? '待处理' : d.status === 'ignored' ? '已忽略' : '已处理'}
                    tone={d.status === 'open' ? 'red' : d.status === 'ignored' ? 'neutral' : 'teal'} />
                </span>
              </div>
              <div className="diff-detail">{d.detail}</div>
              <div className="diff-meta">
                发现于 {shortTime(d.discovered_at)}
                {d.resolution ? ` · 处理：${d.resolution}（${shortTime(d.resolved_at)}）` : ''}
              </div>
              {d.status === 'open' && (
                <div className="diff-actions">
                  {ACTIONS.map(a => (
                    <button key={a.key} className={`btn sm${a.key === 'register' ? ' primary' : ''}`}
                      disabled={busy === d.id}
                      onClick={() => resolve(d, a.key)}>{a.label}</button>
                  ))}
                  <span className="muted small" style={{ alignSelf: 'center' }}>
                    不适用的动作会被状态机拒绝
                  </span>
                </div>
              )}
            </div>
          ))}
        </Card>

        <div className="stack-col">
          <Card title="集成数据源" hint="手动触发一次采集与对账">
            {sources.slice(0, 5).map(s => (
              <div className="source-row" key={s.id}>
                <div className="source-ico"><Icon name={s.kind === 'Webhook' ? 'plug' : 'scan'} size={15} /></div>
                <div className="source-main">
                  <b>{s.name}</b>
                  <span>{s.endpoint} · 同步 {s.sync_count} 次 · 上次 {shortTime(s.last_sync)}</span>
                </div>
                <button className="btn sm" disabled={syncing === s.id || !s.enabled}
                  onClick={() => sync(s.id)}>
                  <Icon name="refresh" size={12} />{syncing === s.id ? '同步中' : '同步'}
                </button>
              </div>
            ))}
            <p className="footnote">
              同步会写入发现记录并触发对账引擎：外部可见但 IPAM 未登记 → 未登记使用；主机名不一致 → 地址冲突；
              长期无流量 → 僵尸 IP。每条差异只保留一条待处理记录。
            </p>
          </Card>

          <Card title="最近发现记录" hint="外部观测快照">
            <div style={{ maxHeight: 260, overflowY: 'auto' }}>
              <table>
                <thead><tr><th>IP 地址</th><th>主机 / MAC</th><th>来源</th><th>信号</th></tr></thead>
                <tbody>
                  {(discovery?.items ?? []).slice(0, 12).map(r => (
                    <tr key={r.id}>
                      <td className="mono" style={{ color: 'var(--blue-800)' }}>{r.addr}</td>
                      <td>{r.hostname ?? '—'}<div className="muted small">{r.mac ?? '—'}</div></td>
                      <td><Tag text={r.source.toUpperCase()} tone="blue" /></td>
                      <td className="small">{r.signal}</td>
                    </tr>
                  ))}
                  {(discovery?.items.length ?? 0) === 0 && (
                    <tr><td colSpan={4}><div className="empty">暂无发现记录</div></td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      </div>
    </>
  )
}
