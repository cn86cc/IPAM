import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { api } from '../api'
import { Card, Icon, Pill } from '../components/ui'
import type { IPLookup, JumpTarget, Spaces } from '../types'
import { sortPrefixes } from './shared'
import SubnetAddressMap from './SubnetAddressMap'
import type { Notify } from './shared'

/** 只读用户的分配标签：只能浏览地址位图，不提供分配表单。 */
export function ReadOnlyAllocation({ spaces, focusAddr, refreshKey, notify }: {
  spaces: Spaces
  focusAddr?: JumpTarget | null
  refreshKey: number
  notify: Notify
}) {
  const subnets = useMemo(
    () => sortPrefixes(spaces.prefixes.filter(p => p.kind === 'subnet')), [spaces.prefixes])
  const [cidr, setCidr] = useState(subnets[0]?.cidr ?? '')
  const [picked, setPicked] = useState('')

  useEffect(() => {
    if (!cidr && subnets.length) setCidr(subnets[0].cidr)
  }, [cidr, subnets])

  // 顶栏搜索可用池地址：自动定位到其所属子网
  useEffect(() => {
    if (!focusAddr) return
    const hit = subnets.find(p => {
      const [base, bits] = p.cidr.split('/')
      const prefix = Number(bits)
      const toInt = (s: string) => s.split('.').reduce((n, x) => n * 256 + Number(x), 0)
      const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0
      return (toInt(base) & mask) === (toInt(focusAddr.addr) & mask)
    })
    if (hit) setCidr(hit.cidr)
    setPicked(focusAddr.addr)
  }, [focusAddr, subnets])

  return (
    <>
      <div className="grid-2">
        <Card title="只读浏览 · 子网地址使用状况" hint="不含任何写操作" extra={
          <span className="hint">可见范围内</span>
        }>
          <div className="field">
            <label>目标子网</label>
            <select id="readonly-subnet" value={cidr} onChange={e => setCidr(e.target.value)}>
              {subnets.map(p => <option key={p.cidr} value={p.cidr}>{p.cidr} · {p.name}</option>)}
            </select>
            <div className="help">选择一个已授权子网，下方可视化展示该网段全部地址的使用状况。</div>
          </div>
          {picked && <div className="check-note ok">当前选中地址 <b className="mono">{picked}</b>（只读，不能分配）</div>}
        </Card>
        <Card title="只读模式说明" hint="权限边界">
          <div className="warn-item">
            <div className="warn-head"><b>可查看</b><span className="lvl warn">全部状态</span></div>
            <div className="warn-note">已登记、预留、待回收、冲突、保留地址与更细子网划分。</div>
          </div>
          <div className="warn-item">
            <div className="warn-head"><b>不可执行</b><span className="lvl warn">写操作 403</span></div>
            <div className="warn-note">自动 / 手动分配、状态流转、前缀编辑等所有非 GET 请求由后端统一拒绝。</div>
          </div>
          <p className="footnote" style={{ lineHeight: 1.9 }}>
            需要分配地址请联系管理员，或到「分配申请」提交工单（若该模块已授权）。
            顶栏可手动切换当前查看的 CIDR 范围。
          </p>
        </Card>
      </div>
      {cidr ? (
        <div style={{ marginTop: 16 }}>
          <SubnetAddressMap cidr={cidr} currentAddr={picked} onPick={setPicked}
            refreshKey={refreshKey} notify={notify} />
        </div>
      ) : (
        <Card className="ipmap-card" title="可视化子网显示">
          <div className="empty">当前可见范围内没有可分配子网</div>
        </Card>
      )}
    </>
  )
}

/** 只读用户的回收标签：可精确查询登记状态，不提供状态流转按钮。 */
export function ReadOnlyReclaim({ focusIp, notify }: {
  focusIp?: JumpTarget | null
  notify: Notify
}) {
  const [addr, setAddr] = useState('')
  const [lookup, setLookup] = useState<IPLookup | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function run(value: string) {
    setBusy(true); setError('')
    try { setLookup(await api.lookupIp(value)) }
    catch (err) {
      setLookup(null)
      setError(err instanceof Error ? err.message : '查询失败')
    } finally { setBusy(false) }
  }

  useEffect(() => {
    if (!focusIp) return
    setAddr(focusIp.addr)
    void run(focusIp.addr)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusIp])

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!addr.trim()) { setError('请输入要查询的 IP 地址'); return }
    void run(addr.trim())
  }

  return (
    <div className="grid-2">
      <Card title="只读浏览 · IP 登记状态查询" hint="精确查询，只读" extra={
        <span className="hint">无需在地址表中翻页</span>
      }>
        <form onSubmit={submit}>
          <div className="field">
            <label>IP 地址</label>
            <div className="inline">
              <input id="readonly-lookup" className="mono" value={addr}
                onChange={e => setAddr(e.target.value)} placeholder="例如 10.1.1.2"
                style={{ flex: '1 1 200px' }} />
              <button className="btn" type="submit" disabled={busy}>
                <Icon name="search" />{busy ? '查询中…' : '查询地址'}
              </button>
            </div>
          </div>
        </form>
        {error && <div className="check-note bad">{error}</div>}
        {lookup && (
          <div className="manual-lookup" id="readonly-lookup-result">
            <div className="check-line">
              <b className="mono" style={{ fontSize: 15 }}>{lookup.item.addr}</b>
              <Pill status={lookup.item.status} />
              <span className="hint">{lookup.item.prefix_cidr}</span>
            </div>
            <div className="help" style={{ marginTop: 6 }}>
              {lookup.item.hostname} · {lookup.item.business} / {lookup.item.owner} · VLAN {lookup.item.vlan}
            </div>
            <div className="help" style={{ marginTop: 8 }}>
              当前状态可执行的状态机动作共 {Object.keys(lookup.actions).length} 项，只读用户不能执行。
            </div>
          </div>
        )}
        <div className="help" style={{ marginTop: 12 }}>
          回收按状态机分步执行：已分配 → 待回收 → 释放归还。只读用户可查看状态，流转需由管理员操作。
        </div>
      </Card>
      <Card title="状态机与回收闭环" hint="只读说明">
        <div className="flow">
          {['可用池', '预留', '已分配', '待回收', '可用池'].map((n, i) => (
            <span key={i} style={{ display: 'contents' }}>
              {i > 0 && <span className="arw">→</span>}
              <span className={`node${i === 3 ? ' hi' : ''}`}>{n}</span>
            </span>
          ))}
        </div>
        <p className="footnote" style={{ marginTop: 12, lineHeight: 1.9 }}>
          预留 → 已分配（确认）；已分配 → 待回收（发起回收）；待回收 → 可用（释放校验后删除记录）。
          冲突地址经「处理冲突」回到已分配。所有流转写入审计日志，只读用户不产生写操作。
        </p>
        <button className="btn" style={{ marginTop: 8 }}
          onClick={() => notify('只读用户不能执行回收，请联系管理员')}>
          <Icon name="shield" />申请回收权限
        </button>
      </Card>
    </div>
  )
}
