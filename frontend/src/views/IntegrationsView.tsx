import { useState } from 'react'
import { api } from '../api'
import { Card, Icon, MiniStat, Tag } from '../components/ui'
import type { IntegrationSource, WebhookEvent } from '../types'
import { shortTime, useLoad, type ViewProps } from './shared'

const KIND_ICON: Record<string, string> = {
  DHCP: 'network', DNS: 'network', CMDB: 'database', SNMP: 'cpu',
  NetFlow: 'chart', Webhook: 'plug',
}

export default function IntegrationsView({ notify, onChanged, refreshKey }: ViewProps) {
  const [busy, setBusy] = useState<string | null>(null)
  const { data, loading, reload } = useLoad(
    () => api.integrations(), [refreshKey], notify,
  )
  const sources: IntegrationSource[] = data?.items ?? []
  const events: WebhookEvent[] = data?.events ?? []
  const enabled = sources.filter(s => s.enabled).length
  const totalSync = sources.reduce((n, s) => n + s.sync_count, 0)

  async function sync(id: string) {
    setBusy(id)
    try {
      const res = await api.syncSource(id)
      notify(`${id} 同步完成：发现 ${res.records} 条记录，新增 ${res.new_diffs} 条差异`)
      reload(); onChanged()
    } catch (err) {
      notify(err instanceof Error ? err.message : '同步失败', 'error')
    } finally { setBusy(null) }
  }

  async function toggle(s: IntegrationSource) {
    setBusy(s.id)
    try {
      await api.toggleSource(s.id, !s.enabled)
      notify(`${s.name} 已${s.enabled ? '停用' : '启用'}`)
      reload(); onChanged()
    } catch (err) {
      notify(err instanceof Error ? err.message : '切换失败', 'error')
    } finally { setBusy(null) }
  }

  return (
    <>
      <div className="stat-row">
        <MiniStat label="已启用数据源" value={enabled} foot={`共 ${sources.length} 个`} tone="teal" />
        <MiniStat label="累计同步" value={totalSync} foot="手动触发次数" tone="blue" />
        <MiniStat label="Webhook 事件" value={events.length} foot="本地事件队列" />
        <MiniStat label="待处理差异" value="—" foot="前往发现与对账查看" tone="amber" />
      </div>

      <div className="grid-2">
        <Card title="集成数据源" hint="04 集成与同步层" extra={
          <span className="muted small">{loading ? '加载中…' : '点击开关启停，或立即同步'}</span>
        }>
          {sources.map(s => (
            <div className="source-row" key={s.id}>
              <div className="source-ico"><Icon name={KIND_ICON[s.kind] ?? 'plug'} size={16} /></div>
              <div className="source-main">
                <b>{s.name} <Tag text={s.kind} tone="blue" /></b>
                <span>{s.endpoint} · {s.note}</span>
                <span>同步 {s.sync_count} 次 · 上次 {shortTime(s.last_sync)}</span>
              </div>
              <button className="btn sm" disabled={busy === s.id || !s.enabled} onClick={() => sync(s.id)}>
                <Icon name="refresh" size={12} />{busy === s.id ? '处理中' : '立即同步'}
              </button>
              <button className={`switch${s.enabled ? ' on' : ''}`} disabled={busy === s.id}
                onClick={() => toggle(s)} aria-label={s.enabled ? '停用' : '启用'}><i /></button>
            </div>
          ))}
          <p className="footnote">
            真实部署时这里替换为适配器：DHCP 租约、DNS 正反向区、CMDB 资产、交换机 ARP/SNMP、NetFlow 流量。
            采集结果统一写入发现记录，再由对账引擎与 IPAM 登记比对生成差异。
          </p>
        </Card>

        <div className="stack-col">
          <Card title="Webhook 事件" hint="告警外发队列">
            {events.length === 0 ? <div className="empty">暂无事件</div> : events.slice(0, 12).map(e => (
              <div className="event-row" key={e.id}>
                <time>{shortTime(e.ts)}</time>
                <b>{e.event}</b>
                <span className="mono muted">{e.target ?? '—'}</span>
              </div>
            ))}
          </Card>

          <Card title="闭环链路" hint="登记 → 使用 → 对账 → 回收">
            <div className="flow">
              {['数据源采集', '发现记录', '对账引擎', '差异处理', '状态机', '审计 / 告警'].map((n, i) => (
                <span key={i} style={{ display: 'contents' }}>
                  {i > 0 && <span className="arw">→</span>}
                  <span className={`node${i >= 3 ? ' hi' : ''}`}>{n}</span>
                </span>
              ))}
            </div>
            <div className="warn-item" style={{ marginTop: 14 }}>
              <div className="warn-head"><b>未登记使用</b><Tag text="高优先级" tone="red" /></div>
              <div className="warn-note">外部可见但 IPAM 无登记 → 可「补登」为已分配，真实写入地址池</div>
            </div>
            <div className="warn-item">
              <div className="warn-head"><b>地址冲突 / 僵尸 IP</b><Tag text="状态机" tone="amber" /></div>
              <div className="warn-note">标记冲突或发起回收，均经 03 层状态机校验后写入</div>
            </div>
          </Card>
        </div>
      </div>
    </>
  )
}
