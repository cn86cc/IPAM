import { useEffect, useMemo, useState, type DragEvent, type FormEvent } from 'react'
import { api } from '../api'
import { useAuth } from '../auth'
import { Card, Icon, MiniStat, Tag } from '../components/ui'
import {
  ASSET_ID_PATTERN, ASSET_ROLE_LABEL, ASSET_STATUS_LABEL,
  type AssetData, type AssetKind, type AssetPayload, type AssetRow, type View,
} from '../types'
import { RACK_DETAIL_SCALE, RACK_MM, rackHeightMm, useLoad } from './shared'
import { CONFIG, initialForm, optionChoices } from './AssetView'

type RackMode = 'full' | 'occupied'

/** 右侧面板状态：查看（单击）与编辑（双击）严格分离，新增设备由双击空闲 U 位触发。 */
type PanelState =
  | { kind: 'none' }
  | { kind: 'view'; id: string }
  | { kind: 'edit'; id: string }
  | { kind: 'create'; u: number }

interface Props {
  rackId: string
  notify: (msg: string, kind?: 'ok' | 'error') => void
  onChanged: () => void
  onBack: () => void
  onNavigate: (v: View) => void
  onRenamed?: (kind: AssetKind, previousId: string, nextId: string) => void
  refreshKey: number
}

const text = (v: unknown) => (v === null || v === undefined ? '' : String(v))

function toneOf(status?: string): 'red' | 'amber' | 'teal' | 'blue' | 'neutral' {
  if (status === 'online' || status === 'active' || status === 'up') return 'teal'
  if (status === 'offline' || status === 'down') return 'red'
  if (status === 'maintenance' || status === 'planned' || status === 'retired') return 'amber'
  return 'blue'
}

/**
 * 机柜二级页面：由机柜清单点击行进入，hash 为 #racks/<机柜编号>。
 * 默认「完整机柜」模式保持上一版字号与自然行高，全部 U 位一次渲染；机柜内部不滚动，
 * 页面高度随 U 数自然增长。设备块可拖拽改位，单击仅选中查看、双击才进入编辑，
 * 双击空闲 U 位在右侧新增设备。
 */
export default function RackDetailView({
  rackId, notify, onChanged, onBack, onNavigate, onRenamed, refreshKey,
}: Props) {
  const { isAdmin, can } = useAuth()
  const [mode, setMode] = useState<RackMode>('full')
  const [panel, setPanel] = useState<PanelState>({ kind: 'none' })
  const [form, setForm] = useState<AssetPayload>({})
  const [newId, setNewId] = useState('')
  const [formError, setFormError] = useState('')
  const [busy, setBusy] = useState(false)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropU, setDropU] = useState<number | null>(null)
  const [moveHint, setMoveHint] = useState('')
  const [rackIdEditor, setRackIdEditor] = useState(false)
  const [rackIdDraft, setRackIdDraft] = useState('')
  const [rackIdError, setRackIdError] = useState('')
  const [rackIdBusy, setRackIdBusy] = useState(false)

  const { data, loading, reload } = useLoad(
    () => api.assetRackDetail(rackId), [rackId, refreshKey], notify,
  )
  const rack = data?.rack
  const devices = data?.devices ?? []
  const stats = data?.stats
  const units = stats?.units ?? rack?.units ?? 42

  const byU = useMemo(() => {
    const map = new Map<number, AssetRow>()
    devices.forEach(d => { if (d.rack_u) map.set(Number(d.rack_u), d) })
    return map
  }, [devices])

  const focusedId = panel.kind === 'view' || panel.kind === 'edit' ? panel.id : null
  const selected = focusedId ? devices.find(d => d.id === focusedId) ?? null : null
  const editing = panel.kind === 'edit' && !!selected
  const creating = panel.kind === 'create' ? panel.u : null

  // 数据刷新（保存 / 拖拽）后，把编辑表单同步到最新的设备行
  useEffect(() => {
    if (!data || panel.kind !== 'edit') return
    const row = data.devices.find(d => d.id === panel.id)
    setForm(row ? initialForm('devices', row) : {})
    setNewId(row?.id ?? '')
  }, [data, panel])

  // 新建设备编号建议：取当前 DEV-xxxx 最大序号 +1
  const nextId = useMemo(() => {
    const nums = (data?.options.devices ?? [])
      .map(o => /^DEV-(\d+)$/.exec(o.id))
      .filter((m): m is RegExpExecArray => !!m)
      .map(m => Number(m[1]))
    const n = nums.length ? Math.max(...nums) + 1 : 1
    return `DEV-${String(n).padStart(4, '0')}`
  }, [data])

  const assetLike: AssetData | null = data ? {
    kind: 'racks', label: '机柜',
    // 角色下拉直接取 options.roles；编辑历史设备时由当前表单值兜底
    items: devices, stats: {}, options: data.options,
  } : null

  const slots = useMemo(() => {
    const all = Array.from({ length: units }, (_, i) => units - i)
    return mode === 'full' ? all : all.filter(u => byU.has(u))
  }, [units, mode, byU])

  function clearPanel() {
    setPanel({ kind: 'none' })
    setForm({})
    setNewId('')
    setFormError('')
    setMoveHint('')
  }

  /** 单击：仅选中并展示只读详情，不进入可编辑状态。 */
  function focusDevice(row: AssetRow) {
    setPanel({ kind: 'view', id: row.id })
    setForm({})
    setFormError('')
    setMoveHint('')
  }

  /** 双击设备：进入可编辑状态。 */
  function editDevice(row: AssetRow) {
    setPanel({ kind: 'edit', id: row.id })
    setForm(initialForm('devices', row))
    setNewId(row.id)
    setFormError('')
    setMoveHint('')
  }

  /** 双击空闲 U 位：右侧切换到新增设备表单。 */
  function openCreate(u: number) {
    setPanel({ kind: 'create', u })
    setForm({
      ...initialForm('devices'),
      rack_id: rackId,
      rack_u: u,
      location_id: text(rack?.location_id),
    })
    setNewId(nextId)
    setFormError('')
    setMoveHint('')
  }

  async function moveTo(deviceId: string, target: number) {
    if (!isAdmin || busy) return
    setBusy(true)
    setMoveHint('')
    try {
      const res = await api.moveRackDevice(rackId, deviceId, target)
      if (res.action === 'swap') {
        notify(`已移至 U${target}，并与 ${res.swapped_with} 交换位置`)
      } else if (res.action === 'move') {
        notify(`已移至 U${target}`)
      } else {
        setMoveHint('位置未发生变化')
      }
      reload()
      onChanged()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '调整 U 位失败'
      setMoveHint(msg)
      notify(msg, 'error')
    } finally {
      setDragId(null)
      setDropU(null)
      setBusy(false)
    }
  }

  function handleDrop(u: number, e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    const id = dragId || e.dataTransfer.getData('text/plain')
    setDropU(null)
    setDragId(null)
    // 松开鼠标后默认取消选定，不保留任何编辑 / 新增面板
    clearPanel()
    if (id && isAdmin) void moveTo(id, u)
  }

  function openRackIdEditor() {
    setRackIdDraft(rackId)
    setRackIdError('')
    setRackIdEditor(true)
  }

  /** 二级页内再次编辑机柜编号：只提交 id，后端沿用其余字段并级联同步设备引用。 */
  async function saveRackId(e: FormEvent) {
    e.preventDefault()
    if (!isAdmin || rackIdBusy) return
    const next = rackIdDraft.trim()
    if (!ASSET_ID_PATTERN.test(next)) {
      setRackIdError('机柜编号必填，仅支持字母、数字、. _ -，长度 2–48')
      return
    }
    setRackIdBusy(true)
    setRackIdError('')
    try {
      const res = await api.updateAsset('racks', rackId, { id: next })
      if (res.id !== rackId) {
        onRenamed?.('racks', rackId, res.id)
        notify(`机柜编号已更新：${rackId} → ${res.id}`)
      } else {
        notify('机柜编号未变化')
      }
      setRackIdEditor(false)
      reload()
      onChanged()
    } catch (err) {
      setRackIdError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setRackIdBusy(false)
    }
  }

  async function saveDevice(e: FormEvent) {
    e.preventDefault()
    if (!selected || !editing || !isAdmin) return
    const id = newId.trim()
    if (!ASSET_ID_PATTERN.test(id)) {
      setFormError('设备编号必填，仅支持字母、数字、. _ -，长度 2–48')
      return
    }
    const targetU = Number(form.rack_u || 0)
    if (!Number.isInteger(targetU) || targetU < 1 || targetU > units) {
      setFormError(`U 位需在 1–${units} 之间`)
      return
    }
    setBusy(true)
    setFormError('')
    try {
      // 先按旧编号完成 U 位移动 / 交换，再提交字段与可能变化的新编号，
      // 避免改名后仍拿旧编号去调用移动接口。
      if (targetU !== Number(selected.rack_u || 0)) {
        await api.moveRackDevice(rackId, selected.id, targetU)
      }
      const rest: AssetPayload = { id, ...form, rack_id: rackId }
      delete rest.rack_u
      const res = await api.updateAsset('devices', selected.id, rest)
      const renamed = res.id !== selected.id
      if (renamed) {
        setPanel({ kind: 'edit', id: res.id })
        setNewId(res.id)
        onRenamed?.('devices', selected.id, res.id)
      }
      notify(`设备 ${String(form.name || selected.name)} 已更新${
        renamed ? `（编号 ${selected.id} → ${res.id}）` : ''}`)
      reload()
      onChanged()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  async function saveNewDevice(e: FormEvent) {
    e.preventDefault()
    if (!isAdmin || creating === null) return
    const id = newId.trim()
    if (!/^[A-Za-z0-9._-]{2,48}$/.test(id)) {
      setFormError('设备编号必填，仅支持字母、数字、. _ -，长度 2–48')
      return
    }
    const targetU = Number(form.rack_u || creating)
    if (!Number.isInteger(targetU) || targetU < 1 || targetU > units) {
      setFormError(`U 位需在 1–${units} 之间`)
      return
    }
    setBusy(true)
    setFormError('')
    try {
      await api.createAsset('devices', {
        id,
        ...form,
        rack_id: rackId,
        rack_u: targetU,
        location_id: form.location_id || text(rack?.location_id),
      })
      notify(`已在 U${targetU} 新增设备 ${id}`)
      clearPanel()
      reload()
      onChanged()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '新增设备失败')
    } finally {
      setBusy(false)
    }
  }

  const fields = CONFIG.devices.fields

  /** 编辑与新增共用一套字段渲染；rack_id 锁定当前机柜。 */
  function renderField(f: (typeof fields)[number], ctx: 'edit' | 'create') {
    const choices = optionChoices(assetLike, f,
      f.source === 'roles' ? text(form[f.key]) : '')
    const wide = f.full || f.type === 'textarea'
    const locked = !isAdmin || f.key === 'rack_id'
    const help = f.key === 'rack_id'
      ? (ctx === 'create'
          ? '新设备将直接上架到当前机柜；跨机柜请到「设备」清单编辑。'
          : '跨机柜迁移请到「设备」清单编辑。')
      : f.key === 'rack_u'
        ? (ctx === 'create'
            ? `已按双击的 U 位自动填入，可改为 1–${units} 内的空闲 U 位。`
            : `修改后保存即调整位置；若目标 U 位已被占用，将与该设备交换。范围 1–${units}。`)
        : f.help
    return (
      <div className={`field${wide ? ' full' : ''}`} key={f.key}>
        <label>{f.label}</label>
        {f.key === 'rack_id' ? (
          <select id={`rack-dev-${f.key}`} value={rackId} disabled>
            <option value={rackId}>{rack?.name ?? rackId}（当前机柜）</option>
          </select>
        ) : f.type === 'select' ? (
          <select id={`rack-dev-${f.key}`} value={text(form[f.key])}
            disabled={locked}
            onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}>
            <option value="">— 请选择 —</option>
            {choices.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        ) : f.type === 'textarea' ? (
          <textarea id={`rack-dev-${f.key}`} value={text(form[f.key])}
            disabled={locked}
            onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}
            placeholder={f.placeholder} />
        ) : (
          <input id={`rack-dev-${f.key}`}
            type={f.type === 'number' ? 'number' : 'text'}
            min={f.key === 'rack_u' ? 1 : undefined}
            max={f.key === 'rack_u' ? units : undefined}
            value={text(form[f.key])}
            disabled={locked}
            onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}
            placeholder={f.placeholder} />
        )}
        {help && <div className="help">{help}</div>}
        {f.key === 'role' && can('device_roles') && (
          <button type="button" className="role-manage-link" id={`rack-role-manage-${ctx}`}
            onClick={() => { clearPanel(); onNavigate('device_roles') }}>
            <Icon name="tag" size={12} />去管理角色
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="rack-detail" id="rack-detail">
      <div className="rack-detail-crumbs">
        <button className="btn sm ghost" id="rack-back" onClick={onBack}>
          <Icon name="undo" size={13} />返回机柜清单
        </button>
        <span className="rack-crumb-path">
          设备管理 <i>/</i> 机柜 <i>/</i> <b>{rack?.name ?? rackId}</b>
        </span>
        {data?.scope_limited && (
          <span className="asset-scope-note">
            按可见范围收敛：{data.visible_scopes?.join('、')}
          </span>
        )}
      </div>

      <div className="rack-detail-hero">
        <div className="rack-detail-title">
          <h2>{loading && !rack ? '正在加载机柜…' : (rack?.name ?? '机柜不存在')}</h2>
          <p className="muted">
            <span className="mono">{rackId}</span>
            {rack && <> · {rack.location_name} · {units} U · {rack.power_kw} kW</>}
            {rack?.status && (
              <> <Tag text={ASSET_STATUS_LABEL[rack.status] ?? rack.status} tone={toneOf(rack.status)} /></>
            )}
          </p>
        </div>
        <div className="rack-mode-switch" id="rack-mode-switch">
          <button className={mode === 'full' ? 'active' : ''} id="rack-mode-full"
            onClick={() => setMode('full')}>
            <Icon name="grid" size={13} />完整机柜
          </button>
          <button className={mode === 'occupied' ? 'active' : ''} id="rack-mode-occupied"
            onClick={() => setMode('occupied')}>
            <Icon name="layers" size={13} />仅已占用
          </button>
        </div>
      </div>

      <div className="stat-row">
        <MiniStat label="机柜容量" value={stats?.units ?? 0} foot="总 U 位数" tone="blue" />
        <MiniStat label="已占用 U 位" value={stats?.used ?? 0} foot="在架设备数" tone="teal" />
        <MiniStat label="空闲 U 位" value={stats?.free ?? 0} foot="可继续上架" tone="amber" />
        <MiniStat label="U 位利用率" value={stats?.util ?? 0} foot="已用 / 总容量（%）" />
      </div>

      <div className="rack-detail-grid">
        <Card className="rack-elev-card"
          title="机柜正视图"
          hint={`${mode === 'full' ? `完整机柜 · 共 ${units} U` : '仅已占用'} · U${units} → U1 · 固定物理比例`}>
          <div className="rack-detail-toolbar">
            <span className="muted">
              {isAdmin
                ? '拖动设备调整 U 位（目标占用时自动交换）；双击设备进入编辑，双击空闲 U 位新增设备。单击仅选中查看。'
                : '只读模式：单击可查看设备详情，不能拖动、编辑或新增。'}
            </span>
            <span className="rack-legend">
              <i className="dot online" />在线
              <i className="dot warn" />非在线
              <i className="dot free" />空闲
            </span>
          </div>
          {moveHint && <div className="check-note bad" id="rack-move-hint">{moveHint}</div>}
          {slots.length === 0
            ? <div className="empty">当前机柜还没有上架设备</div>
            : (
              <div className="rack-physical-scroll" id="rack-physical-scroll">
                <div className="rack-physical" id="rack-physical"
                  style={{ width: RACK_DETAIL_SCALE.outerPx }}>
                  {/* 尺寸标注：外壳 800mm，19 英寸安装有效宽度 482.6mm */}
                  <div className="rack-dim-row">
                    <div className="rack-dim rack-dim-outer"><span>外壳宽度 800 mm</span></div>
                  </div>
                  <div className="rack-dim-row">
                    <div className="rack-dim rack-dim-mount"
                      style={{ width: RACK_DETAIL_SCALE.mountPx }}>
                      <span>19″ / 482.6 mm 安装有效宽度</span>
                    </div>
                  </div>
                  <div className="rack-shell" id="rack-shell"
                    style={{ width: RACK_DETAIL_SCALE.outerPx,
                      height: slots.length * RACK_DETAIL_SCALE.uPx }}>
                    {/* 左侧立柱：U 位刻度（两侧立柱 + 中间 19″ 安装区 = 800mm 外壳） */}
                    <div className="rack-side rack-side-left">
                      <div className="rack-rail-scale"
                        style={{ gridTemplateRows: `repeat(${slots.length}, ${RACK_DETAIL_SCALE.uPx}px)` }}>
                        {slots.map(u => <span className="rack-u mono" key={u}>U{u}</span>)}
                      </div>
                    </div>
                    <div className={`rack-elev rack-elev-detail${mode === 'occupied' ? ' compact' : ''}`}
                      id="rack-detail-elev"
                      style={{ width: RACK_DETAIL_SCALE.mountPx,
                        gridTemplateRows: `repeat(${slots.length}, ${RACK_DETAIL_SCALE.uPx}px)` }}>
                      {slots.map(u => {
                        const occ = byU.get(u)
                        const isFocused = !!focusedId && occ?.id === focusedId
                        const isCreateTarget = creating === u
                        return (
                          <div key={u}
                            className={`rack-slot rack-slot-detail${occ ? ' used' : ''}${
                              occ && occ.status !== 'online' ? ' warn' : ''}${
                              dropU === u ? ' drop-target' : ''}${
                              isFocused ? ' selected' : ''}${
                              isCreateTarget ? ' create-target' : ''}`}
                            id={`rack-u-${u}`}
                            onDragOver={e => {
                              if (!isAdmin || !dragId) return
                              e.preventDefault()
                              e.dataTransfer.dropEffect = 'move'
                              if (dropU !== u) setDropU(u)
                            }}
                            onDragLeave={() => setDropU(v => v === u ? null : v)}
                            onDrop={e => handleDrop(u, e)}
                            onClick={() => { if (occ) focusDevice(occ); else clearPanel() }}
                            onDoubleClick={() => {
                              if (occ) {
                                if (isAdmin) editDevice(occ); else focusDevice(occ)
                              } else if (isAdmin) {
                                openCreate(u)
                              } else {
                                clearPanel()
                              }
                            }}>
                            {occ ? (
                              <div className={`rack-device${dragId === occ.id ? ' dragging' : ''}`}
                                draggable={isAdmin}
                                onDragStart={e => {
                                  if (!isAdmin) { e.preventDefault(); return }
                                  setDragId(occ.id)
                                  clearPanel()
                                  e.dataTransfer.effectAllowed = 'move'
                                  e.dataTransfer.setData('text/plain', occ.id)
                                }}
                                onDragEnd={() => {
                                  setDragId(null)
                                  setDropU(null)
                                  clearPanel()
                                }}
                                title={`${occ.name} · ${ASSET_ROLE_LABEL[occ.role || ''] ?? occ.role} · 拖动调整 U 位 / 双击编辑`}>
                                <span className="rack-device-name">{occ.name}</span>
                                <span className="rack-device-meta mono">{occ.id}</span>
                                <span className="rack-device-role">
                                  {ASSET_ROLE_LABEL[occ.role || ''] ?? occ.role ?? '—'}
                                </span>
                                <Tag text={ASSET_STATUS_LABEL[occ.status || ''] ?? occ.status ?? '—'}
                                  tone={toneOf(occ.status)} />
                                {isAdmin && <span className="rack-drag-handle" aria-hidden="true">⠿</span>}
                              </div>
                            ) : (
                              <span className="rack-empty"
                                title={isAdmin ? '双击可在此 U 位新增设备' : undefined}>
                                空闲
                              </span>
                            )}
                          </div>
                        )
                      })}
                    </div>
                    {/* 右侧立柱：每 U 一道刻度，标注 1U = 44.45mm */}
                    <div className="rack-side rack-side-right">
                      <div className="rack-rail-scale"
                        style={{ gridTemplateRows: `repeat(${slots.length}, ${RACK_DETAIL_SCALE.uPx}px)` }}>
                        {slots.map(u => <span className="rack-rail-tick" key={u} />)}
                      </div>
                      <span className="rack-side-note">1U = 44.45 mm</span>
                    </div>
                  </div>
                  <div className="rack-scale-caption" id="rack-scale-caption">
                    固定比例 · 1U {RACK_MM.uHeight} mm = {RACK_DETAIL_SCALE.uPx}px；
                    外壳 {RACK_MM.outerWidth} mm = {RACK_DETAIL_SCALE.outerPx.toFixed(0)}px；
                    安装区 {RACK_MM.mountWidth.toFixed(1)} mm = {RACK_DETAIL_SCALE.mountPx.toFixed(0)}px；
                    {mode === 'full'
                      ? `总高 ${units} U = ${rackHeightMm(units).toFixed(1)} mm`
                      : '仅已占用为紧凑列表，不代表机柜物理高度'}
                  </div>
                </div>
              </div>
            )}
          <div className="rack-elev-foot">
            <span className="muted">
              在线设备 {stats?.online ?? 0} 台 · 共 {stats?.used ?? 0} 台在架
            </span>
            <button className="btn sm" onClick={reload}>
              <Icon name="refresh" size={13} />刷新
            </button>
          </div>
        </Card>

        <div className="rack-detail-side">
          <Card
            title={creating !== null ? `在 U${creating} 新增设备`
              : editing ? `编辑设备 · ${selected?.name}`
                : selected ? `设备详情 · ${selected.name}` : '设备详情'}
            hint={creating !== null ? `目标机柜 ${rack?.name ?? rackId}`
              : selected ? `编号 ${selected.id} · 当前 U${selected.rack_u}`
                : '单击查看 · 双击编辑 / 新增'}
            extra={(editing || creating !== null) && isAdmin ? (
              <span className="rack-edit-head">
                {editing && <span className="hint">编号 {selected?.id}</span>}
                <button type="submit"
                  form={editing ? 'rack-device-form' : 'rack-create-form'}
                  className="btn sm primary"
                  id={editing ? 'rack-device-save-top' : 'rack-create-save-top'}
                  disabled={busy}>
                  {busy ? '处理中…' : (editing ? '保存' : '新增')}
                </button>
              </span>
            ) : undefined}>

            {creating !== null ? (
              <form id="rack-create-form" onSubmit={saveNewDevice}>
                <div className="field rack-new-id-field">
                  <label>设备编号 <span className="req">*</span></label>
                  <input id="rack-new-id" value={newId}
                    onChange={e => setNewId(e.target.value)}
                    placeholder="例如 DEV-0013" />
                  <div className="help">已自动建议下一个可用编号；仅支持字母、数字、. _ -，长度 2–48。</div>
                </div>
                <div className="rack-form-divider">设备信息</div>
                <div className="form-grid rack-device-form-grid">
                  {fields.map(f => renderField(f, 'create'))}
                </div>
                {formError && <div className="check-note bad" id="rack-device-error">{formError}</div>}
                <div className="drawer-actions">
                  <button type="button" className="btn ghost"
                    id="rack-create-cancel" onClick={clearPanel}>取消</button>
                  <button type="submit" className="btn primary" id="rack-create-save" disabled={busy}>
                    {busy ? '创建中…' : '新增设备'}
                  </button>
                </div>
              </form>
            ) : !selected ? (
              <div className="empty">
                单击设备查看只读详情；{isAdmin
                  ? '双击设备进入编辑，双击空闲 U 位可在此新增设备。'
                  : '当前为只读账号，仅可查看。'}
              </div>
            ) : editing ? (
              <form id="rack-device-form" onSubmit={saveDevice}>
                <div className="field rack-new-id-field">
                  <label>设备编号 <b className="req">*</b></label>
                  <input id="rack-device-id" value={newId} maxLength={48}
                    onChange={e => setNewId(e.target.value)}
                    placeholder="例如 DEV-0013" />
                  <div className="help">可再次编辑；保存后自动同步链路端点等引用。</div>
                </div>
                <div className="rack-device-facts">
                  <span>原编号 <b className="mono">{selected.id}</b></span>
                  <span>{ASSET_ROLE_LABEL[selected.role || ''] ?? selected.role ?? '—'}</span>
                  {selected.mgmt_ip && <span className="mono">{selected.mgmt_ip}</span>}
                  {selected.prefix_cidr && (
                    <span className="mono">{selected.prefix_cidr}
                      {selected.ipam_registered && <Tag text="已登记" tone="teal" />}
                    </span>
                  )}
                </div>
                <div className="form-grid rack-device-form-grid">
                  {fields.map(f => renderField(f, 'edit'))}
                </div>
                {formError && <div className="check-note bad" id="rack-device-error">{formError}</div>}
                <div className="drawer-actions">
                  <button type="button" className="btn ghost"
                    id="rack-device-cancel" onClick={clearPanel}>取消选中</button>
                  <button type="submit" className="btn primary" id="rack-device-save" disabled={busy}>
                    {busy ? '保存中…' : '保存修改'}
                  </button>
                </div>
              </form>
            ) : (
              <div className="rack-readonly-view" id="rack-device-readonly">
                <div className="rack-device-facts">
                  <span><b className="mono">{selected.id}</b></span>
                  <Tag text={ASSET_STATUS_LABEL[selected.status || ''] ?? selected.status ?? '—'}
                    tone={toneOf(selected.status)} />
                  <span>U{selected.rack_u}</span>
                </div>
                <div className="rack-info-list">
                  <div><span>设备名称</span><b>{selected.name}</b></div>
                  <div><span>角色</span><b>{ASSET_ROLE_LABEL[selected.role || ''] ?? selected.role ?? '—'}</b></div>
                  <div><span>厂商 / 型号</span><b>{[selected.vendor, selected.model].filter(Boolean).join(' ') || '—'}</b></div>
                  <div><span>管理 IP</span><b className="mono">{selected.mgmt_ip || '—'}</b></div>
                  <div><span>所属地址段</span><b className="mono">{selected.prefix_cidr || '—'}
                    {selected.ipam_registered && <Tag text="已登记" tone="teal" />}</b></div>
                  <div><span>所属平面</span><b className="mono">{selected.vrf || '—'}</b></div>
                  <div><span>负责人</span><b>{selected.owner || '—'}</b></div>
                  <div><span>备注</span><b>{selected.note || '—'}</b></div>
                </div>
                <div className="rack-readonly-hint">
                  <Icon name="info" size={13} />
                  {isAdmin
                    ? '双击左侧该设备可编辑；拖动设备可调整 U 位，松开鼠标后自动取消选中。'
                    : '只读账号：不能编辑设备或调整 U 位。'}
                </div>
                <div className="drawer-actions">
                  <button type="button" className="btn ghost" onClick={clearPanel}>取消选中</button>
                </div>
              </div>
            )}
          </Card>

          <Card title="机柜信息" hint="位置与容量">
            <div className="rack-info-list">
              <div><span>机柜编号</span><b className="mono">{rackId}</b></div>
              <div><span>所属位置</span><b>{rack?.location_name ?? '—'}</b></div>
              <div><span>容量 / 供电</span><b className="mono">{units} U / {rack?.power_kw ?? '—'} kW</b></div>
              <div><span>在架设备</span><b className="mono">{stats?.used ?? 0} 台</b></div>
              <div><span>运行状态</span><b>{ASSET_STATUS_LABEL[rack?.status || ''] ?? rack?.status ?? '—'}</b></div>
              {rack?.note && <div><span>备注</span><b>{rack.note}</b></div>}
            </div>
            {isAdmin && (
              <div className="asset-id-editor" id="rack-id-editor">
                {rackIdEditor ? (
                  <form onSubmit={saveRackId}>
                    <div className="field rack-new-id-field">
                      <label>机柜编号 <b className="req">*</b></label>
                      <input id="rack-id-input" value={rackIdDraft} maxLength={48}
                        onChange={e => setRackIdDraft(e.target.value)} />
                      <div className="help">可再次编辑；保存后自动同步设备所属机柜引用，并更新当前页面链接。</div>
                    </div>
                    {rackIdError && <div className="check-note bad" id="rack-id-error">{rackIdError}</div>}
                    <div className="inline">
                      <button type="submit" className="btn sm primary" id="rack-id-save"
                        disabled={rackIdBusy}>{rackIdBusy ? '保存中…' : '保存编号'}</button>
                      <button type="button" className="btn sm ghost" id="rack-id-cancel"
                        onClick={() => setRackIdEditor(false)}>取消</button>
                    </div>
                  </form>
                ) : (
                  <button className="btn sm ghost" id="rack-id-edit" onClick={openRackIdEditor}>
                    <Icon name="edit" size={12} />编辑机柜编号
                  </button>
                )}
              </div>
            )}
            <div className="asset-rel-actions">
              <button className="btn sm" onClick={() => onNavigate('devices')}>设备清单</button>
              <button className="btn sm" onClick={() => onNavigate('locations')}>位置层级</button>
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}
