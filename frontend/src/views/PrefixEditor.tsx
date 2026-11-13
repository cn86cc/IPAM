import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { api, getApiVrf } from '../api'
import { Drawer, Icon } from '../components/ui'
import {
  PREFIX_KIND_LABEL, type Prefix, type PrefixImpact, type PrefixPreflight,
  type PrefixWritePayload, type Vrf,
} from '../types'

export interface EditorState {
  mode: 'edit' | 'create'
  cidr?: string
  parent?: string
  /** create 模式下预选层级；kind=root 表示新建一个与其他根空间平级的顶级地址空间 */
  kind?: Prefix['kind']
  focusDelete?: boolean
}

interface FormState {
  cidr: string
  name: string
  parent_cidr: string
  kind: Prefix['kind']
  site: string
  vlan: string
  vrf: string
  description: string
  cascade: boolean
}

function ipInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc * 256 + Number(part)) >>> 0, 0)
}

/** 判断 child 是否严格落在 parent 内（用于过滤「不能把节点挂到自己后代下」的选项）。 */
function cidrContains(parent: string, child: string): boolean {
  const [pb, pl] = parent.split('/')
  const [cb, cl] = child.split('/')
  const plen = Number(pl), clen = Number(cl)
  if (!Number.isFinite(plen) || !Number.isFinite(clen) || plen >= clen) return false
  const unit = 2 ** (32 - plen)
  return Math.floor(ipInt(pb) / unit) === Math.floor(ipInt(cb) / unit)
}

function initialForm(state: EditorState, target: Prefix | null, parent: Prefix | null): FormState {
  if (state.mode === 'edit' && target) {
    return {
      cidr: target.cidr, name: target.name, parent_cidr: target.parent_cidr ?? '',
      kind: target.kind,
      site: target.site ?? '', vlan: target.vlan == null ? '' : String(target.vlan),
      vrf: target.vrf, description: target.description ?? '', cascade: false,
    }
  }
  const kind = state.kind ?? 'subnet'
  // 新建前缀归属顶栏当前地址平面；父前缀只用于继承站点等属性，不继承平面
  const plane = getApiVrf()
  return {
    cidr: '', name: '',
    parent_cidr: kind === 'root' ? '' : (state.parent ?? parent?.cidr ?? ''),
    kind, site: parent?.site ?? '', vlan: '',
    vrf: plane === 'all' ? 'default' : plane,
    description: '', cascade: false,
  }
}

export default function PrefixEditor({ state, prefixes, vrfs, onClose, onSaved, onDeleted, notify }: {
  state: EditorState
  prefixes: Prefix[]
  vrfs: Vrf[]
  onClose: () => void
  onSaved: (result: { cidr: string; previous?: string; changes?: string[] }) => void
  onDeleted: (cidr: string) => void
  notify: (msg: string, kind?: 'ok' | 'error') => void
}) {
  const isEdit = state.mode === 'edit'
  const target = isEdit ? prefixes.find(p => p.cidr === state.cidr) ?? null : null
  const root = prefixes.find(p => p.kind === 'root') ?? null
  const parent = prefixes.find(p => p.cidr === (state.parent ?? root?.cidr)) ?? null
  const defaultParent = state.parent ?? root?.cidr ?? ''

  const [form, setForm] = useState<FormState>(() => initialForm(state, target, parent))
  const [pf, setPf] = useState<PrefixPreflight | null>(null)
  const [checking, setChecking] = useState(false)
  const [impact, setImpact] = useState<PrefixImpact | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm(f => ({ ...f, [key]: value }))

  const parentOptions = useMemo(() => prefixes.filter(p => {
    if (p.kind === 'subnet' || p.cidr === target?.cidr) return false
    return !(target && cidrContains(target.cidr, p.cidr))
  }), [prefixes, target])

  const vrfOptions = useMemo(() => {
    const names = vrfs.map(v => v.name)
    if (!names.includes(form.vrf) && form.vrf) names.push(form.vrf)
    return names.length ? names : ['default']
  }, [vrfs, form.vrf])

  // CIDR / 父前缀 / 层级变化时实时预检，与后端写操作共用同一套规则
  useEffect(() => {
    if (!form.cidr.trim()) { setPf(null); return }
    let alive = true
    setChecking(true)
    const timer = window.setTimeout(() => {
      api.preflightPrefix({
        cidr: form.cidr.trim(),
        current: isEdit ? target?.cidr : undefined,
        parent: form.parent_cidr || undefined,
        kind: isEdit ? target?.kind : form.kind,
        vrf: form.vrf,
      })
        .then(res => { if (alive) setPf(res) })
        .catch(err => {
          if (alive) notify(err instanceof Error ? err.message : '预检失败', 'error')
        })
        .finally(() => { if (alive) setChecking(false) })
    }, 320)
    return () => { alive = false; window.clearTimeout(timer) }
  }, [form.cidr, form.parent_cidr, form.kind, form.vrf, isEdit, target, notify])

  // 删除影响面：多根空间下根空间也可删除，是否允许由后端 impact 统一判定
  useEffect(() => {
    if (!isEdit || !target) return
    let alive = true
    api.prefixImpact(target.cidr, form.vrf)
      .then(res => { if (alive) setImpact(res) })
      .catch(err => { if (alive) notify(err instanceof Error ? err.message : '影响面查询失败', 'error') })
    return () => { alive = false }
  }, [isEdit, target, form.vrf, notify])

  useEffect(() => {
    if (state.focusDelete) {
      window.setTimeout(() => document.getElementById('prefix-danger-zone')?.scrollIntoView({ block: 'nearest' }), 120)
    }
  }, [state.focusDelete])

  function buildPayload(): PrefixWritePayload | null {
    const vlanText = form.vlan.trim()
    if (vlanText && !/^\d+$/.test(vlanText)) {
      notify('VLAN 必须是 1–4094 的整数', 'error')
      return null
    }
    if (!form.name.trim()) {
      notify('名称不能为空', 'error')
      return null
    }
    const payload: PrefixWritePayload = {
      cidr: form.cidr.trim(),
      name: form.name.trim(),
      site: form.site.trim(),
      vlan: vlanText ? Number(vlanText) : null,
      vrf: form.vrf,
      description: form.description.trim(),
      parent_cidr: form.kind === 'root' ? null : (form.parent_cidr || null),
    }
    if (isEdit) payload.cascade_children = form.cascade
    else payload.kind = form.kind
    return payload
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    if (busy || !pf?.can_apply || (isEdit && !target)) return
    const payload = buildPayload()
    if (!payload) return
    setBusy(true)
    try {
      const res = isEdit
        ? await api.updatePrefix(target!.cidr, payload)
        : await api.createPrefix(payload)
      notify(`${isEdit ? '已保存' : '已新建'} ${res.cidr}${res.changes?.length ? ` · ${res.changes.length} 项变更` : ''}`)
      onSaved({ cidr: res.cidr, previous: isEdit ? target!.cidr : undefined, changes: res.changes })
    } catch (err) {
      notify(err instanceof Error ? err.message : '保存失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  async function doDelete() {
    if (!target) return
    setBusy(true)
    try {
      await api.deletePrefix(target.cidr)
      notify(`已删除前缀 ${target.cidr}`)
      onDeleted(target.cidr)
    } catch (err) {
      notify(err instanceof Error ? err.message : '删除失败', 'error')
    } finally {
      setBusy(false)
      setConfirmDelete(false)
    }
  }

  const title = isEdit ? `编辑前缀 · ${target?.cidr ?? state.cidr ?? ''}`
    : state.kind === 'root' ? '新建顶级根空间' : '新建前缀'
  const canSave = !!pf?.can_apply && !!form.name.trim() && !checking && !busy && (isEdit ? !!target : true)

  return (
    <Drawer open title={title}
      sub="CIDR / 层级变更由 03 层统一校验，写操作留痕审计日志"
      onClose={onClose}>
      <form onSubmit={save}>
        <div className="form-grid">
          <div className="field">
            <label>CIDR <span className="muted">· 编辑时改网段将同步更新全部引用</span></label>
            <input className="mono" value={form.cidr} onChange={e => set('cidr', e.target.value)}
              placeholder="例如 10.9.9.0/24" disabled={busy} />
            <div className="help">需使用网络地址，掩码 /8 – /30；顶级根空间之间不得重叠。</div>
          </div>
          <div className="field">
            <label>名称</label>
            <input value={form.name} onChange={e => set('name', e.target.value)}
              placeholder="例如 核心业务" disabled={busy} />
          </div>
          <div className="field">
            <label>父前缀</label>
            {target?.kind === 'root' || form.kind === 'root' ? (
              <><input value="顶级根空间（无父前缀）" disabled />
                <div className="help">根空间是地址空间树入口，与其他根空间平级；容量按已划入子网汇总。</div></>
            ) : (
              <select value={form.parent_cidr} onChange={e => set('parent_cidr', e.target.value)} disabled={busy}>
                {parentOptions.map(p => (
                  <option key={p.cidr} value={p.cidr}>{p.cidr} · {p.name}</option>
                ))}
              </select>
            )}
          </div>
          <div className="field">
            <label>层级</label>
            {isEdit ? (
              <><input value={target ? PREFIX_KIND_LABEL[target.kind] : '—'} disabled />
                <div className="help">层级由地址空间树结构决定，不可直接修改。</div></>
            ) : (
              <select value={form.kind} onChange={e => {
                const kind = e.target.value as FormState['kind']
                setForm(f => ({ ...f, kind, parent_cidr: kind === 'root' ? '' : (f.parent_cidr || defaultParent) }))
              }} disabled={busy}>
                <option value="subnet">可分配子网</option>
                <option value="aggregate">汇聚前缀（可再下挂子网）</option>
                <option value="root">根空间（顶级地址空间）</option>
              </select>
            )}
          </div>
          <div className="field"><label>站点</label>
            <input value={form.site} onChange={e => set('site', e.target.value)} placeholder="例如 华东生产" disabled={busy} />
          </div>
          <div className="field"><label>VLAN <span className="muted">· 1–4094，留空为未分配</span></label>
            <input value={form.vlan} onChange={e => set('vlan', e.target.value)} placeholder="例如 101" disabled={busy} />
          </div>
          <div className="field"><label>所属 VRF 地址平面</label>
            <select value={form.vrf} onChange={e => set('vrf', e.target.value)} disabled={busy}>
              {vrfOptions.map(v => <option key={v} value={v}>{v}</option>)}
            </select>
            <div className="help">
              唯一键为 (VRF, CIDR)：同一网段可跨平面重复登记，重叠校验只在本平面内进行。
              新建默认归属顶栏当前平面；编辑根空间时切换平面会连同整棵子树及引用一起迁移。
            </div>
          </div>
          <div className="field"><label>最后更新</label>
            <input value={target?.updated_at ?? '新建后自动生成'} disabled />
          </div>
          <div className="field full"><label>备注</label>
            <textarea value={form.description} onChange={e => set('description', e.target.value)}
              rows={2} placeholder="用途、负责人、变更说明等" disabled={busy} />
          </div>
        </div>

        {isEdit && target && target.child_count > 0 && (
          <label className="check-line">
            <input type="checkbox" checked={form.cascade} onChange={e => set('cascade', e.target.checked)} />
            将站点 / VLAN / 地址平面同步到全部 {target.child_count} 个后代前缀
          </label>
        )}

        <div className={`pf-box${pf ? (pf.can_apply ? ' ok' : ' bad') : ''}`}>
          <div className="inline">
            <Icon name={checking ? 'clock' : pf?.can_apply ? 'check' : 'alert'} size={14} />
            <b>{checking ? '正在校验 CIDR…' : !form.cidr.trim() ? '请填写 CIDR'
              : pf?.can_apply ? '校验通过，可保存' : '校验未通过，无法保存'}</b>
          </div>
          {pf?.info && (
            <div className="info-grid" style={{ marginTop: 10 }}>
              <div><span>掩码</span><b>{pf.info.mask}</b></div>
              <div><span>网络地址</span><b>{pf.info.network}</b></div>
              <div><span>广播地址</span><b>{pf.info.broadcast}</b></div>
              <div><span>可分配</span><b>{pf.info.usable} 个</b></div>
            </div>
          )}
          {pf?.issues.map((t, i) => <div className="pf-line bad" key={`i${i}`}><Icon name="alert" size={12} />{t}</div>)}
          {pf?.warnings.map((t, i) => <div className="pf-line warn" key={`w${i}`}><Icon name="info" size={12} />{t}</div>)}
          {pf?.can_apply && !pf.warnings.length && (
            <div className="pf-line ok">无重叠、父子包含关系正常，子前缀与已登记地址均在新网段内。</div>
          )}
        </div>

        <div className="drawer-actions">
          <button className="btn" type="button" onClick={onClose}>取消</button>
          <button className="btn primary" type="submit" disabled={!canSave}>
            <Icon name={isEdit ? 'check' : 'plus'} />{busy ? '保存中…' : isEdit ? '保存修改' : '创建前缀'}
          </button>
        </div>
      </form>

      {isEdit && target && (target.kind !== 'root' || impact?.can_delete) && (
        <div className="danger-zone" id="prefix-danger-zone">
          <h3>删除此前缀</h3>
          {impact ? (
            <>
              <div className="small muted" style={{ lineHeight: 1.8 }}>
                影响面：{impact.children} 个子前缀 · {impact.ips} 条已登记地址 ·{' '}
                {impact.open_diffs} 条待处理差异 · {impact.pending_tickets} 条待审批工单。
                {impact.reasons.length > 0 && <div>{impact.reasons.join('；')}。</div>}
                {impact.can_delete && <div>该前缀为无引用的叶子节点，可安全删除。</div>}
              </div>
              {!confirmDelete ? (
                <button className="btn sm danger-btn" style={{ marginTop: 10 }}
                  disabled={!impact.can_delete || busy} onClick={() => setConfirmDelete(true)}>
                  <Icon name="trash" size={12} />删除此前缀
                </button>
              ) : (
                <div className="inline" style={{ marginTop: 10 }}>
                  <span className="small" style={{ color: 'var(--red)' }}>确认删除 {target.cidr}？不可撤销</span>
                  <button className="btn sm" onClick={() => setConfirmDelete(false)}>取消</button>
                  <button className="btn sm danger-btn" disabled={busy} onClick={doDelete}>
                    {busy ? '删除中…' : '确认删除'}
                  </button>
                </div>
              )}
            </>
          ) : <div className="small muted">正在评估影响面…</div>}
        </div>
      )}
    </Drawer>
  )
}
