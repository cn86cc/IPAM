import { useEffect, useState } from 'react'
import { api } from '../api'
import { AddressTable, Card, Icon, Metric, Pill, ROW_ACTION } from '../components/ui'
import { type Action, type Dashboard, type IPLookup, type JumpTarget } from '../types'
import type { ViewProps } from './shared'

interface Props extends ViewProps {
  dash: Dashboard
  focusIp?: JumpTarget | null
  /** 嵌入「IP 分配/回收」合并页时，指标卡与地址记录表由外层统一渲染 */
  embedded?: boolean
}

const ACTION_TARGET: Record<Action, string> = {
  confirm: '已分配',
  release: '待回收',
  reclaim: '可用（登记记录删除）',
  resolve: '已分配',
}

/** 「IP 分配/回收」合并页的回收标签：按 IP 精确查询 + 状态机流转。 */
export default function ReclaimView({ dash, refreshKey, onChanged, notify, focusIp, embedded = false }: Props) {
  const [lookupAddr, setLookupAddr] = useState('')
  const [lookup, setLookup] = useState<IPLookup | null>(null)
  const [lookupError, setLookupError] = useState('')
  const [lookupBusy, setLookupBusy] = useState(false)

  const status = dash.status
  const lookupOp = lookup ? ROW_ACTION[lookup.item.status] : undefined
  const actionList = lookup
    ? Object.entries(lookup.actions) as [Action, { label: string; to: string }][]
    : []

  async function runLookup(addr: string) {
    setLookupBusy(true)
    setLookupError('')
    try {
      setLookup(await api.lookupIp(addr))
    } catch (err) {
      setLookup(null)
      setLookupError(err instanceof Error ? err.message : '查询失败')
    } finally {
      setLookupBusy(false)
    }
  }

  function doLookup() {
    const text = lookupAddr.trim()
    if (!text) { setLookupError('请输入要查询的 IP 地址'); return }
    void runLookup(text)
  }

  // 顶栏搜索跳转：自动填入并立即查询该地址的登记状态
  useEffect(() => {
    if (!focusIp) return
    setLookupAddr(focusIp.addr)
    void runLookup(focusIp.addr)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusIp])

  async function doAction(action: Action) {
    if (!lookup) return
    const target = lookup.item.addr
    setLookupBusy(true)
    try {
      const res = await api.transition(target, action)
      notify(`${res.addr} · ${res.label}`)
      onChanged()
      // reclaim 会删除登记行，此时地址已回到可用池，无需再查
      if (action === 'reclaim') { setLookup(null); setLookupError('') }
      else doLookup()
    } catch (err) {
      notify(err instanceof Error ? err.message : '操作失败', 'error')
    } finally {
      setLookupBusy(false)
    }
  }

  const flow = ['可用池', '预留', '已分配', '待回收', '可用池']

  return (
    <>
      {!embedded && (
        <div className="metrics">
          <Metric label="已分配" value={status.assigned ?? 0} unit="个" icon="ip"
            foot="可发起回收" />
          <Metric label="预留" value={status.reserved ?? 0} unit="个" icon="clock"
            foot="可确认分配" />
          <Metric label="待回收" value={status.deprecated ?? 0} unit="个" icon="undo"
            foot="等待释放校验" />
          <Metric label="冲突" value={status.conflict ?? 0} unit="个" icon="alert"
            foot="需处理冲突" />
        </div>
      )}

      <div className="grid-2" style={{ marginTop: embedded ? 0 : 16 }}>
        <Card title="按 IP 手动回收" hint="精确查询 → 执行状态机动作" extra={
          <span className="hint" id="reclaim-lookup-hint">无需在地址表中翻页</span>
        }>
          <div className="help" style={{ marginBottom: 14 }}>
            输入已登记的 IPv4 地址，查询其当前状态，然后执行该状态允许的动作。未登记的地址处于可用池，无需回收。
          </div>
          <form onSubmit={e => { e.preventDefault(); doLookup() }}>
            <div className="field">
              <label>IP 地址</label>
              <div className="inline">
                <input id="lookup-addr" className="mono" value={lookupAddr}
                  onChange={e => setLookupAddr(e.target.value)} placeholder="例如 10.1.1.2"
                  style={{ flex: '1 1 200px' }} />
                <button className="btn" type="submit" id="lookup-submit" disabled={lookupBusy}>
                  <Icon name="search" />{lookupBusy ? '查询中…' : '查询地址'}
                </button>
              </div>
              <div className="help">支持已分配 / 预留 / 待回收 / 冲突四种登记状态。</div>
            </div>
          </form>

          {lookupError && <div className="check-note bad" id="lookup-error">{lookupError}</div>}
          {lookup && (
            <div className="manual-lookup" id="lookup-result">
              <div className="check-line">
                <b className="mono" style={{ fontSize: 15 }}>{lookup.item.addr}</b>
                <Pill status={lookup.item.status} />
                <span className="hint">{lookup.item.prefix_cidr}</span>
              </div>
              <div className="help" style={{ marginTop: 6 }}>
                {lookup.item.hostname} · {lookup.item.business} / {lookup.item.owner} · VLAN {lookup.item.vlan}
              </div>
              <div className="inline" style={{ marginTop: 10 }}>
                {actionList.length > 0 ? actionList.map(([action, meta], i) => (
                  <button key={action} className="btn sm primary"
                    id={i === 0 ? 'lookup-action' : undefined} disabled={lookupBusy}
                    onClick={() => void doAction(action)}>
                    {meta.label}
                  </button>
                )) : (
                  <span className="help">当前状态无可执行动作</span>
                )}
              </div>
              {lookupOp && (
                <div className="help" style={{ marginTop: 8 }}>
                  执行后状态流转为「{ACTION_TARGET[lookupOp.action]}」。
                </div>
              )}
            </div>
          )}

          <div className="help" style={{ marginTop: 12 }}>
            回收按状态机分步执行：已分配 → 发起回收 → 待回收 → 释放归还；释放后登记行被删除，地址回到可用池。
            预留地址可在此「确认分配」，冲突地址可「处理冲突」。
          </div>
        </Card>

        <div className="stack-col">
          <Card title="状态机与回收闭环" hint="写操作统一经领域核心层">
            <div className="flow">
              {flow.map((n, i) => (
                <span key={i} style={{ display: 'contents' }}>
                  {i > 0 && <span className="arw">→</span>}
                  <span className={`node${i === 3 ? ' hi' : ''}`}>{n}</span>
                </span>
              ))}
            </div>
            <p className="footnote" style={{ marginTop: 12 }}>
              预留 → 已分配（确认）；已分配 → 待回收（发起回收）；待回收 → 可用（释放校验后删除记录，地址回到空闲池）。
              冲突地址经「处理冲突」回到已分配。所有流转写入审计日志。
            </p>
          </Card>

          <Card title="回收规则与约束" hint="领域核心层">
            <div className="warn-item">
              <div className="warn-head"><b>状态机约束</b><span className="lvl warn">非法流转 409</span></div>
              <div className="warn-note">只允许定义好的流转，重复点击或状态不符时后端直接拒绝</div>
            </div>
            <div className="warn-item">
              <div className="warn-head"><b>释放校验</b><span className="lvl warn">删除登记行</span></div>
              <div className="warn-note">待回收 → 释放归还后地址不落库，由前缀区间减去占用集合重新推导为空闲</div>
            </div>
            <div className="warn-item">
              <div className="warn-head"><b>并发安全</b><span className="lvl warn">立即事务</span></div>
              <div className="warn-note">状态流转与地址分配共用数据库立即事务，避免同一地址被并发重复占用</div>
            </div>
            <div className="warn-item">
              <div className="warn-head"><b>按状态筛选</b><span className="lvl warn">地址记录表</span></div>
              <div className="warn-note">下方地址记录表可切换「待回收 / 冲突」等标签页，并逐行执行对应动作</div>
            </div>
            <div className="warn-item">
              <div className="warn-head"><b>留痕</b><span className="lvl warn">审计日志</span></div>
              <div className="warn-note">release / reclaim / confirm / resolve 全部只追加写入审计日志</div>
            </div>
          </Card>

          <Card title="相关入口" hint="页面分工">
            <p className="footnote" style={{ marginTop: 0 }}>
              自动 / 手动分配地址在页面顶部「IP 分配」标签；对账差异处理在「发现与对账」；批量回收申请在「分配申请」；
              回收留痕可在「审计日志」按动作检索。下方地址记录表为分配与回收共用。
            </p>
          </Card>
        </div>
      </div>

      {!embedded && (
        <div style={{ marginTop: 16 }}>
          <AddressTable prefix="all" actions refreshKey={refreshKey} onChanged={onChanged} notify={notify} />
        </div>
      )}
    </>
  )
}
