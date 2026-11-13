import { useState } from 'react'
import { api } from '../api'
import { Card, Icon, MiniStat, Tag } from '../components/ui'
import type { AuditItem } from '../types'
import { csvDownload, shortTime, useLoad, type ViewProps } from './shared'

const ACTION_TONE: Record<string, 'red' | 'amber' | 'teal' | 'blue' | 'neutral'> = {
  allocate: 'teal', release: 'amber', reclaim: 'teal', confirm: 'teal', resolve: 'teal',
  'ticket.reject': 'red', 'ticket.failed': 'red', 'reconcile.ignore': 'neutral',
  'settings.update': 'blue', 'integration.sync': 'blue', 'subnet.split': 'blue',
}

export default function AuditView({ notify, onChanged, refreshKey }: ViewProps) {
  const [action, setAction] = useState('all')
  const [q, setQ] = useState('')
  const { data, loading } = useLoad(
    () => api.auditLog(action, q, 200), [action, q, refreshKey], notify,
  )
  const items: AuditItem[] = data?.items ?? []
  const writeActions = items.filter(i => !i.action.startsWith('seed') && i.action !== 'clear').length

  function exportCsv() {
    if (items.length === 0) { notify('没有可导出的审计记录', 'error'); return }
    csvDownload('ipam-audit.csv', ['时间', '动作', 'IP 地址', '详情'],
      items.map(i => [i.ts, i.action, i.addr ?? '', i.detail]))
    notify(`已导出 ${items.length} 条审计记录`)
    onChanged()
  }

  return (
    <>
      <div className="stat-row">
        <MiniStat label="审计记录" value={data?.total ?? 0} foot="当前筛选结果" tone="blue" />
        <MiniStat label="动作类型" value={data?.actions.length ?? 0} foot="可筛选的动作枚举" />
        <MiniStat label="写操作" value={writeActions} foot="分配 / 回收 / 审批 / 配置" tone="teal" />
        <MiniStat label="最近记录" value={items[0] ? shortTime(items[0].ts) : '—'} foot="时间倒序" />
      </div>

      <Card title="审计日志" hint="所有入口的写操作统一收敛到领域核心层" extra={
        <button className="btn sm" onClick={exportCsv}><Icon name="download" size={12} />导出 CSV</button>
      }>
        <div className="toolbar">
          <select value={action} onChange={e => setAction(e.target.value)}
            style={{ height: 30, border: '1px solid var(--border-2)', borderRadius: 8, padding: '0 8px', fontSize: 12 }}>
            <option value="all">全部动作</option>
            {(data?.actions ?? []).map(a => <option key={a} value={a}>{a}</option>)}
          </select>
          <div className="search" style={{ marginLeft: 0, width: 240 }}>
            <Icon name="search" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索 IP / 动作 / 详情" />
          </div>
          <span className="spacer" />
          <span className="muted small">{loading ? '加载中…' : `倒序展示最多 200 条`}</span>
        </div>

        {items.length === 0 ? <div className="empty">没有符合条件的审计记录</div> : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead><tr><th>时间</th><th>动作</th><th>IP 地址</th><th>详情</th></tr></thead>
              <tbody>
                {items.map((i, idx) => (
                  <tr key={`${i.ts}-${idx}`}>
                    <td className="mono" style={{ color: 'var(--text-3)' }}>{i.ts}</td>
                    <td><Tag text={i.action} tone={ACTION_TONE[i.action] ?? 'blue'} /></td>
                    <td className="mono" style={{ color: i.addr ? 'var(--blue-800)' : 'var(--text-3)' }}>
                      {i.addr ?? '—'}
                    </td>
                    <td style={{ whiteSpace: 'normal', minWidth: 320 }}>{i.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid-2 even" style={{ marginTop: 16 }}>
        <Card title="留痕范围" hint="03 领域核心层">
          <div className="chips">
            <span className="chip done">自动 / 手动分配</span><span className="chip done">状态流转</span>
            <span className="chip done">对账处理</span><span className="chip done">工单审批</span>
            <span className="chip done">子网划分</span><span className="chip done">集成同步</span>
            <span className="chip done">设置变更</span><span className="chip done">维护任务</span>
          </div>
          <p className="footnote">审计日志只追加、不提供修改或删除接口；前端不能直接改写 IP 状态。</p>
        </Card>
        <Card title="动作说明" hint="常见动作">
          <p className="footnote" style={{ marginTop: 0, lineHeight: 1.9 }}>
            <b>allocate</b> 自动分配 / 手动指定分配 / <b>release·reclaim·confirm·resolve</b> 状态机流转<br />
            <b>reconcile.*</b> 差异处理 / <b>ticket.*</b> 工单创建与审批<br />
            <b>integration.*</b> 数据源同步与启停 / <b>subnet.split</b> 子网划入<br />
            <b>settings.update</b> 阈值与系统配置 / <b>maintenance.expire</b> 超时预留释放
          </p>
        </Card>
      </div>
    </>
  )
}
