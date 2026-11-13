import { useEffect, useState, type FormEvent } from 'react'
import { api } from '../api'
import { Card, Icon, MiniStat, Segmented, Tag } from '../components/ui'
import { TICKET_STATUS_LABEL, type Prefix, type Ticket, type TicketPayload } from '../types'
import { shortTime, useLoad, type ViewProps } from './shared'

type TicketStatus = 'pending' | 'approved' | 'rejected' | 'all'
const STATUS_OPTIONS: { key: TicketStatus; label: string }[] = [
  { key: 'pending', label: '待审批' }, { key: 'approved', label: '已通过' },
  { key: 'rejected', label: '已驳回' }, { key: 'all', label: '全部' },
]

const TYPE_OPTIONS: { key: TicketPayload['type']; label: string }[] = [
  { key: 'allocate', label: '地址分配' }, { key: 'release', label: '地址回收' },
  { key: 'expand', label: '网段扩容' },
]

export default function TicketsView({ notify, onChanged, refreshKey, focus = 'create' }: ViewProps & {
  focus?: 'create' | 'approve'
}) {
  const [status, setStatus] = useState<TicketStatus>(focus === 'approve' ? 'pending' : 'all')
  const [busy, setBusy] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [form, setForm] = useState<TicketPayload>({
    type: 'allocate', title: '', applicant: '', business: '', prefix_cidr: '', addr: '', count: 1, reason: '',
  })

  const { data, loading, reload } = useLoad(
    () => Promise.all([api.tickets(status), api.spaces()]),
    [status, refreshKey], notify,
  )
  const [ticketData, spaces] = data ?? [null, null]
  const prefixes: Prefix[] = spaces?.prefixes ?? []
  const prefixOptions = prefixes.filter(p => form.type === 'allocate' ? p.kind === 'subnet' : p.kind !== 'subnet')

  useEffect(() => {
    if (spaces && !form.prefix_cidr && form.type !== 'release') {
      const first = prefixOptions[0]?.cidr ?? ''
      if (first) setForm(f => ({ ...f, prefix_cidr: first }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaces, form.type])

  const set = <K extends keyof TicketPayload,>(key: K, value: TicketPayload[K]) =>
    setForm(f => ({ ...f, [key]: value }))

  async function submit(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      const payload: TicketPayload = {
        ...form,
        title: form.title?.trim() || undefined,
        applicant: form.applicant?.trim() || '—',
        business: form.business?.trim() || '未指定',
        prefix_cidr: form.type === 'release' ? null : (form.prefix_cidr || prefixOptions[0]?.cidr || null),
        addr: form.type === 'release' ? (form.addr || null) : null,
        count: form.type === 'allocate' ? Number(form.count) || 1 : 1,
      }
      const res = await api.createTicket(payload)
      notify(`工单 ${res.id} 已提交，等待审批`)
      setForm(f => ({ ...f, title: '', reason: '', addr: '' }))
      reload()
      onChanged()
    } catch (err) {
      notify(err instanceof Error ? err.message : '提交失败', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  async function decide(t: Ticket, decision: 'approve' | 'reject') {
    setBusy(t.id)
    try {
      const res = await api.decideTicket(t.id, decision, '管理员', decision === 'approve' ? '同意' : '驳回')
      notify(decision === 'approve'
        ? `工单 ${t.id} 已通过 · ${res.result ?? ''}`
        : `工单 ${t.id} 已驳回`)
      reload()
      onChanged()
    } catch (err) {
      notify(err instanceof Error ? err.message : '审批失败', 'error')
    } finally {
      setBusy(null)
    }
  }

  const formCard = (
    <Card title="新建申请" hint="提交后进入审批队列">
      <form onSubmit={submit}>
        <div className="field">
          <label>工单类型</label>
          <div className="seg">
            {TYPE_OPTIONS.map(o => (
              <button type="button" key={o.key} className={form.type === o.key ? 'on' : ''}
                onClick={() => setForm(f => ({ ...f, type: o.key, prefix_cidr: '', addr: '' }))}>{o.label}</button>
            ))}
          </div>
        </div>
        <div className="form-grid">
          <div className="field"><label>标题（可选）</label>
            <input value={form.title ?? ''} onChange={e => set('title', e.target.value)} placeholder="例如 核心交易平台扩容" />
          </div>
          <div className="field"><label>申请人</label>
            <input value={form.applicant ?? ''} onChange={e => set('applicant', e.target.value)} placeholder="例如 张伟" />
          </div>
          <div className="field"><label>业务系统</label>
            <input value={form.business ?? ''} onChange={e => set('business', e.target.value)} placeholder="例如 核心交易平台" />
          </div>
          {form.type === 'release' ? (
            <div className="field"><label>待回收 IP 地址</label>
              <input value={form.addr ?? ''} onChange={e => set('addr', e.target.value)} placeholder="10.1.1.23" />
            </div>
          ) : (
            <div className="field"><label>{form.type === 'allocate' ? '目标子网' : '父前缀（聚合网段）'}</label>
              <select value={form.prefix_cidr ?? ''} onChange={e => set('prefix_cidr', e.target.value)}>
                <option value="">请选择</option>
                {prefixOptions.map(p => <option key={p.cidr} value={p.cidr}>{p.cidr} · {p.name}</option>)}
              </select>
            </div>
          )}
          {form.type === 'allocate' && (
            <div className="field"><label>申请数量</label>
              <input type="number" min={1} max={20} value={form.count ?? 1}
                onChange={e => set('count', Number(e.target.value))} />
            </div>
          )}
          <div className="field full"><label>申请理由</label>
            <input value={form.reason ?? ''} onChange={e => set('reason', e.target.value)} placeholder="说明用途与容量依据" />
          </div>
        </div>
        <button className="btn primary" type="submit" disabled={submitting} style={{ width: '100%' }}>
          <Icon name="ticket" />{submitting ? '提交中…' : '提交工单'}
        </button>
      </form>
      <p className="footnote">
        审批通过后由 03 领域核心层真实执行：分配申请调用带锁的自动分配；回收申请走状态机；
        扩容申请在父前缀下划入不与现有前缀重叠的新网段。
      </p>
    </Card>
  )

  const listCard = (
    <Card title={focus === 'approve' ? '待我审批' : '工单列表'} hint={loading ? '加载中…' : `共 ${ticketData?.items.length ?? 0} 条`}>
      <div className="toolbar">
        <Segmented value={status} options={STATUS_OPTIONS} onChange={setStatus} />
        <span className="spacer" />
        <span className="muted small">审批动作会真实写入地址池</span>
      </div>
      {(ticketData?.items ?? []).length === 0
        ? <div className="empty">当前筛选下没有工单</div>
        : ticketData!.items.map(t => (
          <div className="ticket-row" key={t.id}>
            <div className="ticket-head">
              <b>{t.title}</b>
              <Tag text={t.type_label} tone="blue" />
              <Tag text={TICKET_STATUS_LABEL[t.status] ?? t.status}
                tone={t.status === 'pending' ? 'amber' : t.status === 'approved' ? 'teal' : 'red'} />
              <span className="id">{t.id}</span>
            </div>
            <div className="ticket-meta">
              {t.applicant} · {t.business ?? '—'} · {t.prefix_cidr ?? t.addr ?? '—'}
              {t.type === 'allocate' ? ` · ${t.count} 个地址` : ''}
              <br />提交 {shortTime(t.created_at)}{t.reason ? ` · 理由：${t.reason}` : ''}
            </div>
            {t.result && <div className={`ticket-result${t.status === 'failed' ? ' bad' : ''}`}>{t.result}</div>}
            {t.approver && <div className="diff-meta">审批人 {t.approver} · {t.decision_note ?? '—'}</div>}
            {t.status === 'pending' && (
              <div className="diff-actions">
                <button className="btn sm primary" disabled={busy === t.id} onClick={() => decide(t, 'approve')}>
                  <Icon name="check" size={12} />通过
                </button>
                <button className="btn sm" disabled={busy === t.id} onClick={() => decide(t, 'reject')}>驳回</button>
              </div>
            )}
          </div>
        ))}
    </Card>
  )

  return (
    <>
      <div className="stat-row">
        <MiniStat label="待审批" value={ticketData?.pending ?? 0} foot="需人工决策" tone="amber" />
        <MiniStat label="已通过" value={ticketData?.approved ?? 0} foot="已执行领域操作" tone="teal" />
        <MiniStat label="已驳回" value={ticketData?.rejected ?? 0} foot="不产生地址变更" />
        <MiniStat label="工单总数" value={ticketData?.items.length ?? 0} foot={`当前视图：${STATUS_OPTIONS.find(o => o.key === status)?.label}`} />
      </div>
      {/* 分配申请页只提交工单，审批工单页只展示审批列表；两页各自的统计卡片保留 */}
      <div className="grid-2 single">
        {focus === 'create' ? formCard : listCard}
      </div>
    </>
  )
}
