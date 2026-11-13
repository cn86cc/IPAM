import { useEffect, useState, type FormEvent } from 'react'
import { api } from '../api'
import { Card, Icon, MiniStat, Tag } from '../components/ui'
import { AdminOnly, useAuth } from '../auth'
import type { SettingItem, Vrf } from '../types'
import { shortTime, useLoad, type ViewProps } from './shared'

export default function SettingsView({ notify, onChanged, refreshKey }: ViewProps) {
  const { vrf: currentPlane, refresh: refreshAuth } = useAuth()
  const [values, setValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [vrfForm, setVrfForm] = useState({ name: '', tenant: '', description: '' })

  const { data, loading, reload } = useLoad(
    () => Promise.all([api.settings(), api.vrfs(), api.overview()]),
    [refreshKey], notify,
  )
  const [settings, vrfData, overview] = data ?? [null, null, null]
  const items: SettingItem[] = settings?.items ?? []
  const vrfs: Vrf[] = vrfData?.items ?? []

  useEffect(() => {
    if (settings) setValues(Object.fromEntries(settings.items.map(i => [i.key, i.value])))
  }, [settings])

  async function save(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      const res = await api.updateSettings(values)
      // 改了「默认 VRF」后立刻重新拉取会话，让未手动切换平面的会话同步进入新平面
      await refreshAuth()
      notify(`设置已保存 · 预警 ${res.thresholds.warn}% / 告警 ${res.thresholds.crit}%`)
      reload(); onChanged()
    } catch (err) {
      notify(err instanceof Error ? err.message : '保存失败', 'error')
    } finally { setSaving(false) }
  }

  async function expire() {
    setBusy(true)
    try {
      const res = await api.expireReservations()
      notify(res.expired > 0
        ? `已释放 ${res.expired} 个超时预留地址`
        : `无超时预留地址（TTL ${res.ttl_hours} 小时）`)
      reload(); onChanged()
    } catch (err) {
      notify(err instanceof Error ? err.message : '执行失败', 'error')
    } finally { setBusy(false) }
  }

  async function snapshot() {
    setBusy(true)
    try {
      const res = await api.takeSnapshot()
      notify(res.vrf === 'all'
        ? `已为 ${res.planes.length} 个地址平面采集 ${res.day} 利用率快照`
        : `已采集地址平面 ${res.vrf} 的 ${res.day} 利用率快照（占用 ${res.planes[0]?.occupied ?? 0}）`)
      reload(); onChanged()
    } catch (err) {
      notify(err instanceof Error ? err.message : '采集失败', 'error')
    } finally { setBusy(false) }
  }

  async function createVrf(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const res = await api.createVrf(vrfForm)
      notify(`VRF 地址平面 ${res.name} 已创建，可从顶栏切换进入`)
      setVrfForm({ name: '', tenant: '', description: '' })
      reload(); onChanged()
    } catch (err) {
      notify(err instanceof Error ? err.message : '创建失败', 'error')
    } finally { setBusy(false) }
  }

  return (
    <>
      <div className="stat-row">
        <MiniStat label="预警阈值" value={`${settings?.thresholds.warn ?? 80}%`} foot="达到即进入容量预警" tone="amber" />
        <MiniStat label="告警阈值" value={`${settings?.thresholds.crit ?? 90}%`} foot="达到即进入容量告警" tone="red" />
        <MiniStat label="预留有效期" value={`${settings?.thresholds.reservation_ttl_hours ?? 24}h`} foot="超时自动回可用池" />
        <MiniStat label="VRF 地址平面" value={overview?.vrfs ?? 0} foot="每张平面独立编址" tone="blue" />
      </div>

      <div className="grid-2">
        <div className="stack-col">
          <Card title="系统设置" hint="05 数据与基础设施层配置" extra={
            <span className="muted small">{loading ? '加载中…' : '保存后立即生效'}</span>
          }>
            <form onSubmit={save}>
              {items.map(i => (
                <div className="field" key={i.key}>
                  <label>{i.label}</label>
                  <input value={values[i.key] ?? i.value}
                    onChange={e => setValues(v => ({ ...v, [i.key]: e.target.value }))} />
                  {i.note && <div className="help">{i.note}</div>}
                </div>
              ))}
              <button className="btn primary" type="submit" disabled={saving} style={{ width: '100%' }}>
                <Icon name="check" />{saving ? '保存中…' : '保存设置'}
              </button>
            </form>
          </Card>

          <AdminOnly>
            <Card title="维护任务" hint={`当前地址平面：${currentPlane === 'all' ? '全部 VRF（跨平面对比）' : currentPlane}`}>
              <p className="footnote" style={{ marginTop: 0, lineHeight: 1.8 }}>
                按当前预留有效期扫描超时未确认的预留地址，删除其登记行使地址回到可用池；<br />
                利用率快照<b>按地址平面独立存放</b>，唯一键为 (VRF, 日期)：在当前平面下只采该平面，
                切到「全部 VRF」则为所有平面各采一条。看板趋势只读本平面历史，不会串用其它平面的曲线。<br />
                真实部署由 Celery / 定时任务按周期触发，这里提供手动执行入口。
              </p>
              <div className="inline" style={{ gap: 8, flexWrap: 'wrap' }}>
                <button className="btn" onClick={expire} disabled={busy}>
                  <Icon name="undo" />{busy ? '执行中…' : '立即释放超时预留'}
                </button>
                <button className="btn" onClick={snapshot} disabled={busy}>
                  <Icon name="chart" />{busy ? '执行中…' : '采集当日利用率快照'}
                </button>
              </div>
            </Card>
          </AdminOnly>
        </div>

        <div className="stack-col">
          <Card title="VRF 地址平面" hint="01 接入层 · 模型级隔离">
            <p className="footnote" style={{ marginTop: 0, lineHeight: 1.8 }}>
              每个 VRF 是独立地址平面，(VRF, CIDR) / (VRF, IP) 为唯一键，同一网段可跨平面重复登记；
              「默认 VRF」决定登录后默认进入的平面。增删改、改名级联与引用保护请到「VRF 地址平面」页操作。
            </p>
            {vrfs.map(v => (
              <div className="source-row" key={v.name}>
                <div className="source-ico"><Icon name="layers" size={15} /></div>
                <div className="source-main">
                  <b>{v.name} <Tag text={v.tenant} tone="blue" /></b>
                  <span>{v.description || '—'}</span>
                  <span>{v.prefix_count} 个前缀（{v.subnet_count} 子网） · {v.device_count ?? 0} 台设备 ·
                    {' '}{v.ip_count ?? 0} 个已登记 IP · 容量 {v.total.toLocaleString()} · 利用率 {v.util}%</span>
                  <span>创建于 {shortTime(v.created_at)} · 该平面的地址空间与其它平面彼此隔离</span>
                </div>
              </div>
            ))}
            <AdminOnly>
              <form onSubmit={createVrf} style={{ marginTop: 12 }}>
                <div className="form-grid">
                  <div className="field"><label>名称</label>
                    <input value={vrfForm.name} onChange={e => setVrfForm(f => ({ ...f, name: e.target.value }))}
                      placeholder="vrf-finance" />
                  </div>
                  <div className="field"><label>租户</label>
                    <input value={vrfForm.tenant} onChange={e => setVrfForm(f => ({ ...f, tenant: e.target.value }))}
                      placeholder="财务租户" />
                  </div>
                  <div className="field full"><label>说明</label>
                    <input value={vrfForm.description} onChange={e => setVrfForm(f => ({ ...f, description: e.target.value }))}
                      placeholder="用途说明" />
                  </div>
                </div>
                <button className="btn" type="submit" disabled={busy}><Icon name="plus" />新建地址平面</button>
              </form>
            </AdminOnly>
          </Card>

          <Card title="阈值联动" hint="与看板一致">
            <p className="footnote" style={{ marginTop: 0, lineHeight: 1.9 }}>
              修改预警 / 告警阈值后，利用率看板的容量预警、网段排行配色和树节点进度条会同步变化；
              后端 <span className="mono">/api/dashboard</span> 的 alerts 也按新阈值过滤。<br />
              阈值约束：0 ≤ 预警 &lt; 告警 ≤ 100，非法组合由后端拒绝。
            </p>
            <div className="chips">
              <span className="chip done">阈值可配置</span><span className="chip done">看板联动</span>
              <span className="chip done">预留 TTL</span><span className="chip done">网关偏移</span>
              <span className="chip">SSO / LDAP</span><span className="chip">细粒度权限</span>
            </div>
          </Card>
        </div>
      </div>
    </>
  )
}
