import { useCallback, useEffect, useMemo, useRef, useState,
  type FormEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { api } from '../api'
import { useAuth } from '../auth'
import { Drawer, Icon, MiniStat, Tag } from '../components/ui'
import type {
  TopologyCatalog, TopologyDetail, TopologyListData, TopologyNode,
  TopologyPayload, TopologySummary, View,
} from '../types'
import type { ViewProps } from './shared'

const NODE_W = 150
const NODE_H = 46
const ROLE_LABEL: Record<string, string> = {
  core: '核心交换机', aggregation: '汇聚交换机', access: '接入交换机',
  router: '路由器', firewall: '防火墙', server: '服务器',
  load_balancer: '负载均衡', other: '其它',
}

type Selection = { type: 'node' | 'edge'; id: string } | null
type EditorMode = { mode: 'create' | 'rename'; id?: string } | null
type FormState = {
  name: string
  description: string
  vrf: string
  root_mode: 'auto' | 'manual'
  root_device_id: string
  device_ids: string[]
}

const EMPTY_FORM: FormState = {
  name: '', description: '', vrf: 'default',
  root_mode: 'auto', root_device_id: '', device_ids: [],
}

function shortTime(value?: string | null) {
  return value ? value.slice(5, 16) : '—'
}

function escapeXml(value: string) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 导出用的纯静态 SVG：不依赖页面样式，下载后可直接打开或贴进文档。 */
function buildExportSvg(detail: TopologyDetail, nodes: TopologyNode[]) {
  const maxX = Math.max(detail.canvas.width, ...nodes.map(n => n.x + NODE_W))
  const maxY = Math.max(detail.canvas.height, ...nodes.map(n => n.y + NODE_H))
  const width = Math.ceil(maxX + 80)
  const height = Math.ceil(maxY + 80)
  const byId = new Map(nodes.map(n => [n.id, n]))
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="100%" height="100%" fill="#FFFFFF"/>`,
    `<text x="24" y="34" font-size="16" fill="#1B2430">${escapeXml(detail.name)}</text>`,
    `<text x="24" y="54" font-size="11" fill="#5B6879">VRF ${escapeXml(detail.vrf)} · ${nodes.length} 台设备 · ${detail.edges.length} 条链路</text>`,
  ]
  for (const e of detail.edges) {
    const a = byId.get(e.local_device_id)
    const b = byId.get(e.remote_device_id)
    if (!a || !b) continue
    const stroke = e.edge_role === 'tree' ? '#185FA5' : '#BA7517'
    const dash = e.edge_role === 'tree' ? '' : ' stroke-dasharray="5 4"'
    const path = e.edge_role === 'tree'
      ? (() => {
          const child = a.parent === b.id ? a : b
          const parent = child === a ? b : a
          const py = parent.y + NODE_H
          const mid = (py + child.y) / 2
          return `M ${parent.x} ${py} V ${mid} H ${child.x} V ${child.y}`
        })()
      : `M ${a.x} ${a.y + NODE_H / 2} L ${b.x} ${b.y + NODE_H / 2}`
    out.push(`<path d="${path}" fill="none" stroke="${stroke}" stroke-width="1.3"${dash}/>`)
  }
  for (const n of nodes) {
    const x = n.x - NODE_W / 2
    const fill = n.is_root ? '#B5D4F4' : n.pinned ? '#FAEEDA' : '#E6F1FB'
    const border = n.is_root ? '#185FA5' : n.pinned ? '#BA7517' : '#85B7EB'
    out.push(`<rect x="${x}" y="${n.y}" width="${NODE_W}" height="${NODE_H}" rx="8" fill="${fill}" stroke="${border}"/>`)
    out.push(`<text x="${x + 10}" y="${n.y + 19}" font-size="12" fill="#1B2430">${escapeXml(n.name)}</text>`)
    out.push(`<text x="${x + 10}" y="${n.y + 35}" font-size="10" fill="#5B6879">${escapeXml(ROLE_LABEL[n.role] ?? n.role)}</text>`)
  }
  out.push('</svg>')
  return out.join('')
}

function downloadSvg(name: string, content: string) {
  const blob = new Blob([content], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${name.replace(/[\\/:*?"<>|]/g, '_')}.svg`
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 拓扑功能：列表 → 新建 / 打开 → 树形画布编辑。数据与坐标均由后端持久化。 */
export default function TopologyView({ notify, onChanged, refreshKey, onNavigate }: ViewProps & {
  onNavigate?: (view: View) => void
}) {
  const { isAdmin, vrf: currentPlane, setVrf } = useAuth()
  const [list, setList] = useState<TopologyListData | null>(null)
  const [detail, setDetail] = useState<TopologyDetail | null>(null)
  const [nodes, setNodes] = useState<TopologyNode[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [selection, setSelection] = useState<Selection>(null)
  const [editor, setEditor] = useState<EditorMode>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [catalog, setCatalog] = useState<TopologyCatalog | null>(null)
  const [viewport, setViewport] = useState({ x: 0, y: 0, w: 1000, h: 560 })
  const svgRef = useRef<SVGSVGElement | null>(null)
  const dragRef = useRef<{ id: string; dx: number; dy: number; moved: boolean } | null>(null)

  const loadList = useCallback(async () => {
    try {
      setList(await api.topologies())
    } catch (err) {
      notify(String(err), 'error')
    } finally {
      setLoading(false)
    }
  }, [notify])

  useEffect(() => { loadList() }, [loadList, refreshKey])

  const loadDetail = useCallback(async (id: string) => {
    setBusy(true)
    try {
      const next = await api.topology(id)
      setDetail(next)
      setNodes(next.nodes.map(n => ({ ...n })))
      setSelection(null)
      return next
    } catch (err) {
      notify(String(err), 'error')
      return null
    } finally {
      setBusy(false)
    }
  }, [notify])

  useEffect(() => {
    if (detail) {
      setViewport({
        x: 0, y: 0,
        w: Math.max(900, detail.canvas.width + 60),
        h: Math.max(420, detail.canvas.height + 60),
      })
    }
    // 只在切换到另一张拓扑时重置视图，保存坐标后刷新不会打断缩放
  }, [detail?.id])

  const canEdit = Boolean(isAdmin && detail?.writable)

  const loadCatalog = useCallback(async (vrf: string, selectAll: boolean) => {
    try {
      const next = await api.topologyCatalog(vrf)
      setCatalog(next)
      if (selectAll) {
        setForm(f => ({ ...f, vrf, device_ids: next.items.map(d => d.id), root_device_id: '' }))
      }
      return next
    } catch (err) {
      notify(String(err), 'error')
      return null
    }
  }, [notify])

  const openCreate = () => {
    const vrf = currentPlane === 'all' ? (list?.vrfs[0]?.id ?? 'default') : currentPlane
    setForm({ ...EMPTY_FORM, vrf })
    setEditor({ mode: 'create' })
    loadCatalog(vrf, true)
  }

  const openRename = (item: TopologySummary) => {
    setForm({ ...EMPTY_FORM, name: item.name, description: item.description, vrf: item.vrf })
    setEditor({ mode: 'rename', id: item.id })
  }

  const saveForm = async (e: FormEvent) => {
    e.preventDefault()
    if (!form.name.trim()) { notify('请填写拓扑名称', 'error'); return }
    setBusy(true)
    try {
      if (editor?.mode === 'create') {
        const payload: TopologyPayload = {
          name: form.name.trim(), description: form.description.trim(), vrf: form.vrf,
          device_ids: form.device_ids, root_mode: form.root_mode,
          root_device_id: form.root_mode === 'manual' ? form.root_device_id : null,
        }
        const created = await api.createTopology(payload)
        setEditor(null)
        await loadList()
        await loadDetail(created.id)
        notify('拓扑图已创建并自动生成树形布局')
      } else if (editor?.id) {
        await api.updateTopology(editor.id, {
          name: form.name.trim(), description: form.description.trim(),
        })
        setEditor(null)
        await loadList()
        if (detail?.id === editor.id) await loadDetail(editor.id)
        notify('拓扑图信息已更新')
      }
      onChanged()
    } catch (err) {
      notify(String(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  const removeTopology = async (item: TopologySummary) => {
    if (!window.confirm(`确认删除拓扑图「${item.name}」？设备与链路台账不会受影响。`)) return
    setBusy(true)
    try {
      await api.deleteTopology(item.id)
      if (detail?.id === item.id) { setDetail(null); setNodes([]) }
      await loadList()
      onChanged()
      notify('拓扑图已删除')
    } catch (err) { notify(String(err), 'error') }
    finally { setBusy(false) }
  }

  const duplicateTopology = async (item: TopologySummary) => {
    setBusy(true)
    try {
      await api.duplicateTopology(item.id)
      await loadList()
      onChanged()
      notify('已复制拓扑图')
    } catch (err) { notify(String(err), 'error') }
    finally { setBusy(false) }
  }

  const exec = async (fn: () => Promise<unknown>, message: string) => {
    if (!detail) return
    setBusy(true)
    try {
      await fn()
      await loadDetail(detail.id)
      await loadList()
      onChanged()
      notify(message)
    } catch (err) { notify(String(err), 'error') }
    finally { setBusy(false) }
  }

  const toggleDevice = (id: string) => {
    if (!detail || !canEdit) return
    const current = nodes.map(n => n.id)
    const next = current.includes(id) ? current.filter(x => x !== id) : [...current, id]
    void exec(() => api.updateTopology(detail.id, { device_ids: next }), '设备范围已更新')
  }

  const changeRoot = (value: string) => {
    if (!detail || !canEdit) return
    const payload: TopologyPayload = value
      ? { root_mode: 'manual', root_device_id: value }
      : { root_mode: 'auto', root_device_id: null }
    void exec(() => api.updateTopology(detail.id, payload), '根节点已更新，树形布局已重排')
  }

  const toSvgPoint = (e: { clientX: number; clientY: number }) => {
    const svg = svgRef.current
    const matrix = svg?.getScreenCTM()
    if (!svg || !matrix) return { x: 0, y: 0 }
    const pt = svg.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const p = pt.matrixTransform(matrix.inverse())
    return { x: p.x, y: p.y }
  }

  const onNodeDown = (e: ReactPointerEvent<SVGGElement>, node: TopologyNode) => {
    setSelection({ type: 'node', id: node.id })
    if (!canEdit) return
    e.preventDefault()
    const p = toSvgPoint(e)
    dragRef.current = { id: node.id, dx: p.x - node.x, dy: p.y - node.y, moved: false }
    svgRef.current?.setPointerCapture(e.pointerId)
  }

  const onSvgMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const p = toSvgPoint(e)
    const x = Math.round((p.x - drag.dx) * 10) / 10
    const y = Math.round((p.y - drag.dy) * 10) / 10
    drag.moved = true
    setNodes(prev => prev.map(n => n.id === drag.id ? { ...n, x, y } : n))
  }

  const onSvgUp = async (e: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current
    dragRef.current = null
    try { svgRef.current?.releasePointerCapture(e.pointerId) } catch { /* 忽略 */ }
    if (!drag || !drag.moved || !detail) return
    const moved = nodes.find(n => n.id === drag.id)
    if (!moved) return
    try {
      await api.saveTopologyLayout(detail.id,
        [{ device_id: moved.id, x: moved.x, y: moved.y }])
      onChanged()
      await loadDetail(detail.id)
      notify('节点位置已保存')
    } catch (err) {
      notify(String(err), 'error')
      await loadDetail(detail.id)
    }
  }

  const zoom = (factor: number) => setViewport(v => {
    const w = Math.min(4000, Math.max(320, v.w * factor))
    const ratio = w / v.w
    const cx = v.x + v.w / 2
    const cy = v.y + v.h / 2
    return { x: cx - (v.w * ratio) / 2, y: cy - (v.h * ratio) / 2,
             w, h: v.h * ratio }
  })

  const fitView = () => {
    if (!detail) return
    setViewport({ x: 0, y: 0,
      w: Math.max(900, detail.canvas.width + 60),
      h: Math.max(420, detail.canvas.height + 60) })
  }

  const nodeMap = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes])
  const selectedNode = selection?.type === 'node' ? nodeMap.get(selection.id) : undefined
  const selectedEdge = selection?.type === 'edge'
    ? detail?.edges.find(e => e.id === selection.id) : undefined

  const filtered = (list?.items ?? []).filter(item =>
    !keyword.trim() || (item.name + item.description + item.vrf).toLowerCase()
      .includes(keyword.trim().toLowerCase()))
  const catalogGroups = useMemo(() => {
    const groups = new Map<string, TopologyCatalog['items']>()
    for (const device of catalog?.items ?? []) {
      const key = device.location_name || '未分配位置'
      groups.set(key, [...(groups.get(key) ?? []), device])
    }
    return [...groups.entries()]
  }, [catalog])

  const planeNote = detail && !detail.writable
    ? detail.plane === 'all'
      ? '当前是「全部 VRF · 跨平面对比」只读汇总视图，编辑前请先选定具体地址平面。'
      : `当前顶栏平面为 ${detail.plane}，该拓扑属于 ${detail.vrf}。`
    : ''

  return (
    <div className="topo-page">
      {!detail ? (
        <>
          <div className="stat-row">
            <MiniStat label="拓扑图" value={list?.items.length ?? 0} foot="当前平面可见" tone="blue" />
            <MiniStat label="纳入设备" value={(list?.items ?? []).reduce((s, i) => s + i.device_count, 0)}
              foot="按拓扑累加" tone="teal" />
            <MiniStat label="关联链路" value={(list?.items ?? []).reduce((s, i) => s + i.link_count, 0)}
              foot="实时由资产链路推导" />
            <MiniStat label="当前平面" value={currentPlane === 'all' ? '全部' : currentPlane}
              foot={currentPlane === 'all' ? '汇总只读视图' : '可编辑'} />
          </div>
          <div className="toolbar">
            <div className="search" style={{ marginLeft: 0 }}>
              <Icon name="search" size={14} />
              <input id="topology-search" value={keyword} placeholder="搜索拓扑名称 / 平面"
                onChange={e => setKeyword(e.target.value)} />
            </div>
            <span className="spacer" />
            <button className="btn" onClick={() => void loadList()}><Icon name="refresh" size={13} />刷新</button>
            <button className="btn primary" id="topology-create" disabled={!isAdmin}
              onClick={openCreate}><Icon name="plus" size={13} />新建拓扑</button>
          </div>
          {currentPlane === 'all' && (
            <div className="vrf-notice" style={{ marginBottom: 14 }}>
              <Icon name="info" size={14} />
              <span>汇总视图下可浏览全部平面，也可新建拓扑（需指定平面）；编辑已有拓扑请先从顶栏选定其所属平面。</span>
            </div>
          )}
          {loading ? <div className="card"><div className="card-body">加载中…</div></div>
            : filtered.length === 0 ? (
              <div className="card"><div className="card-body" style={{ padding: '38px 18px', textAlign: 'center', color: 'var(--text-3)' }}>
                <Icon name="network" size={28} />
                <p style={{ marginTop: 10 }}>还没有拓扑图。点击「新建拓扑」，勾选设备后会自动生成树形网络拓扑。</p>
              </div></div>
            ) : (
              <div className="topo-cards">
                {filtered.map(item => (
                  <div className="topo-card" key={item.id}>
                    <div className="topo-card-icon"><Icon name="network" size={18} /></div>
                    <div className="topo-card-main">
                      <div className="topo-card-title">{item.name}<Tag text={item.vrf} tone="blue" /></div>
                      <p className="topo-card-desc">{item.description || '未填写说明'}</p>
                      <p className="topo-card-meta">
                        {item.device_count} 台设备 · {item.link_count} 条链路 ·
                        根设备 {item.root_mode === 'manual' ? (item.root_device_id || '手动') : '自动'} ·
                        更新 {shortTime(item.updated_at || item.created_at)}
                      </p>
                    </div>
                    <div className="topo-card-actions">
                      <button className="btn sm" onClick={() => void loadDetail(item.id)}>打开 ›</button>
                      <button className="btn sm" disabled={!isAdmin || busy}
                        onClick={() => openRename(item)}>重命名</button>
                      <button className="btn sm" disabled={!isAdmin || busy}
                        onClick={() => void duplicateTopology(item)}>复制</button>
                      <button className="btn sm danger-btn" disabled={!isAdmin || busy}
                        onClick={() => void removeTopology(item)}>删除</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
        </>
      ) : (
        <>
          <div className="topo-toolbar">
            <button className="btn sm" onClick={() => { setDetail(null); setNodes([]); setSelection(null) }}>
              <Icon name="undo" size={13} />返回列表</button>
            <b id="topology-title">{detail.name}</b>
            <Tag text={`VRF ${detail.vrf}`} tone="blue" />
            <span className="topo-toolbar-meta">
              {detail.stats.devices} 台设备 / {detail.stats.links} 条链路
              {detail.stats.pinned ? ` · ${detail.stats.pinned} 个固定坐标` : ''}
            </span>
            <span className="spacer" />
            <button className="btn sm" onClick={() => zoom(0.85)}>＋</button>
            <button className="btn sm" onClick={() => zoom(1.18)}>－</button>
            <button className="btn sm" onClick={fitView}>适应画布</button>
            <button className="btn sm" onClick={() => downloadSvg(detail.name, buildExportSvg(detail, nodes))}>
              <Icon name="download" size={13} />导出 SVG</button>
            <button className="btn sm primary" disabled={!canEdit || busy}
              onClick={() => void exec(() => api.relayoutTopology(detail.id), '已恢复自动树形布局')}>
              重新布局</button>
          </div>

          {planeNote && (
            <div className="readonly-banner" style={{ marginBottom: 12 }}>
              <Icon name="info" size={14} />
              <span><b>画布只读</b> · {planeNote}</span>
              {detail.plane !== detail.vrf && detail.vrf !== 'all' && (
                <button className="btn sm" onClick={() => setVrf(detail.vrf)}>切换到 {detail.vrf}</button>
              )}
            </div>
          )}
          {!isAdmin && (
            <div className="readonly-banner" style={{ marginBottom: 12 }}>
              <Icon name="shield" size={14} /><span><b>只读账号</b> · 可查看与导出拓扑，不能拖动或编辑。</span>
            </div>
          )}

          <div className="topo-grid">
            <div className="topo-side">
              <div className="topo-side-head">
                <b>设备池</b>
                <span>已选 {nodes.length} / {detail.catalog.items.length}</span>
              </div>
              <input className="topo-filter" placeholder="筛选设备…" value={keyword}
                onChange={e => setKeyword(e.target.value)} />
              <div className="topo-device-list">
                {[...detail.catalog.items]
                  .filter(d => !keyword.trim() || (d.name + d.id + (d.mgmt_ip ?? ''))
                    .toLowerCase().includes(keyword.trim().toLowerCase()))
                  .map(device => {
                    const checked = nodeMap.has(device.id)
                    return (
                      <button key={device.id} className={`topo-device-row${checked ? ' on' : ''}`}
                        disabled={!canEdit || busy}
                        onClick={() => toggleDevice(device.id)}>
                        <span className={`topo-check${checked ? ' on' : ''}`}>
                          {checked && <Icon name="check" size={10} />}
                        </span>
                        <span>
                          <b>{device.name}</b>
                          <small>{device.rack_name || device.location_name || '未上架'} · {device.mgmt_ip || '无管理 IP'}</small>
                        </span>
                      </button>
                    )
                  })}
              </div>
              <div className="topo-side-foot">连线来自链路清单，增删设备后自动重排</div>
            </div>

            <div className="topo-canvas">
              <svg ref={svgRef} className="topo-svg" width="100%" height="100%"
                viewBox={`${viewport.x} ${viewport.y} ${viewport.w} ${viewport.h}`}
                onPointerMove={onSvgMove} onPointerUp={e => void onSvgUp(e)}
                onPointerCancel={e => void onSvgUp(e)}>
                <defs>
                  <pattern id="topo-dots" width="18" height="18" patternUnits="userSpaceOnUse">
                    <circle cx="1.5" cy="1.5" r="0.8" fill="#E6EAF0" />
                  </pattern>
                </defs>
                <rect x={viewport.x} y={viewport.y} width={viewport.w} height={viewport.h}
                  fill="url(#topo-dots)" />
                {detail.edges.map(edge => {
                  const a = nodeMap.get(edge.local_device_id)
                  const b = nodeMap.get(edge.remote_device_id)
                  if (!a || !b) return null
                  const tree = edge.edge_role === 'tree'
                  const child = a.parent === b.id ? a : b
                  const parent = child === a ? b : a
                  const py = parent.y + NODE_H
                  const midY = (py + child.y) / 2
                  const path = tree
                    ? `M ${parent.x} ${py} V ${midY} H ${child.x} V ${child.y}`
                    : `M ${a.x} ${a.y + NODE_H / 2} L ${b.x} ${b.y + NODE_H / 2}`
                  return (
                    <g key={edge.id} className="topo-edge"
                      onClick={() => setSelection({ type: 'edge', id: edge.id })}>
                      <path d={path} fill="none" stroke="transparent" strokeWidth={12} />
                      <path d={path} fill="none" stroke={tree ? '#185FA5' : '#BA7517'}
                        strokeWidth={tree ? 1.4 : 1.2}
                        strokeDasharray={tree ? undefined : '5 4'} />
                      {tree && (
                        <text x={(parent.x + child.x) / 2} y={midY - 5} textAnchor="middle"
                          fontSize="10" fill="#93A0B0">{edge.bandwidth_gbps}G</text>
                      )}
                    </g>
                  )
                })}
                {nodes.map(node => {
                  const active = selection?.type === 'node' && selection.id === node.id
                  const fill = node.is_root ? '#B5D4F4' : node.pinned ? '#FAEEDA' : '#E6F1FB'
                  const border = active ? '#0C447C' : node.is_root ? '#185FA5'
                    : node.pinned ? '#BA7517' : '#85B7EB'
                  return (
                    <g key={node.id} transform={`translate(${node.x - NODE_W / 2},${node.y})`}
                      className="topo-node" onPointerDown={e => onNodeDown(e, node)}
                      style={{ cursor: canEdit ? 'grab' : 'pointer' }}>
                      <rect width={NODE_W} height={NODE_H} rx="8" fill={fill} stroke={border}
                        strokeWidth={active ? 1.6 : 0.8} />
                      <text x="11" y="19" fontSize="12" fontWeight="500" fill="#1B2430">
                        {node.name.length > 17 ? node.name.slice(0, 16) + '…' : node.name}
                      </text>
                      <text x="11" y="35" fontSize="10" fill="#5B6879">
                        {ROLE_LABEL[node.role] ?? node.role} · {node.mgmt_ip || '无 IP'}
                      </text>
                      {node.is_root && <circle cx={NODE_W - 12} cy="12" r="4" fill="#185FA5" />}
                      {!!node.pinned && <circle cx={NODE_W - 12} cy="34" r="3.5" fill="#BA7517" />}
                    </g>
                  )
                })}
              </svg>
              <div className="topo-canvas-foot">
                {canEdit ? '拖动节点即可调整位置，松手自动保存；点连线查看链路详情'
                  : '只读视图：可点选节点 / 连线查看属性'}
              </div>
            </div>

            <div className="topo-side topo-props">
              <div className="topo-side-head"><b>属性</b><span>{detail.vrf}</span></div>
              <div className="field">
                <label>根节点</label>
                <select value={detail.root_mode === 'manual' ? (detail.root_device_id ?? '') : ''}
                  disabled={!canEdit || busy} onChange={e => changeRoot(e.target.value)}>
                  <option value="">自动 · 连接度最高</option>
                  {nodes.map(n => <option key={n.id} value={n.id}>{n.name}</option>)}
                </select>
                <div className="help">默认取链路连接度最高的设备；手动指定后会重新生成树形布局。</div>
              </div>
              {selectedNode && (
                <div className="topo-prop-block">
                  <h3>设备 · {selectedNode.name}</h3>
                  <Prop label="角色" value={ROLE_LABEL[selectedNode.role] ?? selectedNode.role} />
                  <Prop label="厂商型号" value={`${selectedNode.vendor || '—'} ${selectedNode.model || ''}`.trim()} />
                  <Prop label="管理 IP" value={selectedNode.mgmt_ip || '—'} />
                  <Prop label="机柜 / 位置" value={`${selectedNode.rack_name || '—'} / ${selectedNode.location_name || '—'}`} />
                  <Prop label="状态" value={selectedNode.status === 'online' ? '在线' : selectedNode.status} />
                  <Prop label="坐标 X / Y" value={`${Math.round(selectedNode.x)} / ${Math.round(selectedNode.y)}`} />
                  <Prop label="位置" value={selectedNode.pinned ? '手动固定' : '自动布局'} />
                  {onNavigate && (
                    <button className="btn sm" style={{ marginTop: 10 }}
                      onClick={() => onNavigate('devices')}>去设备清单编辑 ›</button>
                  )}
                </div>
              )}
              {selectedEdge && (
                <div className="topo-prop-block">
                  <h3>链路 · {selectedEdge.name || selectedEdge.id}</h3>
                  <Prop label="本端" value={`${nodeMap.get(selectedEdge.local_device_id)?.name ?? selectedEdge.local_device_id} / ${selectedEdge.local_port}`} />
                  <Prop label="对端" value={`${nodeMap.get(selectedEdge.remote_device_id)?.name ?? selectedEdge.remote_device_id} / ${selectedEdge.remote_port}`} />
                  <Prop label="带宽" value={`${selectedEdge.bandwidth_gbps} Gbps`} />
                  <Prop label="VLAN / 类型" value={`${selectedEdge.vlan || '—'} / ${selectedEdge.kind}`} />
                  <Prop label="状态" value={selectedEdge.status === 'up' ? '连通' : selectedEdge.status} />
                  <Prop label="拓扑角色" value={selectedEdge.edge_role === 'tree' ? '生成树边' : '附加链路（环路等）'} />
                  {onNavigate && (
                    <button className="btn sm" style={{ marginTop: 10 }}
                      onClick={() => onNavigate('links')}>去链路清单编辑 ›</button>
                  )}
                </div>
              )}
              {!selectedNode && !selectedEdge && (
                <div className="topo-prop-block">
                  <h3>拓扑概况</h3>
                  <Prop label="生成树链路" value={`${detail.stats.tree_links} 条`} />
                  <Prop label="附加链路" value={`${detail.stats.links - detail.stats.tree_links} 条`} />
                  <Prop label="孤立设备" value={`${detail.stats.isolated} 台`} />
                  <Prop label="固定坐标" value={`${detail.stats.pinned} 个`} />
                  <div className="help" style={{ marginTop: 10 }}>
                    未拖动的节点始终跟随链路变化自动重排；拖过的节点保持固定，点「重新布局」可全部复位。
                  </div>
                </div>
              )}
              {detail.missing_devices.length > 0 && (
                <div className="help" style={{ color: 'var(--amber-800)', marginTop: 12 }}>
                  有 {detail.missing_devices.length} 台设备已从台账删除，画布中不再显示；重新勾选设备范围即可清理。
                </div>
              )}
            </div>
          </div>
        </>
      )}

      <Drawer open={!!editor} title={editor?.mode === 'create' ? '新建拓扑图' : '编辑拓扑信息'}
        sub={editor?.mode === 'create'
          ? '选择地址平面与设备后，系统按链路自动生成树形拓扑'
          : '仅修改名称与说明，设备范围在画布左侧设备池中调整'}
        onClose={() => setEditor(null)}>
        <form onSubmit={e => void saveForm(e)}>
          <div className="field">
            <label>拓扑名称 <b className="req">*</b></label>
            <input value={form.name} maxLength={60} placeholder="例如 园区核心拓扑"
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
          </div>
          <div className="field">
            <label>说明</label>
            <textarea value={form.description} maxLength={500} placeholder="用途、范围备注（选填）"
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
          </div>
          {editor?.mode === 'create' && (
            <>
              <div className="form-grid">
                <div className="field">
                  <label>所属 VRF 地址平面</label>
                  <select value={form.vrf}
                    onChange={e => { const v = e.target.value; void loadCatalog(v, true) }}>
                    {(list?.vrfs ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label>根设备</label>
                  <select value={form.root_mode === 'manual' ? form.root_device_id : ''}
                    onChange={e => setForm(f => ({
                      ...f,
                      root_mode: e.target.value ? 'manual' : 'auto',
                      root_device_id: e.target.value,
                    }))}>
                    <option value="">自动 · 连接度最高</option>
                    {(catalog?.items ?? []).filter(d => form.device_ids.includes(d.id))
                      .map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                </div>
              </div>
              <div className="field">
                <label>纳入设备（{form.device_ids.length} / {catalog?.items.length ?? 0}）</label>
                <div className="topo-picker">
                  {catalogGroups.map(([group, devices]) => (
                    <div key={group} className="topo-picker-group">
                      <div className="topo-picker-title">{group}</div>
                      {devices.map(device => {
                        const checked = form.device_ids.includes(device.id)
                        return (
                          <label key={device.id} className="topo-picker-row">
                            <input type="checkbox" checked={checked}
                              onChange={() => setForm(f => ({
                                ...f,
                                device_ids: checked
                                  ? f.device_ids.filter(id => id !== device.id)
                                  : [...f.device_ids, device.id],
                              }))} />
                            <span>{device.name}</span>
                            <small>{ROLE_LABEL[device.role] ?? device.role}</small>
                          </label>
                        )
                      })}
                    </div>
                  ))}
                  {!catalog?.items.length && <div className="help">该平面暂无设备，可稍后在画布设备池中补充。</div>}
                </div>
                <div className="help">
                  同一张拓扑只包含一个 VRF 平面的设备；连线取自链路清单，两端都在图中才会显示。
                </div>
              </div>
            </>
          )}
          <div className="drawer-actions">
            <button type="button" className="btn" onClick={() => setEditor(null)}>取消</button>
            <button type="submit" className="btn primary" disabled={busy}>
              {editor?.mode === 'create' ? '创建并生成拓扑' : '保存'}
            </button>
          </div>
        </form>
      </Drawer>
    </div>
  )
}

function Prop({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="topo-prop-row">
      <span>{label}</span>
      <b title={String(value)}>{value}</b>
    </div>
  )
}
