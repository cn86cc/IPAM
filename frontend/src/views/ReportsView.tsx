import { useState } from 'react'
import { api } from '../api'
import { useAuth } from '../auth'
import { Card, Icon, MiniStat, Segmented } from '../components/ui'
import type { ReportRow } from '../types'
import { csvDownload, useLoad, type ViewProps } from './shared'

type Dimension = 'site' | 'vlan' | 'vrf' | 'business' | 'status' | 'prefix'
const DIMENSIONS: { key: Dimension; label: string }[] = [
  { key: 'site', label: '按站点' }, { key: 'vlan', label: '按 VLAN' },
  { key: 'vrf', label: '按 VRF' }, { key: 'business', label: '按业务' },
  { key: 'status', label: '按状态' }, { key: 'prefix', label: '按子网' },
]

export default function ReportsView({ notify, onChanged, refreshKey }: ViewProps) {
  const { vrf } = useAuth()
  const [dimension, setDimension] = useState<Dimension>('site')
  const { data, loading } = useLoad(
    () => api.reports(dimension, vrf), [dimension, refreshKey, vrf], notify,
  )
  const rows: ReportRow[] = data?.rows ?? []
  const maxOccupied = Math.max(1, ...rows.map(r => r.occupied))

  function exportCsv() {
    if (rows.length === 0) { notify('当前维度没有可导出的数据', 'error'); return }
    csvDownload(`ipam-report-${dimension}.csv`,
      ['分组', '地址总数', '保留地址', '已登记占用', '可用地址', '利用率(%)', '子网数'],
      rows.map(r => [r.label, r.total, r.retained ?? 0, r.occupied, r.free, r.util, r.subnets ?? 0]))
    notify(`已导出 ${rows.length} 行报表数据`)
    onChanged()
  }

  const preview = rows.slice(0, 4).map(r =>
    `${r.label.padEnd(14, ' ')} 占用 ${String(r.occupied).padStart(5, ' ')}  可用 ${String(r.free).padStart(5, ' ')}  ${r.util}%`,
  ).join('\n') || '暂无数据'

  return (
    <>
      <div className="stat-row">
        <MiniStat label="分组数" value={data?.summary.groups ?? 0} foot={`维度：${DIMENSIONS.find(d => d.key === dimension)?.label}`} />
        <MiniStat label="地址总数" value={(data?.summary.total ?? 0).toLocaleString()} foot="当前维度覆盖" tone="blue" />
        <MiniStat label="已登记占用" value={(data?.summary.occupied ?? 0).toLocaleString()} foot="含预留 / 待回收 / 冲突" tone="teal" />
        <MiniStat label="统计平面" value={dimension === 'vrf' ? '全部' : (vrf === 'all' ? '全部' : vrf)}
          foot={dimension === 'vrf' ? '跨平面对比' : '当前地址平面'} />
      </div>

      <div className="grid-2">
        <div className="stack-col">
          <Card title="维度分布" hint={loading ? '加载中…' : '按已登记占用降序'} extra={
            <button className="btn sm" onClick={exportCsv}><Icon name="download" size={12} />导出 CSV</button>
          }>
            <div className="toolbar"><Segmented value={dimension} options={DIMENSIONS} onChange={setDimension} /></div>
            {rows.length === 0 ? <div className="empty">该维度暂无数据（当前地址池为空时，按业务维度不会产出分组）</div> :
              rows.map(r => (
                <div className="report-bar" key={r.key}>
                  <div className="k mono" title={r.label}>{r.label}</div>
                  <div className="track"><i style={{
                    width: `${r.occupied / maxOccupied * 100}%`,
                    background: r.util >= 90 ? 'var(--red)' : r.util >= 80 ? 'var(--amber)' : 'var(--blue)',
                  }} /></div>
                  <div className="v">{r.occupied.toLocaleString()} / {r.free.toLocaleString()}</div>
                </div>
              ))}
          </Card>

          <Card title="明细数据" hint={`${rows.length} 行`}>
            <div style={{ overflowX: 'auto', maxHeight: 320, overflowY: 'auto' }}>
              <table>
                <thead><tr>
                  <th>分组</th><th>地址总数</th><th>保留</th><th>占用</th>
                  <th>可用</th><th>利用率</th><th>子网数</th>
                </tr></thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.key}>
                      <td>{r.label}</td><td>{r.total.toLocaleString()}</td>
                      <td>{r.retained ?? 0}</td><td>{r.occupied.toLocaleString()}</td>
                      <td>{r.free.toLocaleString()}</td><td>{r.util}%</td>
                      <td>{r.subnets ?? '—'}</td>
                    </tr>
                  ))}
                  {rows.length === 0 && <tr><td colSpan={7}><div className="empty">暂无数据</div></td></tr>}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        <div className="stack-col">
          <Card title="导出预览" hint="CSV · UTF-8 BOM">
            <div className="code-box">{preview}</div>
            <p className="footnote">
              导出内容基于当前维度与实时数据，含分组、地址总数、保留地址、占用、可用、利用率与子网数。
              前端生成 Blob 下载，不经过文件服务器。
            </p>
          </Card>
          <Card title="口径说明" hint="与看板一致">
            <p className="footnote" style={{ marginTop: 0, lineHeight: 1.9 }}>
              利用率 =（已登记占用 − 预留）/（网段地址数 − 保留地址）。<br />
              除「按 VRF」为跨平面对比外，其余维度只统计当前地址平面
              <b>{vrf === 'all' ? '（全部 VRF 汇总）' : `（${vrf}）`}</b>；
              按站点 / VLAN / 子网维度来自该平面的前缀树聚合，
              分组覆盖根 / 汇聚 / 子网全部前缀，容量仅累计可分配子网以免重复计数；
              同一 CIDR 在不同平面各自计入，不互相冲抵；
              按业务维度来自地址明细的 business 字段；
              按状态维度来自状态分布，并补上未落库的可用地址。<br />
              大网段不预生成 IP 行，因此可用地址始终由前缀区间减去占用集合推导。
            </p>
          </Card>
          <Card title="02 层能力映射" hint="查询与报表">
            <div className="chips">
              <span className="chip done">多维聚合</span><span className="chip done">明细检索</span>
              <span className="chip done">CSV 导出</span><span className="chip done">容量阈值</span>
              <span className="chip">定时订阅</span><span className="chip">邮件推送</span>
            </div>
            <p className="footnote">灰底为架构规划但第一、二版尚未实现的增强项。</p>
          </Card>
        </div>
      </div>
    </>
  )
}
