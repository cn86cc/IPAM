import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { api } from '../api'
import { AddressTable, Card, Icon } from '../components/ui'
import {
  STATUS_LABEL, type AllocationResult, type Dashboard, type JumpTarget,
  type ManualCheck, type Spaces,
} from '../types'
import { sortPrefixes, type ViewProps } from './shared'
import SubnetAddressMap from './SubnetAddressMap'

interface Props extends ViewProps {
  spaces: Spaces
  dash: Dashboard
  focusAddr?: JumpTarget | null
  /** 嵌入「IP 分配/回收」合并页时，地址记录表由外层统一渲染 */
  embedded?: boolean
}

/** 「IP 分配/回收」合并页的分配标签：自动取号 / 手动指定 IP + 子网地址可视化。 */
export default function AllocationView({
  spaces, dash, refreshKey, onChanged, notify, focusAddr, embedded = false,
}: Props) {
  const subnets = useMemo(
    () => sortPrefixes(spaces.prefixes.filter(p => p.kind === 'subnet')),
    [spaces.prefixes],
  )
  const [allocMode, setAllocMode] = useState<'auto' | 'manual'>('auto')
  const [prefix, setPrefix] = useState(subnets[0]?.cidr ?? '')
  const [addr, setAddr] = useState('')
  const [business, setBusiness] = useState('核心交易平台')
  const [owner, setOwner] = useState('张伟')
  const [hostname, setHostname] = useState('')
  const [mode, setMode] = useState<'assigned' | 'reserved'>('assigned')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<AllocationResult | null>(null)
  const [check, setCheck] = useState<ManualCheck | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState('')

  const isManual = allocMode === 'manual'
  const effectivePrefix = isManual && prefix === 'auto' ? 'auto' : prefix
  const selected = subnets.find(p => p.cidr === prefix)
  const checkReady = !!check?.valid && !checking && check.addr === addr.trim()
  // 手动模式：显式选定的子网，或按已输入 IP 自动匹配出的归属子网
  const mapCidr = isManual
    ? (prefix !== 'auto' ? prefix : (check?.resolved_prefix ?? ''))
    : ''

  // 子网列表异步到位后补默认值；自动模式必须落到具体子网，手动模式默认自动匹配
  useEffect(() => {
    if (!prefix && subnets.length) {
      setPrefix(isManual ? 'auto' : subnets[0].cidr)
    }
  }, [prefix, subnets, isManual])

  // 顶栏搜索跳转：可用池地址自动切到手动模式并预填，随后触发实时预检
  useEffect(() => {
    if (!focusAddr) return
    setAllocMode('manual')
    setPrefix('auto')
    setAddr(focusAddr.addr)
    setResult(null)
  }, [focusAddr])

  function switchMode(next: 'auto' | 'manual') {
    if (next === allocMode) return
    setAllocMode(next)
    setPrefix(next === 'manual' ? 'auto' : (subnets[0]?.cidr ?? ''))
    setCheck(null)
    setCheckError('')
    setChecking(false)
    setResult(null)
  }

  // 手动指定 IP：防抖实时预检，复用后端同一套归属 / 保留地址 / 占用校验
  useEffect(() => {
    if (!isManual || !addr.trim()) {
      setCheck(null); setCheckError(''); setChecking(false)
      return
    }
    let alive = true
    setChecking(true)
    const timer = window.setTimeout(() => {
      api.checkAllocation({ addr: addr.trim(), prefix: effectivePrefix })
        .then(res => { if (alive) { setCheck(res); setCheckError('') } })
        .catch(err => {
          if (alive) {
            setCheck(null)
            setCheckError(err instanceof Error ? err.message : '预检失败')
          }
        })
        .finally(() => { if (alive) setChecking(false) })
    }, 260)
    return () => { alive = false; window.clearTimeout(timer) }
  }, [isManual, addr, effectivePrefix, refreshKey])

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!prefix) { notify('请先选择目标子网', 'error'); return }
    if (isManual) {
      if (!addr.trim()) { notify('请输入要分配的 IP 地址', 'error'); return }
      if (!checkReady) { notify('该 IP 未通过预检，请修正后再提交', 'error'); return }
    }
    setBusy(true)
    try {
      const res = await api.allocate({
        prefix: effectivePrefix, business: business.trim() || '未指定',
        owner: owner.trim() || '—', hostname: hostname.trim() || undefined, mode,
        ...(isManual ? { addr: addr.trim() } : {}),
      })
      setResult(res)
      notify(`${res.addr} ${mode === 'reserved' ? '已预留' : '已分配'} · ${res.prefix}${res.source === 'manual' ? '（手动指定）' : ''}`)
      onChanged()
    } catch (err) {
      notify(err instanceof Error ? err.message : '分配失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  const flow = ['可用池', '预留', '已分配']

  return (
    <>
      <div className="grid-2">
        <Card title="地址分配" extra={
          <div className="tabs" id="alloc-mode">
            <button type="button" id="alloc-mode-auto" className={`tab${!isManual ? ' active' : ''}`}
              onClick={() => switchMode('auto')}>自动分配</button>
            <button type="button" id="alloc-mode-manual" className={`tab${isManual ? ' active' : ''}`}
              onClick={() => switchMode('manual')}>手动指定 IP</button>
          </div>
        }>
          <div className="help" style={{ marginBottom: 14 }}>
            {isManual
              ? '手动指定要登记的 IPv4 地址，提交前实时校验归属子网、保留地址与占用状态；下方可视化展示所选子网全部地址的使用状况，点击可用地址可直接填入。'
              : '自动取目标子网内最小的可用地址，跳过网络号 / 网关 / 广播地址。'}
          </div>
          <form onSubmit={submit}>
            <div className="field">
              <label>目标子网</label>
              <select id="alloc-prefix" value={prefix} onChange={e => setPrefix(e.target.value)}>
                {isManual && <option value="auto">自动匹配（按 IP 归属最细子网）</option>}
                {subnets.map(p => (
                  <option key={p.cidr} value={p.cidr}>
                    {p.cidr} · {p.name}（可用 {p.free}）
                  </option>
                ))}
              </select>
              <div className="help">
                {prefix === 'auto'
                  ? '将根据输入的 IP 自动选择最细归属子网；显式指定时会校验该 IP 是否属于所选网段。'
                  : selected
                    ? `${selected.site} · VLAN ${selected.vlan ?? '—'} · 利用率 ${selected.util}% · 串行加锁防止并发撞号`
                    : '暂无可分配子网'}
              </div>
            </div>

            {isManual && (
              <div className="field">
                <label>指定 IP 地址</label>
                <div className="inline">
                  <input id="manual-addr" className="mono" value={addr}
                    onChange={e => setAddr(e.target.value)} placeholder="例如 10.1.2.50"
                    style={{ flex: '1 1 200px' }} />
                  {check?.suggestion && check.suggestion !== addr.trim() && (
                    <button type="button" className="mini-link" id="fill-suggestion"
                      onClick={() => setAddr(check.suggestion ?? '')}>
                      填入推荐 {check.suggestion}
                    </button>
                  )}
                </div>
                <div className="help">单个 IPv4 主机地址，不带掩码；网络号、默认网关与广播地址不可分配。</div>
                {addr.trim() && (
                  checking
                    ? <div className="check-note pending">正在校验地址…</div>
                    : checkError
                      ? <div className="check-note bad">{checkError}</div>
                      : check && (check.valid
                        ? (
                          <div className="check-note ok" id="manual-check-ok">
                            <div className="check-line"><b>✓ 该地址可分配</b>
                              <span>归属 {check.resolved_prefix} · {check.info?.name} · VLAN {check.info?.vlan ?? '—'}</span>
                            </div>
                            <div className="check-line">可分配范围 {check.info?.first_host} – {check.info?.last_host} · 剩余 {check.info?.free} 个</div>
                          </div>
                        )
                        : (
                          <div className="check-note bad" id="manual-check-bad">
                            {check.issues.map((x, i) => <div key={i}>· {x}</div>)}
                            {check.resolved_prefix && (
                              <div style={{ marginTop: 4 }}>
                                归属 {check.resolved_prefix} · 可分配范围 {check.info?.first_host} – {check.info?.last_host}
                              </div>
                            )}
                          </div>
                        ))
                )}
              </div>
            )}

            <div className="field"><label>业务系统</label>
              <input value={business} onChange={e => setBusiness(e.target.value)} placeholder="例如 核心交易平台" />
            </div>
            <div className="field"><label>负责人</label>
              <input value={owner} onChange={e => setOwner(e.target.value)} placeholder="例如 张伟" />
            </div>
            <div className="field"><label>主机名（可选，留空自动生成）</label>
              <input value={hostname} onChange={e => setHostname(e.target.value)} placeholder="留空自动生成" />
            </div>
            <div className="field">
              <label>分配方式</label>
              <div className="tabs" style={{ width: 'fit-content' }}>
                <button type="button" id="alloc-mode-assigned" className={`tab${mode === 'assigned' ? ' active' : ''}`}
                  onClick={() => setMode('assigned')}>直接分配</button>
                <button type="button" id="alloc-mode-reserved" className={`tab${mode === 'reserved' ? ' active' : ''}`}
                  onClick={() => setMode('reserved')}>仅预留</button>
              </div>
              <div className="help">预留态可在下方地址记录表中点「确认分配」转入已分配。</div>
            </div>
            <button className="btn primary" type="submit" id="alloc-submit"
              disabled={busy || !prefix || (isManual && !checkReady)} style={{ width: '100%' }}>
              <Icon name="plus" />{busy ? '分配中…' : isManual ? '按指定 IP 分配' : '自动分配下一个可用 IP'}
            </button>
          </form>

          {result && (
            <div className="result" id="alloc-result">
              <div className="label">
                {result.source === 'manual' ? '手动指定分配成功' : '自动分配成功'} · {STATUS_LABEL[result.status]}
              </div>
              <div className="value">{result.addr}</div>
              <div className="meta">
                {result.prefix} · {result.hostname} · {result.business} / {result.owner} · VLAN {result.vlan}
              </div>
            </div>
          )}
        </Card>

        <div className="stack-col">
          <Card title="分配状态" hint="可用池 → 占用">
            <div className="flow">
              {flow.map((n, i) => (
                <span key={i} style={{ display: 'contents' }}>
                  {i > 0 && <span className="arw">→</span>}
                  <span className={`node${(i === 2 && mode === 'assigned') || (i === 1 && mode === 'reserved') ? ' hi' : ''}`}>{n}</span>
                </span>
              ))}
            </div>
            <p className="footnote" style={{ marginTop: 12 }}>
              自动分配取网段内最小可用地址；手动分配指定具体 IPv4 并实时预检归属与冲突。
              「直接分配」写入已分配态，「仅预留」写入预留态，需再确认。两条路径共用前缀锁与领域层事务。
            </p>
            <div className="help" style={{ marginTop: 8 }}>
              需要回收地址或执行状态流转，请切换到页面顶部「IP 回收」标签；两个标签共用下方同一份地址记录表。
            </div>
          </Card>

          <Card title="最近操作" hint="审计日志">
            {dash.audit.length === 0 ? <div className="empty">暂无操作记录</div> :
              dash.audit.map((a, i) => (
                <div className="audit-row" key={`${a.ts}-${i}`}>
                  <time>{a.ts.slice(5, 16)}</time>
                  <span className="mono">{a.addr ?? '—'}</span>
                  <span>{a.detail}</span>
                </div>
              ))}
          </Card>

          <Card title="分配规则与约束" hint="领域核心层">
            <div className="warn-item">
              <div className="warn-head"><b>保留地址</b><span className="lvl warn">每个 /24 共 3 个</span></div>
              <div className="warn-note">网络号 .0、默认网关 .1、广播地址 .255 不参与分配</div>
            </div>
            <div className="warn-item">
              <div className="warn-head"><b>并发防重</b><span className="lvl warn">前缀锁</span></div>
              <div className="warn-note">同一前缀串行化 + 数据库立即事务，避免并发申请拿到同一地址</div>
            </div>
            <div className="warn-item">
              <div className="warn-head"><b>空闲池推导</b><span className="lvl warn">不落库</span></div>
              <div className="warn-note">可用地址 = 前缀区间 − 已登记占用集合；自动模式取最小可用值</div>
            </div>
            <div className="warn-item">
              <div className="warn-head"><b>手动指定</b><span className="lvl warn">归属校验</span></div>
              <div className="warn-note">校验 IPv4 格式、最细归属子网、保留地址与已占用；两条路径共用前缀锁与事务</div>
            </div>
            <div className="warn-item">
              <div className="warn-head"><b>边界</b><span className="lvl warn">仅可分配子网</span></div>
              <div className="warn-note">聚合前缀不能直接分配；地址不在任何已纳管子网时拒绝登记并提示先划入网段</div>
            </div>
          </Card>
        </div>
      </div>

      {isManual && (mapCidr ? (
        <SubnetAddressMap cidr={mapCidr} currentAddr={addr} onPick={setAddr}
          refreshKey={refreshKey} notify={notify} />
      ) : (
        <Card className="ipmap-card" title="可视化子网显示">
          <div className="empty">
            请选择一个具体的目标子网，或输入 IP 地址后自动匹配归属子网，即可查看该网段全部地址的使用状况。
          </div>
        </Card>
      ))}

      {!embedded && (
        <div style={{ marginTop: 16 }}>
          <AddressTable prefix="all" actions refreshKey={refreshKey} onChanged={onChanged} notify={notify} />
        </div>
      )}
    </>
  )
}
