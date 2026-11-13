import { useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react'
import { api } from '../api'
import { useAuth } from '../auth'
import { Card, Icon, MiniStat, Tag } from '../components/ui'
import { ASSET_ID_PATTERN, ASSET_STATUS_LABEL, type AssetKind, type AssetRow, type View } from '../types'
import { RACK_FLOOR_SCALE, RACK_MM, useLoad } from './shared'

const LOC_KIND_LABEL: Record<string, string> = {
  campus: '园区', building: '楼宇', floor: '楼层', room: '机房',
}

interface Props {
  locationId: string
  notify: (msg: string, kind?: 'ok' | 'error') => void
  onChanged: () => void
  onBack: () => void
  onOpenRack: (id: string) => void
  onOpenLocation: (id: string) => void
  onNavigate: (v: View) => void
  onRenamed?: (kind: AssetKind, previousId: string, nextId: string) => void
  refreshKey: number
}

function toneOf(status?: string): 'red' | 'amber' | 'teal' | 'blue' | 'neutral' {
  if (status === 'online' || status === 'active' || status === 'up') return 'teal'
  if (status === 'offline' || status === 'down' || status === 'retired') return 'red'
  if (status === 'maintenance' || status === 'planned') return 'amber'
  return 'blue'
}

const text = (v: unknown) => (v === null || v === undefined ? '' : String(v))

/**
 * 位置二级页面：#locations/<位置编号>。
 * 机柜按物理尺寸固定 1:2 缩尺绘制（1U=16px、19″ 安装区 482.6mm、外壳 800mm），
 * 固定 px 宽度不随页面自适应；立面高度按 U 数变化，所有机柜底边由
 * grid align-items:end 对齐到同一水平面（地面基线）。
 * 管理员可左右拖拽（或点左右箭头）调整排列顺序，顺序持久化到 asset_racks.layout_order。
 */
export default function LocationDetailView({
  locationId, notify, onChanged, onBack, onOpenRack, onOpenLocation, onNavigate,
  onRenamed, refreshKey,
}: Props) {
  const { isAdmin } = useAuth()
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropId, setDropId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')
  const [locIdEditor, setLocIdEditor] = useState(false)
  const [locIdDraft, setLocIdDraft] = useState('')
  const [locIdError, setLocIdError] = useState('')
  const [locIdBusy, setLocIdBusy] = useState(false)
  const suppressClick = useRef(false)

  /** 拖拽结束后浏览器可能补发一次 click，短暂屏蔽，避免误入机柜正视图。 */
  function suppressNextClick() {
    suppressClick.current = true
    window.setTimeout(() => { suppressClick.current = false }, 180)
  }

  const { data, loading, reload } = useLoad(
    () => api.assetLocationDetail(locationId), [locationId, refreshKey], notify,
  )
  const loc = data?.location
  const racks = data?.racks ?? []
  const children = data?.children ?? []
  const stats = data?.stats
  const order = useMemo(() => racks.map(r => r.id), [racks])

  /** 每台机柜的 U 位占用表，按 U 降序生成色块。 */
  const slotsOf = (rack: AssetRow) => {
    const units = rack.units || 42
    const byU = new Map<number, { id: string; name: string; status: string }>()
    for (const o of rack.occupants ?? []) {
      if (o.rack_u) byU.set(Number(o.rack_u), o)
    }
    return Array.from({ length: units }, (_, i) => {
      const u = units - i
      return { u, occ: byU.get(u) }
    })
  }

  async function persist(next: string[]) {
    if (!isAdmin || busy) return
    if (next.join('|') === order.join('|')) return
    setBusy(true)
    setHint('')
    try {
      const res = await api.reorderLocationRacks(locationId, next)
      if (res.action === 'reorder') notify('机柜排列顺序已更新')
      reload()
      onChanged()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '调整顺序失败'
      setHint(msg)
      notify(msg, 'error')
    } finally {
      setDragId(null)
      setDropId(null)
      setBusy(false)
    }
  }

  /** 拖到目标机柜：从左往右插到目标之后，从右往左插到目标之前。 */
  function dropOn(target: string, e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    e.stopPropagation()
    const from = dragId || e.dataTransfer.getData('text/plain')
    setDropId(null)
    setDragId(null)
    suppressNextClick()
    if (!from || !isAdmin || from === target) return
    const fromIdx = order.indexOf(from)
    const toIdx = order.indexOf(target)
    if (fromIdx < 0 || toIdx < 0) return
    const rest = order.filter(x => x !== from)
    const insertAt = rest.indexOf(target) + (fromIdx < toIdx ? 1 : 0)
    rest.splice(insertAt, 0, from)
    void persist(rest)
  }

  /** 左右箭头：与相邻机柜交换位置，等价于一次小范围拖动。 */
  function shift(index: number, delta: number) {
    const j = index + delta
    if (j < 0 || j >= order.length) return
    const next = [...order]
    ;[next[index], next[j]] = [next[j], next[index]]
    void persist(next)
  }

  function openLocIdEditor() {
    setLocIdDraft(locationId)
    setLocIdError('')
    setLocIdEditor(true)
  }

  /** 二级页内再次编辑位置编号：只提交 id，后端级联同步下级位置 / 机柜 / 设备引用。 */
  async function saveLocId(e: FormEvent) {
    e.preventDefault()
    if (!isAdmin || locIdBusy) return
    const next = locIdDraft.trim()
    if (!ASSET_ID_PATTERN.test(next)) {
      setLocIdError('位置编号必填，仅支持字母、数字、. _ -，长度 2–48')
      return
    }
    setLocIdBusy(true)
    setLocIdError('')
    try {
      const res = await api.updateAsset('locations', locationId, { id: next })
      if (res.id !== locationId) {
        onRenamed?.('locations', locationId, res.id)
        notify(`位置编号已更新：${locationId} → ${res.id}`)
      } else {
        notify('位置编号未变化')
      }
      setLocIdEditor(false)
      reload()
      onChanged()
    } catch (err) {
      setLocIdError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setLocIdBusy(false)
    }
  }

  return (
    <div className="loc-detail" id="location-detail">
      <div className="rack-detail-crumbs">
        <button className="btn sm ghost" id="loc-back" onClick={onBack}>
          <Icon name="undo" size={13} />返回位置清单
        </button>
        <span className="rack-crumb-path">
          设备管理 <i>/</i> 位置 <i>/</i> <b>{loc?.path ?? locationId}</b>
        </span>
        {data?.scope_limited && (
          <span className="asset-scope-note">
            按可见范围收敛：{data.visible_scopes?.join('、')}
          </span>
        )}
      </div>

      <div className="rack-detail-hero">
        <div className="rack-detail-title">
          <h2>{loading && !loc ? '正在加载位置…' : (loc?.name ?? '位置不存在')}</h2>
          <p className="muted">
            <span className="mono">{locationId}</span>
            {loc && <> · {LOC_KIND_LABEL[loc.kind || ''] ?? loc.kind} · {text(loc.address) || '未填写地址'}</>}
            {loc?.kind && (
              <> <Tag text={ASSET_STATUS_LABEL[loc.kind] ?? loc.kind} tone="blue" /></>
            )}
          </p>
        </div>
        <div className="inline">
          <button className="btn sm" id="loc-goto-racks" onClick={() => onNavigate('racks')}>
            <Icon name="database" size={13} />机柜清单
          </button>
          <button className="btn sm" id="loc-goto-devices" onClick={() => onNavigate('devices')}>
            <Icon name="cpu" size={13} />设备清单
          </button>
        </div>
      </div>

      <div className="stat-row">
        <MiniStat label="下属机柜" value={stats?.rack_count ?? 0} foot="台 · 同一位置" tone="blue" />
        <MiniStat label="机柜总容量" value={stats?.units_total ?? 0} foot={`最高 ${stats?.max_units ?? 0} U`} />
        <MiniStat label="已占用 U 位" value={stats?.used_u ?? 0} foot="在架设备数" tone="teal" />
        <MiniStat label="U 位利用率" value={stats?.util ?? 0} foot="已用 / 总容量（%）" tone="amber" />
      </div>

      <Card
        title="机柜平面视图"
        hint={`${racks.length} 台机柜 · 固定 1:2 物理比例 · 底边对齐`}
        extra={
          <span className="loc-head-actions">
            <span className="hint">高度按 U 数变化</span>
            {isAdmin && racks.length > 1 && (
              <button className="btn sm ghost" id="loc-reset-order" disabled={busy}
                onClick={() => void persist([...racks]
                  .sort((a, b) => a.id.localeCompare(b.id)).map(r => r.id))}>
                <Icon name="undo" size={12} />按编号排序
              </button>
            )}
          </span>
        }>
        <div className="loc-toolbar">
          <span className="muted">
            {isAdmin
              ? '左右拖动机柜可调整排列位置（底部始终对齐）；点击机柜进入正视图，也可使用卡片上的左右箭头微调。'
              : '只读模式：可查看机柜立面与占用情况，点击机柜进入正视图，不能调整排列。'}
          </span>
          <span className="rack-legend">
            <i className="dot online" />在线设备
            <i className="dot warn" />非在线
            <i className="dot free" />空闲 U 位
          </span>
        </div>
        <div className="loc-scale-note" id="loc-scale-note">
          {RACK_FLOOR_SCALE.label} · 1U {RACK_MM.uHeight} mm = {RACK_FLOOR_SCALE.uPx}px ·
          外壳 {RACK_MM.outerWidth} mm = {RACK_FLOOR_SCALE.outerPx.toFixed(0)}px ·
          19″ 安装区 {RACK_MM.mountWidth.toFixed(1)} mm = {RACK_FLOOR_SCALE.mountPx.toFixed(0)}px ·
          所有机柜固定同宽，不随页面宽度缩放
        </div>
        {hint && <div className="check-note bad" id="loc-hint">{hint}</div>}

        {racks.length === 0 ? (
          <div className="empty">该位置下还没有机柜；可在下方查看下级位置，或到「机柜」清单新建。</div>
        ) : (
          <div className="loc-floor" id="loc-floor">
            <div className="loc-rack-row" id="loc-rack-row"
              style={{ gridTemplateColumns: `repeat(${racks.length}, ${RACK_FLOOR_SCALE.outerPx}px)` }}>
              {racks.map((rack, idx) => {
                const units = rack.units || 42
                const slots = slotsOf(rack)
                return (
                  <div
                    key={rack.id}
                    id={`loc-rack-${rack.id}`}
                    className={`loc-rack${dragId === rack.id ? ' dragging' : ''}${
                      dropId === rack.id ? ' drop-target' : ''}${
                      rack.status !== 'active' ? ' inactive' : ''}`}
                    style={{ width: RACK_FLOOR_SCALE.outerPx }}
                    draggable={isAdmin}
                    onDragStart={e => {
                      if (!isAdmin) { e.preventDefault(); return }
                      setDragId(rack.id)
                      suppressNextClick()
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/plain', rack.id)
                    }}
                    onDragOver={e => {
                      if (!isAdmin || !dragId || dragId === rack.id) return
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                      if (dropId !== rack.id) setDropId(rack.id)
                    }}
                    onDragLeave={() => setDropId(v => v === rack.id ? null : v)}
                    onDrop={e => dropOn(rack.id, e)}
                    onDragEnd={() => {
                      setDragId(null)
                      setDropId(null)
                      suppressNextClick()
                    }}
                    onClick={() => {
                      if (suppressClick.current) { suppressClick.current = false; return }
                      onOpenRack(rack.id)
                    }}
                    title={`${rack.name}（${rack.id}）· ${units} U · 点击进入机柜正视图`}>
                    <div className="loc-rack-head">
                      <span className="loc-rack-name">{rack.name}</span>
                      {isAdmin && (
                        <span className="loc-rack-move" onClick={e => e.stopPropagation()}>
                          <button type="button" className="loc-move-btn"
                            id={`loc-left-${rack.id}`} title="左移一位" disabled={busy || idx === 0}
                            onClick={() => shift(idx, -1)}>‹</button>
                          <button type="button" className="loc-move-btn"
                            id={`loc-right-${rack.id}`} title="右移一位"
                            disabled={busy || idx === racks.length - 1}
                            onClick={() => shift(idx, 1)}>›</button>
                        </span>
                      )}
                    </div>
                    {/* 外壳 800mm = 两侧立柱 + 19″(482.6mm) 安装区；每 U 固定 16px */}
                    <div className="loc-rack-shell" id={`loc-shell-${rack.id}`}
                      style={{ height: units * RACK_FLOOR_SCALE.uPx }}>
                      <div className="loc-rack-side left">
                        <div className="loc-rail-scale"
                          style={{ gridTemplateRows: `repeat(${units}, ${RACK_FLOOR_SCALE.uPx}px)` }}>
                          {slots.map(s => <span className="loc-rail-tick" key={s.u} />)}
                        </div>
                      </div>
                      <div className="loc-rack-body" id={`loc-body-${rack.id}`}
                        style={{ width: RACK_FLOOR_SCALE.mountPx,
                          height: units * RACK_FLOOR_SCALE.uPx,
                          gridTemplateRows: `repeat(${units}, ${RACK_FLOOR_SCALE.uPx}px)` }}>
                        {slots.map(s => (
                          <div key={s.u}
                            className={`loc-u${s.occ ? ' used' : ''}${
                              s.occ && s.occ.status !== 'online' ? ' warn' : ''}`}
                            title={s.occ
                              ? `U${s.u} · ${s.occ.name}（${s.occ.id}）· ${ASSET_STATUS_LABEL[s.occ.status] ?? s.occ.status}`
                              : `U${s.u} 空闲`}>
                            <span className="loc-u-num">U{s.u}</span>
                          </div>
                        ))}
                      </div>
                      <div className="loc-rack-side right">
                        <div className="loc-rail-scale"
                          style={{ gridTemplateRows: `repeat(${units}, ${RACK_FLOOR_SCALE.uPx}px)` }}>
                          {slots.map(s => <span className="loc-rail-tick" key={s.u} />)}
                        </div>
                      </div>
                    </div>
                    <div className="loc-rack-foot">
                      <span className="mono">{rack.id}</span>
                      <span className="loc-rack-cap"><b>{units}U</b> · {rack.used_u ?? 0}/{units} 已用</span>
                      <Tag text={ASSET_STATUS_LABEL[rack.status || ''] ?? rack.status ?? '—'}
                        tone={toneOf(rack.status)} />
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="loc-floor-line" id="loc-floor-line"><span>地面基线 · 所有机柜底边对齐</span></div>
          </div>
        )}

        <div className="rack-elev-foot">
          <span className="muted">
            共 {racks.length} 台机柜 · {stats?.units_total ?? 0} U 容量 · {stats?.device_count ?? 0} 台设备在架
          </span>
          <button className="btn sm" id="loc-refresh" disabled={busy} onClick={reload}>
            <Icon name="refresh" size={13} />刷新
          </button>
        </div>
      </Card>

      <div className="loc-bottom">
        {children.length > 0 && (
          <Card title="下级位置" hint={`${children.length} 个`}>
            <div className="loc-children">
              {children.map(c => (
                <button key={c.id} className="loc-child" id={`loc-child-${c.id}`}
                  onClick={() => onOpenLocation(c.id)}>
                  <Icon name="network" size={14} />
                  <span className="loc-child-main">
                    <b>{c.name}</b>
                    <small className="mono">{c.id} · {LOC_KIND_LABEL[c.kind || ''] ?? c.kind}</small>
                  </span>
                  <span className="loc-child-meta">{c.rack_count ?? 0} 柜 / {c.device_count ?? 0} 设备</span>
                </button>
              ))}
            </div>
          </Card>
        )}
        <Card title="位置信息" hint="层级与联系人">
          <div className="rack-info-list">
            <div><span>位置编号</span><b className="mono">{locationId}</b></div>
            <div><span>层级路径</span><b>{loc?.path ?? '—'}</b></div>
            <div><span>上级位置</span><b>{text(loc?.parent_name) || '—'}</b></div>
            <div><span>位置类型</span><b>{LOC_KIND_LABEL[loc?.kind || ''] ?? loc?.kind ?? '—'}</b></div>
            <div><span>地址</span><b>{text(loc?.address) || '—'}</b></div>
            <div><span>联系人</span><b>{text(loc?.contact) || '—'}</b></div>
            {loc?.note && <div><span>备注</span><b>{text(loc.note)}</b></div>}
          </div>
          {isAdmin && (
            <div className="asset-id-editor" id="loc-id-editor">
              {locIdEditor ? (
                <form onSubmit={saveLocId}>
                  <div className="field rack-new-id-field">
                    <label>位置编号 <b className="req">*</b></label>
                    <input id="loc-id-input" value={locIdDraft} maxLength={48}
                      onChange={e => setLocIdDraft(e.target.value)} />
                    <div className="help">可再次编辑；保存后自动同步下级位置 / 机柜 / 设备引用，并更新当前页面链接。</div>
                  </div>
                  {locIdError && <div className="check-note bad" id="loc-id-error">{locIdError}</div>}
                  <div className="inline">
                    <button type="submit" className="btn sm primary" id="loc-id-save"
                      disabled={locIdBusy}>{locIdBusy ? '保存中…' : '保存编号'}</button>
                    <button type="button" className="btn sm ghost" id="loc-id-cancel"
                      onClick={() => setLocIdEditor(false)}>取消</button>
                  </div>
                </form>
              ) : (
                <button className="btn sm ghost" id="loc-id-edit" onClick={openLocIdEditor}>
                  <Icon name="edit" size={12} />编辑位置编号
                </button>
              )}
            </div>
          )}
          <div className="asset-rel-actions">
            <button className="btn sm" onClick={() => onNavigate('locations')}>位置清单</button>
            <button className="btn sm" onClick={() => onNavigate('links')}>链路清单</button>
          </div>
        </Card>
      </div>
    </div>
  )
}
