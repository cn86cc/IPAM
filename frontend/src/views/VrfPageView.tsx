import { useEffect, useState, type FormEvent } from 'react'
import { api } from '../api'
import { useAuth } from '../auth'
import { Card, Drawer, Icon, MiniStat, Tag } from '../components/ui'
import type { CustomBlock, CustomPage, PageTone, Vrf, VrfPayload } from '../types'
import { shortTime, useLoad, type ViewProps } from './shared'

const TONES: { key: PageTone; label: string }[] = [
  { key: 'blue', label: '蓝 · 原则' },
  { key: 'teal', label: '青 · 约定' },
  { key: 'amber', label: '橙 · 提醒' },
  { key: 'neutral', label: '灰 · 通用' },
]

interface EditorState { mode: 'create' | 'edit'; name?: string }

function clonePage(page: CustomPage): CustomPage {
  return { ...page, blocks: page.blocks.map(b => ({ ...b })) }
}

function newBlock(): CustomBlock {
  return {
    id: `block-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title: '新内容块', body: '', tone: 'neutral',
  }
}

/** VRF 地址平面页：页头文案 / 内容块 / 平面条目均可编辑，内容持久化到后端。 */
export default function VrfPageView({ notify, onChanged, refreshKey, onOpenPrefix }: ViewProps & {
  onOpenPrefix: (cidr: string, vrf?: string) => void
}) {
  const { user, vrf: currentPlane, setVrf } = useAuth()
  const { data, loading, reload } = useLoad(
    () => Promise.all([api.page('vrf'), api.vrfs(), api.settings(), api.vrfOverlap()]),
    [refreshKey], notify,
  )
  const [pageData, vrfData, settings, overlap] = data ?? [null, null, null, null]
  const vrfs: Vrf[] = vrfData?.items ?? []
  const defaultVrf = settings?.thresholds.default_vrf ?? 'all'
  const totalPrefixes = vrfs.reduce((n, v) => n + v.prefix_count, 0)
  const totalDevices = vrfs.reduce((n, v) => n + (v.device_count ?? 0), 0)
  const totalIps = vrfs.reduce((n, v) => n + (v.ip_count ?? 0), 0)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<CustomPage | null>(null)
  const [saving, setSaving] = useState(false)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [form, setForm] = useState<VrfPayload>({ name: '', tenant: '', description: '' })
  // 阈值用独立文本 state：留空表示沿用系统全局阈值（提交 null）
  const [warnText, setWarnText] = useState('')
  const [critText, setCritText] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [migrateTo, setMigrateTo] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (pageData && !editing) setDraft(clonePage(pageData))
  }, [pageData, editing])

  if (!pageData || !draft) {
    return <div className="card"><div className="loading">正在加载自定义页面…</div></div>
  }

  const shown = editing ? draft : pageData

  const startEdit = () => { setDraft(clonePage(pageData)); setEditing(true) }
  const cancelEdit = () => { setEditing(false); setDraft(clonePage(pageData)) }

  const patchBlock = (id: string, patch: Partial<CustomBlock>) =>
    setDraft(d => d ? { ...d, blocks: d.blocks.map(b => b.id === id ? { ...b, ...patch } : b) } : d)

  const addBlock = () => setDraft(d => d ? { ...d, blocks: [...d.blocks, newBlock()] } : d)
  const removeBlock = (id: string) =>
    setDraft(d => d ? { ...d, blocks: d.blocks.filter(b => b.id !== id) } : d)

  const moveBlock = (index: number, delta: number) => setDraft(d => {
    if (!d) return d
    const target = index + delta
    if (target < 0 || target >= d.blocks.length) return d
    const blocks = [...d.blocks]
    const tmp = blocks[index]
    blocks[index] = blocks[target]
    blocks[target] = tmp
    return { ...d, blocks }
  })

  async function savePage(e: FormEvent) {
    e.preventDefault()
    const current = draft
    if (!current || saving) return
    if (!current.title.trim()) { notify('页面标题不能为空', 'error'); return }
    if (current.blocks.some(b => !b.title.trim() && !b.body.trim())) {
      notify('内容块标题与正文不能同时为空', 'error'); return
    }
    setSaving(true)
    try {
      const res = await api.savePage('vrf', {
        title: current.title.trim(),
        subtitle: current.subtitle.trim(),
        blocks: current.blocks.map(b => ({
          ...b, title: b.title.trim(), body: b.body.trim(),
        })),
        updated_by: user?.username || '—',
      })
      notify(`页面内容已保存 · ${res.blocks.length} 个内容块`)
      setEditing(false)
      setDraft(clonePage(res))
      reload(); onChanged()
    } catch (err) {
      notify(err instanceof Error ? err.message : '保存失败', 'error')
    } finally { setSaving(false) }
  }

  function openEditor(state: EditorState) {
    const v = state.mode === 'edit' ? vrfs.find(x => x.name === state.name) : null
    setForm(v
      ? { name: v.name, tenant: v.tenant, description: v.description }
      : { name: '', tenant: '', description: '' })
    setWarnText(v?.warn_threshold == null ? '' : String(v.warn_threshold))
    setCritText(v?.crit_threshold == null ? '' : String(v.crit_threshold))
    setEditor(state)
  }

  async function submitVrf(e: FormEvent) {
    e.preventDefault()
    if (busy || !editor) return
    const name = form.name.trim()
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      notify('VRF 名称只能包含字母、数字、- 或 _', 'error'); return
    }
    const toThreshold = (text: string): number | null => {
      if (!text.trim()) return null   // 留空 = 沿用系统全局阈值
      const n = Number(text)
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        notify('容量阈值需为 0–100 的数字，或留空沿用全局设置', 'error')
        return NaN
      }
      return n
    }
    const warn = toThreshold(warnText), crit = toThreshold(critText)
    if (Number.isNaN(warn) || Number.isNaN(crit)) return
    if (warn !== null && crit !== null && warn >= crit) {
      notify('预警阈值必须小于告警阈值', 'error'); return
    }
    setBusy(true)
    try {
      const payload: VrfPayload = {
        name, tenant: form.tenant.trim() || '未指定', description: form.description.trim(),
        warn_threshold: warn, crit_threshold: crit,
      }
      const res = editor.mode === 'edit'
        ? await api.updateVrf(editor.name!, payload)
        : await api.createVrf(payload)
      notify(`${editor.mode === 'edit' ? '已保存' : '已新建'} VRF 地址平面 ${res.name}` +
        (res.changes?.length ? ` · ${res.changes.length} 项变更` : '') +
        (res.synced_prefixes ? ` · 迁移 ${res.synced_prefixes} 个前缀 / ${res.synced_ips ?? 0} 个 IP` : ''))
      setEditor(null)
      reload(); onChanged()
    } catch (err) {
      notify(err instanceof Error ? err.message : '保存失败', 'error')
    } finally { setBusy(false) }
  }

  async function doDelete(name: string, target?: string) {
    setBusy(true)
    try {
      const res = await api.deleteVrf(name, target)
      const moved = res.moved
        ? Object.values(res.moved).reduce((a, b) => a + b, 0) : 0
      notify(res.migrated_to
        ? `已把 ${moved} 条数据迁移到 ${res.migrated_to}，并删除地址平面 ${name}`
        : `已删除 VRF 地址平面 ${name}`)
      setDeleteTarget(null)
      setMigrateTo('')
      reload(); onChanged()
    } catch (err) {
      notify(err instanceof Error ? err.message : '删除失败', 'error')
    } finally { setBusy(false) }
  }

  return (
    <>
      <div className="custom-hero">
        {editing ? (
          <form onSubmit={savePage}>
            <div className="field">
              <label>页面标题</label>
              <input value={draft.title} onChange={e => setDraft(d => d ? { ...d, title: e.target.value } : d)}
                placeholder="例如 VRF 地址平面" disabled={saving} />
            </div>
            <div className="field">
              <label>页面说明</label>
              <textarea rows={2} value={draft.subtitle}
                onChange={e => setDraft(d => d ? { ...d, subtitle: e.target.value } : d)}
                placeholder="用一两句话说明本页用途" disabled={saving} />
            </div>
            <div className="custom-hero-foot">
              <span className="hint">编辑模式 · 内容块可增删、排序与配色</span>
              <div className="inline">
                <button className="btn sm" type="button" onClick={cancelEdit} disabled={saving}>取消</button>
                <button className="btn sm primary" type="submit" disabled={saving || !draft.title.trim()}>
                  <Icon name="check" size={12} />{saving ? '保存中…' : '保存页面'}
                </button>
              </div>
            </div>
          </form>
        ) : (
          <>
            <h1>{shown.title}</h1>
            <p>{shown.subtitle}</p>
            <div className="custom-hero-foot">
              <span className="hint">
                {shown.updated_at
                  ? `自定义内容 · 最近保存 ${shortTime(shown.updated_at)}（${shown.updated_by ?? '—'}）`
                  : '自定义内容 · 当前为默认模板，可直接编辑'}
              </span>
              <button className="btn sm primary" onClick={startEdit} disabled={loading}>
                <Icon name="edit" size={12} />编辑页面内容
              </button>
            </div>
          </>
        )}
      </div>

      <div className="vrf-notice" id="vrf-position-notice">
        <Icon name="info" size={14} />
        <div>
          <b>定位说明（系统实现口径）</b>
          <p>每个 VRF 在本系统是一张<b>独立地址平面</b>：唯一键是 (VRF, CIDR) 与 (VRF, IP)，
            同一 CIDR / IP 可以在不同平面重复登记而互不冲突；前缀重叠校验、容量统计、分配 / 回收、
            审计与趋势均限定在各自平面内。用户可见范围支持「VRF:CIDR」按平面授权。
            顶栏「当前地址平面」决定所有读写操作的落点，「全部 VRF」为只读跨平面对比视图。
            安装完成后默认进入「全部 VRF · 跨平面对比」，需先在顶栏选定具体平面再执行写入。</p>
        </div>
      </div>

      <div className="stat-row">
        <MiniStat label="VRF 地址平面" value={vrfs.length} foot="每张平面独立编址" tone="blue" />
        <MiniStat label="平面内前缀" value={totalPrefixes} foot="CIDR 可跨平面复用" tone="teal" />
        <MiniStat label="关联设备" value={totalDevices} foot={`已登记 IP ${totalIps} 个`} />
        <MiniStat label="当前平面" value={currentPlane === 'all' ? '全部（对比）' : currentPlane}
          foot={defaultVrf === 'all' ? '默认 全部 VRF · 跨平面对比' : `默认 ${defaultVrf}`} />
      </div>

      <div className="block-grid">
        {shown.blocks.length === 0 && (
          <Card title="暂无自定义内容">
            <div className="empty">点击「编辑页面内容」，添加说明、规范或提醒内容块</div>
          </Card>
        )}
        {shown.blocks.map((b, i) => (
          <Card key={b.id} className={`page-block tone-${b.tone}`}
            title={editing ? undefined : b.title}
            hint={editing ? undefined : TONES.find(t => t.key === b.tone)?.label}>
            {editing ? (
              <div className="block-edit">
                <div className="block-edit-head">
                  <b>内容块 {i + 1}</b>
                  <div className="inline">
                    <button className="blk-mini" title="上移" disabled={i === 0}
                      onClick={() => moveBlock(i, -1)}>↑</button>
                    <button className="blk-mini" title="下移" disabled={i === shown.blocks.length - 1}
                      onClick={() => moveBlock(i, 1)}>↓</button>
                    <button className="blk-mini danger" title="删除此块"
                      onClick={() => removeBlock(b.id)}><Icon name="trash" size={12} /></button>
                  </div>
                </div>
                <div className="field"><label>块标题</label>
                  <input value={b.title} onChange={e => patchBlock(b.id, { title: e.target.value })}
                    placeholder="例如 平面划分原则" />
                </div>
                <div className="field"><label>正文 <span className="muted">· 支持换行</span></label>
                  <textarea rows={4} value={b.body}
                    onChange={e => patchBlock(b.id, { body: e.target.value })}
                    placeholder="输入自定义内容，可换行分段" />
                </div>
                <div className="field"><label>强调色</label>
                  <select value={b.tone} onChange={e => patchBlock(b.id, { tone: e.target.value as PageTone })}>
                    {TONES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
                  </select>
                </div>
              </div>
            ) : (
              <div className="block-body">{b.body || '—'}</div>
            )}
          </Card>
        ))}
        {editing && (
          <button className="page-block-add" onClick={addBlock} disabled={saving || shown.blocks.length >= 12}>
            <Icon name="plus" />添加内容块（最多 12 个）
          </button>
        )}
      </div>

      <Card title="VRF 地址平面清单"
        hint={`每行为一张独立地址平面 · 点击 CIDR 定位到该平面 · ${shown.blocks.length} 个自定义内容块`} extra={
        <button className="btn sm primary" onClick={() => openEditor({ mode: 'create' })}>
          <Icon name="plus" size={12} />新建地址平面
        </button>
      }>
        {vrfs.length === 0 ? <div className="empty">暂无 VRF 地址平面</div> : (
          <div className="vrf-grid">
            {vrfs.map(v => (
              <div className={`vrf-card${v.is_default ? ' default' : ''}`} key={v.name}>
                <div className="vrf-head">
                  <b className="vrf-name mono">{v.name}</b>
                  <div className="inline">
                    {v.is_default && (
                      <Tag text={defaultVrf === 'all' ? '内置' : '默认'} tone="blue" />
                    )}
                    {currentPlane === v.name && <Tag text="当前" tone="teal" />}
                    <button className="icon-btn sm" title="切换到此地址平面"
                      disabled={currentPlane === v.name}
                      onClick={() => { setVrf(v.name); notify(`当前地址平面已切换为 ${v.name}`) }}>
                      <Icon name="swap" size={12} />
                    </button>
                    <button className="icon-btn sm" title="编辑此地址平面"
                      onClick={() => openEditor({ mode: 'edit', name: v.name })}>
                      <Icon name="edit" size={12} />
                    </button>
                    <button className="icon-btn sm"
                      title={v.is_default
                        ? (defaultVrf === 'all' ? '内置主平面不可删除' : '默认地址平面不可删除')
                        : v.reference_count > 0 ? '平面内仍有数据，删除时可选择整体迁移到其它平面'
                          : '删除此地址平面'}
                      disabled={v.is_default}
                      onClick={() => { setDeleteTarget(v.name); setMigrateTo('') }}>
                      <Icon name="trash" size={12} />
                    </button>
                  </div>
                </div>
                <div className="vrf-meta"><Tag text={v.tenant} tone="teal" /> {v.description || '无说明'}</div>
                <div className="vrf-meta">
                  {v.prefix_count} 个前缀（{v.subnet_count} 子网 / {v.root_count} 根空间） ·
                  {' '}{v.device_count ?? 0} 台设备 · {v.ip_count ?? 0} 个已登记 IP
                </div>
                <div className="vrf-meta">
                  容量 {v.total.toLocaleString()} · 占用 {v.occupied.toLocaleString()} ·
                  可用 {v.free.toLocaleString()} · 利用率 {v.util}% · 创建于 {shortTime(v.created_at)}
                </div>
                <div className="vrf-meta">
                  容量阈值 预警 {v.effective_warn}% / 告警 {v.effective_crit}%
                  {v.warn_threshold == null && v.crit_threshold == null ? '（沿用全局设置）' : '（本平面自定义）'}
                </div>
                <div className="vrf-prefixes">
                  {v.prefixes.slice(0, 6).map(c => (
                    <button className="vrf-prefix mono" key={c}
                      title={`${v.prefix_names[c] ?? c} · 切到平面 ${v.name} 并在地址空间树中定位`}
                      onClick={() => onOpenPrefix(c, v.name)}>{c}</button>
                  ))}
                  {v.prefixes.length > 6 && <span className="vrf-more">+{v.prefixes.length - 6}</span>}
                  {v.prefixes.length === 0 && <span className="vrf-more">尚未关联前缀</span>}
                </div>
                <div className="vrf-prefixes">
                  {(v.devices ?? []).slice(0, 4).map(id => (
                    <span className="vrf-prefix mono vrf-device" key={id}
                      title={v.device_names?.[id] ?? id}>{id}</span>
                  ))}
                  {(v.devices ?? []).length > 4 && (
                    <span className="vrf-more">+{(v.devices ?? []).length - 4} 台设备</span>
                  )}
                  {(v.devices ?? []).length === 0 && <span className="vrf-more">尚未关联设备</span>}
                </div>
                {deleteTarget === v.name && (
                  <div className="vrf-confirm">
                    <div style={{ flex: '1 1 260px', lineHeight: 1.8 }}>
                      {v.reference_count > 0 ? (
                        <>
                          <span>平面 <b className="mono">{v.name}</b> 仍有 {v.reference_count} 条引用。
                            删除前请选择目标平面，全部数据会整体迁移过去；若目标平面已有相同 CIDR / IP，
                            后端会拒绝迁移以保证数据不丢失。</span>
                          <select value={migrateTo} onChange={e => setMigrateTo(e.target.value)}
                            aria-label="迁移目标地址平面" style={{ marginTop: 6, width: '100%' }}>
                            <option value="">选择迁移目标平面…</option>
                            {vrfs.filter(x => x.name !== v.name).map(x => (
                              <option key={x.name} value={x.name}>{x.name}</option>
                            ))}
                          </select>
                        </>
                      ) : (
                        <span>确认删除空地址平面 {v.name}？不可撤销</span>
                      )}
                    </div>
                    <div className="inline">
                      <button className="btn sm"
                        onClick={() => { setDeleteTarget(null); setMigrateTo('') }}>取消</button>
                      <button className="btn sm danger-btn"
                        disabled={busy || (v.reference_count > 0 && !migrateTo)}
                        onClick={() => doDelete(v.name, migrateTo || undefined)}>
                        {v.reference_count > 0 && migrateTo ? `迁移并删除` : '确认删除'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="跨平面地址复用" className="vrf-overlap-card"
        hint="同一 CIDR / IP 在多个地址平面重复登记 · 真隔离下合法且被预期">
        <div className="stat-row">
          <MiniStat label="重复前缀" value={overlap?.prefix_count ?? 0} foot="CIDR 出现在多个平面" tone="blue" />
          <MiniStat label="重复地址" value={overlap?.ip_count ?? 0} foot="IP 出现在多个平面" tone="teal" />
          <MiniStat label="参与平面" value={overlap?.planes.length ?? 0} foot="地址平面总数" />
          <MiniStat label="视角" value="跨平面" foot="不受当前平面切换影响" />
        </div>
        {!overlap || (overlap.prefix_count === 0 && overlap.ip_count === 0) ? (
          <div className="empty">目前没有跨平面重复登记的 CIDR 或 IP；可在两个平面各建同一网段来验证隔离</div>
        ) : (
          <div className="grid-2">
            <div>
              <b>重复前缀（{overlap.prefix_count}）</b>
              {overlap.prefix_overlap.slice(0, 12).map(o => (
                <div className="vrf-meta mono" key={o.cidr}>
                  {o.cidr} · {o.plane_count} 个平面 · {o.vrfs}
                </div>
              ))}
              {overlap.prefix_count > 12 && <div className="vrf-more">+{overlap.prefix_count - 12} 个</div>}
            </div>
            <div>
              <b>重复地址（{overlap.ip_count}）</b>
              {overlap.ip_overlap.slice(0, 12).map(o => (
                <div className="vrf-meta mono" key={o.addr}>
                  {o.addr} · {o.plane_count} 个平面 · {o.vrfs}
                </div>
              ))}
              {overlap.ip_count > 12 && <div className="vrf-more">+{overlap.ip_count - 12} 个</div>}
            </div>
          </div>
        )}
        <p className="footnote" style={{ marginTop: 10 }}>
          复用是 VRF 真隔离的核心能力：同一网段在不同平面各自独立编址、互不冲突。
          这份清单用于审计与排查「误以为全站唯一」的规划，不视为错误数据。
        </p>
      </Card>

      <Card title="编辑与持久化说明" hint="05 数据与基础设施层">
        <p className="footnote" style={{ marginTop: 0, lineHeight: 1.9 }}>
          页面标题、说明与内容块保存在 <span className="mono">custom_pages</span> 表，按 <span className="mono">page_key</span> 隔离；
          每次保存写入审计日志与 Webhook 事件，保存人取当前登录账号。地址平面改名会在同一事务内同步
          <span className="mono">prefixes</span>、<span className="mono">ip_addresses</span>、
          <span className="mono">asset_devices</span>、发现 / 对账 / 工单 / 审计 / 快照等全部业务表的
          <span className="mono">vrf</span> 字段与默认 VRF 设置；默认 / 内置主平面不可删除，有数据的平面删除时
          可指定目标平面整体迁移（同 CIDR / IP 冲突时后端拒绝，避免覆盖）。每个平面还能单独设置
          容量预警 / 告警阈值，留空则沿用系统全局设置。<br />
          模型级隔离：<span className="mono">(vrf, cidr)</span> 与 <span className="mono">(vrf, addr)</span> 为复合唯一键，
          前缀重叠校验、容量统计、分配回收、报表、审计与趋势均按平面切分，
          利用率快照与 Webhook 告警也带平面归属；只读用户可按「VRF:CIDR」授权到指定平面，
          汇总视图下所有地址域写操作由后端统一拒绝。
        </p>
        <div className="chips">
          <span className="chip done">页面文案可编辑</span>
          <span className="chip done">内容块可增删排序</span>
          <span className="chip done">平面增删改</span>
          <span className="chip done">引用级联与保护</span>
          <span className="chip done">逐平面容量统计</span>
          <span className="chip done">同 CIDR 跨平面复用</span>
          <span className="chip done">按 VRF:CIDR 授权</span>
          <span className="chip done">平面数据迁移删除</span>
          <span className="chip done">VRF 级容量阈值</span>
          <span className="chip done">跨平面复用报告</span>
          <span className="chip done">审计留痕</span>
          <span className="chip">富文本 / 图片块</span>
        </div>
      </Card>

      {editor && (
        <Drawer open title={editor.mode === 'edit' ? `编辑地址平面 · ${editor.name}` : '新建地址平面'}
          sub="新建后可在顶栏切换进入该平面；改名会同步全部业务表的 vrf 字段" onClose={() => setEditor(null)}>
          <form onSubmit={submitVrf}>
            <div className="form-grid">
              <div className="field"><label>名称</label>
                <input className="mono" value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="vrf-finance" disabled={busy} />
                <div className="help">只能包含字母、数字、- 或 _；改名会同步前缀与设备归属。</div>
              </div>
              <div className="field"><label>租户</label>
                <input value={form.tenant} onChange={e => setForm(f => ({ ...f, tenant: e.target.value }))}
                  placeholder="例如 财务租户" disabled={busy} />
              </div>
              <div className="field full"><label>说明</label>
                <textarea rows={3} value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="用途、业务归属、负责人等（该平面内的地址空间彼此独立）" disabled={busy} />
              </div>
              <div className="field"><label>容量预警阈值 (%)</label>
                <input type="number" min={0} max={100} step={1} value={warnText}
                  onChange={e => setWarnText(e.target.value)}
                  placeholder={`留空沿用全局 ${settings?.thresholds.warn ?? 80}%`} disabled={busy} />
                <div className="help">留空表示使用系统全局设置；仅对该平面的看板预警生效。</div>
              </div>
              <div className="field"><label>容量告警阈值 (%)</label>
                <input type="number" min={0} max={100} step={1} value={critText}
                  onChange={e => setCritText(e.target.value)}
                  placeholder={`留空沿用全局 ${settings?.thresholds.crit ?? 90}%`} disabled={busy} />
                <div className="help">必须大于预警阈值（含与全局值混合后的结果），由后端校验。</div>
              </div>
            </div>
            <div className="drawer-actions">
              <button className="btn" type="button" onClick={() => setEditor(null)}>取消</button>
              <button className="btn primary" type="submit" disabled={busy || !form.name.trim()}>
                <Icon name={editor.mode === 'edit' ? 'check' : 'plus'} />
                {busy ? '保存中…' : editor.mode === 'edit' ? '保存修改' : '创建地址平面'}
              </button>
            </div>
          </form>
        </Drawer>
      )}
    </>
  )
}
