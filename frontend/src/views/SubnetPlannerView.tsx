import { useEffect, useState } from 'react'
import { api, getApiVrf } from '../api'
import { useAuth } from '../auth'
import { Card, Icon, MiniStat, Segmented, Tag } from '../components/ui'
import type { PlanResult, Prefix, SubnetCandidate, Vrf } from '../types'
import { useLoad, type ViewProps } from './shared'

const CUSTOM = '__custom__'
const MAX_PAGE_SIZE = 2000   // 与后端 MAX_PAGE_SIZE 一致：单页最多 2000 行
const MAX_TOTAL = 65536      // 与后端 MAX_PLAN_TOTAL 一致：单次划分上限

type Filter = 'all' | 'available' | 'conflict'

function pageNumbers(current: number, total: number): (number | '…')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const out: (number | '…')[] = [1]
  const from = Math.max(2, current - 2)
  const to = Math.min(total - 1, current + 2)
  if (from > 2) out.push('…')
  for (let i = from; i <= to; i++) out.push(i)
  if (to < total - 1) out.push('…')
  out.push(total)
  return out
}

/**
 * 子网划分：选定父前缀 + 目标掩码 → 一次列出全部等分子网。
 * 结果不再截断为 64 个；超过单页上限时按真实序号分页，并可导出全量 CSV。
 */
export default function SubnetPlannerView({ notify, onChanged, refreshKey }: ViewProps) {
  const { isAdmin, vrf: plane } = useAuth()
  const [parentChoice, setParentChoice] = useState('10.1.0.0/16')
  const [customParent, setCustomParent] = useState('192.168.10.0/24')
  const [newPrefix, setNewPrefix] = useState(24)
  const [name, setName] = useState('')
  const [vlan, setVlan] = useState('')
  // 划分 / 划入 / 导出都绑定顶栏当前地址平面，不允许在表单里单独选另一个平面
  const [vrf, setVrf] = useState(() => {
    const initial = getApiVrf()
    return initial === 'all' ? 'default' : initial
  })
  useEffect(() => {
    const next = plane === 'all' ? 'default' : plane
    setVrf(next)
  }, [plane])
  const [plan, setPlan] = useState<PlanResult | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(0)   // 0 = 一次列出可承载的全部子网
  const [effectiveSize, setEffectiveSize] = useState(MAX_PAGE_SIZE)
  const [statusFilter, setStatusFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [jump, setJump] = useState('')
  const [scrollPending, setScrollPending] = useState(false)

  const { data, reload } = useLoad(
    () => Promise.all([api.spaces(), api.vrfs()]), [refreshKey], notify,
  )
  const [spaces, vrfData] = data ?? [null, null]
  const prefixes: Prefix[] = spaces?.prefixes ?? []
  const vrfs: Vrf[] = vrfData?.items ?? []

  const parent = parentChoice === CUSTOM ? customParent.trim() : parentChoice
  const parentLen = Number(parent.split('/')[1] ?? NaN)
  const validParentLen = Number.isInteger(parentLen) && parentLen >= 0 && parentLen < 32
  const prefixChoices = validParentLen
    ? Array.from({ length: 32 - parentLen }, (_, i) => parentLen + i + 1)
    : []
  const parentInTree = prefixes.some(p => p.cidr === parent)
  const paramsDirty = !!plan && (plan.parent.cidr !== parent || plan.new_prefix !== newPrefix)
  const canCommit = isAdmin && parentInTree && !paramsDirty && selected.size > 0 && !busy
  const pageCount = plan ? Math.max(1, Math.ceil(plan.total_in_parent / effectiveSize)) : 1

  async function runPlan(opts: {
    p?: string; np?: number; page?: number; size?: number; keepSelection?: boolean
  } = {}) {
    const p = opts.p ?? parent
    const np = opts.np ?? newPrefix
    const size = opts.size ?? pageSize
    setBusy(true)
    try {
      // 先轻量探测真实总数，再决定本次要取多少行：<=2000 个子网时一次全部列出
      const probe = await api.planSubnets(p, np, 0, 1, vrf)
      const total = probe.total_in_parent
      const eff = size === 0 ? Math.min(total, MAX_PAGE_SIZE) : Math.min(size, MAX_PAGE_SIZE)
      const pages = Math.max(1, Math.ceil(total / eff))
      const safePage = Math.min(Math.max(1, opts.page ?? 1), pages)
      const res = await api.planSubnets(p, np, (safePage - 1) * eff, eff, vrf)
      setPlan(res)
      setPage(safePage)
      setEffectiveSize(eff)
      setJump('')
      if (!opts.keepSelection) setSelected(new Set())
    } catch (err) {
      notify(err instanceof Error ? err.message : '计算失败', 'error')
      setPlan(null)
      setSelected(new Set())
    } finally {
      setBusy(false)
    }
  }

  // 首次进入给出默认规划；切换地址平面后重叠状态要按新平面重新试算
  useEffect(() => { void runPlan() }, [vrf])

  // 主动计算 / 翻页后定位到结果区，避免用户还要手动滚过参数区
  useEffect(() => {
    if (scrollPending && plan && !busy) {
      document.getElementById('subnet-result')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      setScrollPending(false)
    }
  }, [scrollPending, plan, busy])

  function chooseParent(v: string) {
    setParentChoice(v)
    const len = Number((v === CUSTOM ? customParent : v).split('/')[1] ?? NaN)
    if (Number.isInteger(len) && len >= 0 && len < 32) setNewPrefix(Math.min(32, len + 8))
  }

  function toggle(cidr: string, available: boolean) {
    if (!available || !isAdmin) return
    setSelected(s => {
      const next = new Set(s)
      if (next.has(cidr)) next.delete(cidr); else next.add(cidr)
      return next
    })
  }

  function gotoPage(n: number) {
    setScrollPending(true)
    void runPlan({ p: plan?.parent.cidr, np: plan?.new_prefix, page: n, keepSelection: true })
  }

  function changePageSize(v: number) {
    setPageSize(v)
    setScrollPending(true)
    void runPlan({ p: plan?.parent.cidr, np: plan?.new_prefix, size: v, page: 1 })
  }

  async function commit() {
    if (!plan || selected.size === 0) return
    if (!isAdmin) { notify('只读用户只能试算，不能划入地址空间', 'error'); return }
    setBusy(true)
    try {
      const res = await api.commitSubnets({
        parent: plan.parent.cidr, cidrs: [...selected],
        name: name.trim() || undefined,
        vlan: vlan.trim() ? Number(vlan) : null, vrf,
      })
      notify(`已划入 ${res.created} 个子网：${res.cidrs.slice(0, 4).join(', ')}${res.cidrs.length > 4 ? ' …' : ''}`)
      reload()
      onChanged()
      await runPlan({ p: plan.parent.cidr, np: plan.new_prefix })
    } catch (err) {
      notify(err instanceof Error ? err.message : '划入失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  async function exportCsv() {
    if (!plan) return
    setBusy(true)
    try {
      const res = await fetch(
        '/api' + api.subnetPlanExportPath(plan.parent.cidr, plan.new_prefix, vrf),
        { credentials: 'include', headers: { 'X-IPAM-VRF': getApiVrf() } })
      if (!res.ok) {
        let detail = `导出失败 (${res.status})`
        try { const body = await res.json(); if (body?.detail) detail = String(body.detail) } catch { /* 保留默认 */ }
        throw new Error(detail)
      }
      const url = URL.createObjectURL(await res.blob())
      const a = document.createElement('a')
      a.href = url
      a.download = `subnet-plan-${plan.parent.cidr.replace('/', '_')}-${plan.new_prefix}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      notify(`已导出全部 ${plan.total_in_parent.toLocaleString()} 个子网`)
    } catch (err) {
      notify(err instanceof Error ? err.message : '导出失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  const visible = (plan?.items ?? []).filter(i => {
    if (statusFilter === 'available' && !i.available) return false
    if (statusFilter === 'conflict' && i.available) return false
    if (query.trim()) {
      const q = query.trim().toLowerCase()
      return [i.cidr, i.network, i.first_host, i.last_host, ...i.conflicts]
        .some(s => s.toLowerCase().includes(q))
    }
    return true
  })

  function selectAllVisible(rows: SubnetCandidate[]) {
    if (!isAdmin) return
    setSelected(s => {
      const next = new Set(s)
      rows.filter(i => i.available).forEach(i => next.add(i.cidr))
      return next
    })
  }

  return (
    <>
      <div className="stat-row">
        <MiniStat label="可拆子网数" value={plan?.total_in_parent.toLocaleString() ?? '—'}
          foot={`/${plan?.new_prefix ?? newPrefix} 等分 · 全量`} />
        <MiniStat label="本次列出" value={plan?.shown.toLocaleString() ?? '—'}
          foot={plan && plan.shown < plan.total_in_parent
            ? `第 ${plan.offset + 1}–${plan.offset + plan.shown} 个` : '已全部列出'} tone="blue" />
        <MiniStat label="可划入" value={plan?.available_count.toLocaleString() ?? '—'}
          foot="全量统计 · 不重叠" tone="teal" />
        <MiniStat label="已勾选" value={selected.size}
          foot="可跨页勾选 · 批量写入" tone="amber" />
      </div>

      <div className="grid-2">
        <Card title="子网划分" hint="03 领域核心层 · CIDR 等分计算与重叠校验">
          <div className="form-grid">
            <div className="field"><label>父前缀</label>
              <select id="subnet-parent" value={parentChoice} onChange={e => chooseParent(e.target.value)}>
                {prefixes.map(p => <option key={p.cidr} value={p.cidr}>{p.cidr} · {p.name}</option>)}
                <option value={CUSTOM}>自定义 CIDR…</option>
              </select>
            </div>
            <div className="field"><label>目标掩码</label>
              <select id="subnet-new-prefix" value={newPrefix}
                onChange={e => setNewPrefix(Number(e.target.value))} disabled={!validParentLen}>
                {prefixChoices.map(n => {
                  const count = 2 ** (n - parentLen)
                  return <option key={n} value={n} disabled={count > MAX_TOTAL}>
                    /{n} · {count.toLocaleString()} 个子网 · 每段 { (2 ** (32 - n)).toLocaleString() } 地址
                  </option>
                })}
              </select>
              <div className="help">可选到 /32；单次最多 {MAX_TOTAL.toLocaleString()} 个子网。</div>
            </div>
            {parentChoice === CUSTOM && (
              <div className="field full"><label>自定义父前缀</label>
                <input id="subnet-parent-custom" value={customParent}
                  onChange={e => {
                    setCustomParent(e.target.value)
                    const len = Number(e.target.value.split('/')[1] ?? NaN)
                    if (Number.isInteger(len) && len >= 0 && len < 32) setNewPrefix(Math.min(32, len + 8))
                  }}
                  placeholder="例如 192.168.10.0/24" />
                <div className="help">输入标准网络号（如 10.20.0.0/16），仅用于试算。</div>
              </div>
            )}
            <div className="field"><label>子网名称</label>
              <input id="subnet-name" value={name} onChange={e => setName(e.target.value)}
                placeholder="例如 新建业务网段" />
            </div>
            <div className="field"><label>VLAN（可选）</label>
              <input id="subnet-vlan" value={vlan} onChange={e => setVlan(e.target.value)}
                placeholder="例如 910" />
            </div>
            <div className="field full"><label>目标 VRF 地址平面</label>
              <select id="subnet-vrf" value={vrf} disabled title="由顶栏「当前地址平面」控制">
                {vrfs.length === 0 && <option value={vrf}>{vrf}</option>}
                {vrfs.map(v => <option key={v.name} value={v.name}>{v.name} · {v.tenant}</option>)}
                {vrfs.length > 0 && !vrfs.some(v => v.name === vrf) && <option value={vrf}>{vrf}</option>}
              </select>
              <div className="help">
                由顶栏「当前地址平面」决定：试算、划入与 CSV 导出都只在该平面内判重叠，
                同一 CIDR 可在不同 VRF 平面各自划入，互不冲突。
              </div>
            </div>
          </div>

          {!parentInTree && parentChoice === CUSTOM && (
            <div className="check-note pending">自定义前缀仅用于试算，未登记在地址空间树中，不能划入。</div>
          )}
          {paramsDirty && (
            <div className="check-note pending">父前缀 / 目标掩码已变更，请重新点击「计算划分」。</div>
          )}

          <div className="inline" style={{ marginTop: 4 }}>
            <button className="btn primary" id="subnet-calc" disabled={busy}
              onClick={() => { setScrollPending(true); void runPlan() }}>
              <Icon name="split" />计算划分
            </button>
            <button className="btn" id="subnet-commit" onClick={commit} disabled={!canCommit}>
              <Icon name="plus" />划入地址空间（{selected.size}）
            </button>
            {!isAdmin && <span className="muted small">只读账号可试算与导出，不能写入</span>}
          </div>
        </Card>

        <div className="stack-col">
          <Card title="计算规则" hint="领域核心层约束">
            <div className="rule-grid">
              <div className="warn-item">
                <div className="warn-head"><b>CIDR 等分 · 全量列出</b><Tag text="subnets_of" tone="blue" /></div>
                <div className="warn-note">父前缀按目标掩码等分为 2^(新掩码−父掩码) 个子网，结果全部列出，不再只显示前 64 个；单页最多 2000 行，超出自动分页，可用「导出全部 CSV」取得完整清单。</div>
              </div>
              <div className="warn-item">
                <div className="warn-head"><b>重叠校验</b><Tag text="整数区间" tone="blue" /></div>
                <div className="warn-note">祖先前缀属于正常包含关系不算冲突；同网段重复、候选内含更细划分、CIDR 部分交叠都标记为冲突且不可勾选。可划入 / 冲突数为全量统计。</div>
              </div>
              <div className="warn-item">
                <div className="warn-head"><b>保留地址</b><Tag text="每段 3 个" tone="amber" /></div>
                <div className="warn-note">网络号、默认网关、广播地址不参与分配；每个 /24 可分配 253 个。</div>
              </div>
              <div className="warn-item">
                <div className="warn-head"><b>事务与审计</b><Tag text="BEGIN IMMEDIATE" tone="teal" /></div>
                <div className="warn-note">批量划入在同一事务内完成，任一冲突则整批拒绝；写入后生成审计日志与 Webhook 事件。</div>
              </div>
            </div>
            <div className="rule-prefixes">
              <div className="rule-prefixes-head">现有前缀 · {prefixes.length} 条</div>
              <div className="rule-prefix-chips">
                {prefixes.map(p => (
                  <span key={p.cidr} className="mono"
                    title={`${p.name} · 利用率 ${p.util}%`}>{p.cidr}</span>
                ))}
              </div>
            </div>
          </Card>
        </div>
      </div>

      {plan && (
        <div id="subnet-result">
        <Card className="subnet-result-card" title="划分结果 · 全部子网"
          hint={`${plan.parent.cidr} → /${plan.new_prefix} · 共 ${plan.total_in_parent.toLocaleString()} 个子网`}>
          <div className="plan-section">
            <div className="info-grid">
              <div><span>网络号</span><b className="mono">{plan.parent.network}</b></div>
              <div><span>子网掩码</span><b className="mono">{plan.parent.mask}</b></div>
              <div><span>广播地址</span><b className="mono">{plan.parent.broadcast}</b></div>
              <div><span>地址总数</span><b>{plan.parent.total.toLocaleString()}</b></div>
              <div><span>首个可分配</span><b className="mono">{plan.parent.first_host}</b></div>
              <div><span>末个可分配</span><b className="mono">{plan.parent.last_host}</b></div>
              <div><span>反掩码</span><b className="mono">{plan.parent.wildcard}</b></div>
              <div><span>每段可用</span><b>{plan.items[0]?.usable.toLocaleString() ?? '—'}</b></div>
            </div>
          </div>

          {plan.total_in_parent > MAX_PAGE_SIZE && (
            <div className="plan-section">
              <div className="check-note" id="subnet-page-note">
                共 {plan.total_in_parent.toLocaleString()} 个子网，单页最多 {MAX_PAGE_SIZE.toLocaleString()} 行，已按真实序号自动分页；
                点击「导出全部 CSV」可一次性获取完整清单。
              </div>
            </div>
          )}

          <div className="plan-section">
            <div className="toolbar" style={{ marginBottom: 0 }}>
              <Segmented<Filter> value={statusFilter} onChange={setStatusFilter}
                options={[
                  { key: 'all', label: `全部 ${plan.total_in_parent.toLocaleString()}` },
                  { key: 'available', label: `可划入 ${plan.available_count.toLocaleString()}` },
                  { key: 'conflict', label: `冲突 ${plan.conflict_count.toLocaleString()}` },
                ]} />
              <input id="subnet-filter" className="plan-filter" value={query}
                onChange={e => setQuery(e.target.value)} placeholder="筛选当前已加载行（CIDR / 地址）" />
              <span className="spacer" />
              <label className="plan-count-note">每页
                <select id="subnet-page-size" value={pageSize}
                  onChange={e => changePageSize(Number(e.target.value))} disabled={busy}>
                  <option value={0}>全部（≤2000）</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                  <option value={200}>200</option>
                  <option value={500}>500</option>
                  <option value={1000}>1000</option>
                </select>
              </label>
              <button className="btn sm" id="subnet-select-page" onClick={() => selectAllVisible(visible)}
                disabled={!isAdmin || busy}>全选本页可用</button>
              <button className="btn sm" id="subnet-clear" onClick={() => setSelected(new Set())}>清空</button>
              <button className="btn sm" id="subnet-export" onClick={() => void exportCsv()} disabled={busy}>
                <Icon name="download" size={13} />导出全部 CSV
              </button>
            </div>
          </div>

          <div className="plan-table-wrap" id="subnet-table-wrap">
            <table className="plan-table">
              <thead>
                <tr>
                  <th style={{ width: 34 }}></th>
                  <th style={{ width: 56 }}>#</th>
                  <th>子网</th>
                  <th>子网掩码</th>
                  <th>地址范围</th>
                  <th>可用地址</th>
                  <th>状态</th>
                  <th>冲突前缀</th>
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 && (
                  <tr><td colSpan={8}><div className="empty">当前筛选条件下没有子网</div></td></tr>
                )}
                {visible.map(i => (
                  <tr key={i.cidr}
                    className={`${i.available ? '' : 'conflict-row'}${selected.has(i.cidr) ? ' checked' : ''}`}>
                    <td>
                      <input type="checkbox" className="plan-check" checked={selected.has(i.cidr)}
                        disabled={!i.available || !isAdmin}
                        onChange={() => toggle(i.cidr, i.available)}
                        aria-label={`勾选 ${i.cidr}`} />
                    </td>
                    <td className="muted mono small">{(i.index + 1).toLocaleString()}</td>
                    <td><b className="mono">{i.cidr}</b></td>
                    <td className="mono small">{i.mask}</td>
                    <td className="mono small">{i.first_host} – {i.last_host}</td>
                    <td className="mono">{i.usable.toLocaleString()}</td>
                    <td><Tag text={i.available ? '可划入' : '冲突'} tone={i.available ? 'teal' : 'red'} /></td>
                    <td className="cf small mono muted" title={i.conflicts.join(', ')}>
                      {i.conflicts.length ? i.conflicts.join(', ') : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="table-foot">
            <span id="subnet-range">
              共 <b>{plan.total_in_parent.toLocaleString()}</b> 个子网 · 当前显示第
              {' '}{plan.offset + 1}–{plan.offset + plan.shown} 个
              {query.trim() && ` · 本页筛选后 ${visible.length} 行`}
              {' · '}可划入 {plan.available_count.toLocaleString()} · 冲突 {plan.conflict_count.toLocaleString()}
            </span>
            <div className="inline">
              {pageCount > 1 && (
                <div className="pager" id="subnet-pager">
                  <button disabled={busy || page <= 1} onClick={() => gotoPage(page - 1)}>‹</button>
                  {pageNumbers(page, pageCount).map((n, idx) => n === '…'
                    ? <span key={`gap-${idx}`} className="muted small">…</span>
                    : <button key={n} className={n === page ? 'on' : ''} disabled={busy}
                        onClick={() => gotoPage(n)}>{n}</button>)}
                  <button disabled={busy || page >= pageCount} onClick={() => gotoPage(page + 1)}>›</button>
                </div>
              )}
              {pageCount > 7 && (
                <span className="inline small muted">跳至
                  <input id="subnet-jump" className="plan-jump" value={jump}
                    onChange={e => setJump(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        const n = Number(jump)
                        if (Number.isInteger(n)) gotoPage(Math.min(Math.max(1, n), pageCount))
                      }
                    }} />
                  页
                  <button className="btn sm" disabled={busy} onClick={() => {
                    const n = Number(jump)
                    if (Number.isInteger(n)) gotoPage(Math.min(Math.max(1, n), pageCount))
                  }}>跳转</button>
                </span>
              )}
            </div>
          </div>
        </Card>
        </div>
      )}
    </>
  )
}
