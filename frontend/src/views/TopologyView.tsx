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

/** 所有节点的实际包围盒（含被手动拖到自动画布之外的固定节点，坐标可能为负）。 */
function contentBounds(nodes: TopologyNode[], canvas: { width: number; height: number }) {
  if (!nodes.length) return { minX: 0, minY: 0, maxX: canvas.width, maxY: canvas.height }
  return {
    minX: Math.min(...nodes.map(n => n.x - NODE_W / 2)),
    minY: Math.min(...nodes.map(n => n.y)),
    maxX: Math.max(...nodes.map(n => n.x + NODE_W / 2)),
    maxY: Math.max(...nodes.map(n => n.y + NODE_H)),
  }
}

/** 按容器宽高比生成等比 viewBox，使包围盒内容居中且完整可见（不裁切、不留半边空白）。 */
function fitViewport(nodes: TopologyNode[], canvas: { width: number; height: number },
  cw: number, ch: number) {
  const b = contentBounds(nodes, canvas)
  const pad = 64
  const bw = Math.max(1, b.maxX - b.minX) + pad * 2
  const bh = Math.max(1, b.maxY - b.minY) + pad * 2
  const w0 = Math.max(1, cw), h0 = Math.max(1, ch)
  const scale = Math.max(bw / w0, bh / h0)
  const w = w0 * scale, h = h0 * scale
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2
  return { x: cx - w / 2, y: cy - h / 2, w, h }
}

/** 拖动节点时，与另一节点对齐位置相差不到 7 屏幕像素就自动吸附。 */
const SNAP_PX = 7
type Guides = { vx: number | null; hy: number | null }

/**
 * 所有节点尺寸一致（NODE_W × NODE_H），因此比较中心 x / 顶部 y 就等价于
 * 左 / 右 / 水平居中与垂直居中对齐。返回需要吸附到的坐标，
 * 同时用来画贯穿画布的参考线；没有任何接近的邻居时两个值都为 null。
 */
function computeGuides(nodes: TopologyNode[], dragId: string, x: number, y: number,
  threshold: number): Guides {
  let vx: number | null = null, hy: number | null = null
  let bestX = threshold, bestY = threshold
  for (const n of nodes) {
    if (n.id === dragId) continue
    const dx = Math.abs(n.x - x)
    if (dx <= bestX) { bestX = dx; vx = n.x }
    const dy = Math.abs(n.y - y)
    if (dy <= bestY) { bestY = dy; hy = n.y }
  }
  return { vx, hy }
}

/** 导出用的纯静态 SVG：不依赖页面样式，下载后可直接打开或贴进文档。 */
function buildExportSvg(detail: TopologyDetail, nodes: TopologyNode[]) {
  // 固定节点可被拖到自动画布左侧 / 上方，用包围盒整体平移避免导出时被裁掉。
  const b = contentBounds(nodes, detail.canvas)
  const ox = Math.round(-b.minX + 40)
  const oy = Math.round(-b.minY + 60)
  const width = Math.ceil(b.maxX - b.minX + 80)
  const height = Math.ceil(b.maxY - b.minY + 100)
  const byId = new Map(nodes.map(n => [n.id, n]))
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="100%" height="100%" fill="#FFFFFF"/>`,
    `<text x="24" y="34" font-size="16" fill="#1B2430">${escapeXml(detail.name)}</text>`,
    `<text x="24" y="54" font-size="11" fill="#5B6879">VRF ${escapeXml(detail.vrf)} · ${nodes.length} 台设备 · ${detail.edges.length} 条链路</text>`,
    `<g transform="translate(${ox},${oy})">`,
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
    const fill = n.is_root ? '#B5D4F4' : '#E6F1FB'
    const border = n.is_root ? '#185FA5' : '#85B7EB'
    out.push(`<rect x="${x}" y="${n.y}" width="${NODE_W}" height="${NODE_H}" rx="8" fill="${fill}" stroke="${border}"/>`)
    out.push(`<text x="${x + 10}" y="${n.y + 19}" font-size="12" fill="#1B2430">${escapeXml(n.name)}</text>`)
    out.push(`<text x="${x + 10}" y="${n.y + 35}" font-size="10" fill="#5B6879">${escapeXml(ROLE_LABEL[n.role] ?? n.role)}</text>`)
    if (n.pinned) out.push(`<circle cx="${x + NODE_W - 12}" cy="${n.y + 34}" r="3.5" fill="#BA7517"/>`)
  }
  out.push('</g>')
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

/**
 * 编辑页可能开在另一个 web 标签里。写操作完成后广播一次，
 * 让原标签的只读展示页 / 列表页同步刷新，避免关掉编辑标签后看到的还是旧坐标。
 * 每个标签复用同一个常驻 channel：既保证 postMessage 后消息能投递完
 * （不会被 close 掐断），又因「同一对象不回投给自己」而不会让编辑页重复刷新。
 */
let topoChangeChannel: BroadcastChannel | null = null
function topoChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null
  try {
    if (!topoChangeChannel) topoChangeChannel = new BroadcastChannel('ipam-topology')
    return topoChangeChannel
  } catch { return null }
}
function broadcastTopologyChange(id: string) {
  topoChannel()?.postMessage({ type: 'topology-updated', id })
}

/** 拓扑功能：列表 → 只读展示页（自动适应缩放）→ 新标签全屏编辑页。数据与坐标均由后端持久化。 */
export default function TopologyView({ notify, onChanged, refreshKey, onNavigate,
  topologyId = null, editMode = false, fullscreen = false,
  onOpenTopology, onCloseTopology }: ViewProps & {
  onNavigate?: (view: View) => void
  /** 由 App 的 hash 路由驱动：null 为列表，非空为对应拓扑的二级页面 */
  topologyId?: string | null
  editMode?: boolean
  /** 编辑页是否处于新标签的全屏大画幅模式（由 App 依据 /edit 路由判定） */
  fullscreen?: boolean
  onOpenTopology?: (id: string) => void
  onCloseTopology?: () => void
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
  const [confirmRelayout, setConfirmRelayout] = useState(false)
  // 加载完成 / 编辑完成后触发一次自动适应；不监听 nodes，避免拖动时反复重置视图
  const [fitTick, setFitTick] = useState(0)
  // 拖空白处平移画布；拖节点靠近其它节点时显示对齐参考线并吸附
  const [panning, setPanning] = useState(false)
  const [guides, setGuides] = useState<Guides | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const dragRef = useRef<{ id: string; dx: number; dy: number; moved: boolean } | null>(null)
  // 固定的「按下瞬间」坐标变换：pan 过程中 viewBox 会变，不能用实时 CTM 换算，否则抖动
  const panRef = useRef<{
    inverse: DOMMatrix; ox: number; oy: number
    vx: number; vy: number; moved: boolean
  } | null>(null)

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

  /** autoFit=false 用于编辑过程中的保存：数据照常刷新，但视图不跳，避免拖动后画面重排。 */
  const loadDetail = useCallback(async (id: string, autoFit = true) => {
    setBusy(true)
    try {
      const next = await api.topology(id)
      setDetail(next)
      setNodes(next.nodes.map(n => ({ ...n })))
      setSelection(null)
      setConfirmRelayout(false)
      // 数据到位后触发一次自动适应（effect 里等 DOM 渲染完再量容器尺寸）
      if (autoFit) setFitTick(t => t + 1)
      return next
    } catch (err) {
      notify(String(err), 'error')
      return null
    } finally {
      setBusy(false)
    }
  }, [notify])

  // hash 路由是详情数据来源：#topology/<id> 与 #topology/<id>/edit 共用同一份详情。
  // 只有「首次打开 / 换一张拓扑 / 页面刷新恢复」才自动适应；顶栏刷新与编辑保存保持当前缩放。
  const loadedIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (topologyId) {
      const fresh = loadedIdRef.current !== topologyId
      loadedIdRef.current = topologyId
      void loadDetail(topologyId, fresh)
    } else {
      loadedIdRef.current = null
      setDetail(null)
      setNodes([])
      setSelection(null)
      setConfirmRelayout(false)
    }
  }, [topologyId, refreshKey, loadDetail])

  // 打开 / 刷新 / 编辑完成后按「所有节点实际坐标」自动适应画布，完整显示被拖出去的节点。
  // 双 rAF 等 SVG 挂载并拿到真实尺寸；只依赖 fitTick，拖动节点不会反复重置视图。
  useEffect(() => {
    if (!fitTick || !detail) return
    let second = 0
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => {
        const rect = svgRef.current?.getBoundingClientRect()
        const cw = rect && rect.width > 1 ? rect.width : 900
        const ch = rect && rect.height > 1 ? rect.height : 560
        setViewport(fitViewport(nodes, detail.canvas, cw, ch))
      })
    })
    return () => {
      window.cancelAnimationFrame(first)
      if (second) window.cancelAnimationFrame(second)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitTick])

  const canEdit = Boolean(isAdmin && detail?.writable)
  // 编辑页形态由 hash 路由决定；只读账号 / 跨平面汇总视图即使拿到 /edit 链接也保持只读
  const isEdit = Boolean(editMode && canEdit)

  // 编辑标签里的写操作完成后，同步刷新其它标签的只读展示页 / 列表页。
  // 只读详情页重新取数并自动 fit，才能按编辑后的新坐标完整显示；编辑态保持当前视图不跳。
  // 复用单例 channel：postMessage 不会回投给同一对象，故编辑页自己不会重复取数。
  useEffect(() => {
    const ch = topoChannel()
    if (!ch) return
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; id?: string } | null
      if (data?.type !== 'topology-updated') return
      if (topologyId && topologyId === data.id) void loadDetail(topologyId, !editMode)
      else if (!topologyId) void loadList()
    }
    ch.addEventListener('message', onMessage)
    return () => ch.removeEventListener('message', onMessage)
  }, [editMode, topologyId, loadDetail, loadList])

  const backToList = () => {
    setDetail(null)
    setNodes([])
    setSelection(null)
    setConfirmRelayout(false)
    onCloseTopology?.()
  }
  const openTopology = (id: string) => {
    if (onOpenTopology) onOpenTopology(id)
    else void loadDetail(id)
  }
  /**
   * 「编辑」在新 web 标签打开 /#topology/<id>/edit，该路由下 App 会切到全屏大画幅。
   * 浏览器拦截弹窗时退化为改写当前标签 hash，功能不丢，同样进入全屏编辑。
   */
  const enterEdit = (id: string) => {
    const url = new URL(window.location.href)
    url.hash = `#topology/${encodeURIComponent(id)}/edit`
    const win = window.open(url.toString(), '_blank')
    if (win) { win.focus(); return }
    window.location.hash = `#topology/${encodeURIComponent(id)}/edit`
  }
  /**
   * 完成编辑：广播让原标签的只读视图按新坐标刷新并自动适应，再关闭这个编辑标签。
   * 直接访问 /edit（非脚本打开）时浏览器可能不允许 close，降级为在本标签回只读页。
   */
  const finishEdit = () => {
    if (!detail) return
    const id = detail.id
    setConfirmRelayout(false)
    broadcastTopologyChange(id)
    if (fullscreen) {
      try { window.close() } catch { /* 忽略 */ }
      window.setTimeout(() => {
        if (window.closed) return
        void loadDetail(id)
        if (onOpenTopology) onOpenTopology(id)
        notify('已完成编辑，返回只读视图')
      }, 160)
      return
    }
    void loadDetail(id)
    if (onOpenTopology) onOpenTopology(id)
    notify('已完成编辑，返回只读视图')
  }

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
        broadcastTopologyChange(created.id)
        await loadList()
        // 创建后进入只读展示页，需要调整再点「编辑」
        openTopology(created.id)
        notify('拓扑图已创建并自动生成树形布局')
      } else if (editor?.id) {
        await api.updateTopology(editor.id, {
          name: form.name.trim(), description: form.description.trim(),
        })
        setEditor(null)
        broadcastTopologyChange(editor.id)
        await loadList()
        if (detail?.id === editor.id) await loadDetail(editor.id, false)
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
      if (detail?.id === item.id) backToList()
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
      broadcastTopologyChange(detail.id)
      await loadDetail(detail.id, false)
      await loadList()
      onChanged()
      notify(message)
    } catch (err) { notify(String(err), 'error') }
    finally { setBusy(false) }
  }

  /** 重新布局前先确认，避免误触立即清掉手动固定的坐标。 */
  const runRelayout = () => {
    if (!detail || !isEdit) return
    const id = detail.id
    setConfirmRelayout(false)
    void exec(() => api.relayoutTopology(id), '已恢复自动树形布局')
  }

  const toggleDevice = (id: string) => {
    if (!detail || !isEdit) return
    const current = nodes.map(n => n.id)
    const next = current.includes(id) ? current.filter(x => x !== id) : [...current, id]
    void exec(() => api.updateTopology(detail.id, { device_ids: next }), '设备范围已更新')
  }

  const changeRoot = (value: string) => {
    if (!detail || !isEdit) return
    const payload: TopologyPayload = value
      ? { root_mode: 'manual', root_device_id: value }
      : { root_mode: 'auto', root_device_id: null }
    void exec(() => api.updateTopology(detail.id, payload), '根节点已更新，树形布局已重排')
  }

  /** client 坐标 → SVG 用户坐标。pan 时传按下瞬间固定的逆矩阵，避免 viewBox 变化引起抖动。 */
  const toSvgPoint = (e: { clientX: number; clientY: number }, inverse?: DOMMatrix) => {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    let m = inverse
    if (!m) {
      const ctm = svg.getScreenCTM()
      if (!ctm) return { x: 0, y: 0 }
      m = ctm.inverse()
    }
    const pt = svg.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const p = pt.matrixTransform(m)
    return { x: p.x, y: p.y }
  }

  /** 在画布空白处按下：平移 viewBox（只读页同样可用，不改动任何节点坐标、不写库）。 */
  const onCanvasDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    const target = e.target as Element
    // 点在节点 / 连线上时交给它们各自的交互，不启动画布平移
    if (target.closest('.topo-node') || target.closest('.topo-edge')) return
    const svg = svgRef.current
    const ctm = svg?.getScreenCTM()
    if (!svg || !ctm) return
    const inverse = ctm.inverse()
    const p = toSvgPoint(e, inverse)
    panRef.current = {
      inverse, ox: p.x, oy: p.y,
      vx: viewport.x, vy: viewport.y, moved: false,
    }
    setPanning(true)
    setGuides(null)
    svg.setPointerCapture(e.pointerId)
  }

  const onNodeDown = (e: ReactPointerEvent<SVGGElement>, node: TopologyNode) => {
    // 阻止冒泡到画布，避免点节点时同时启动平移
    e.stopPropagation()
    setSelection({ type: 'node', id: node.id })
    // 只读展示页只允许点选，永远不启动拖动
    if (!isEdit) return
    e.preventDefault()
    const p = toSvgPoint(e)
    dragRef.current = { id: node.id, dx: p.x - node.x, dy: p.y - node.y, moved: false }
    svgRef.current?.setPointerCapture(e.pointerId)
  }

  const onSvgMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current
    if (drag) {
      if (!isEdit) return
      const p = toSvgPoint(e)
      let x = Math.round((p.x - drag.dx) * 10) / 10
      let y = Math.round((p.y - drag.dy) * 10) / 10
      // 7 屏幕像素内靠近其它节点 → 吸附到对齐坐标并给出贯穿画布的辅助线
      const rect = svgRef.current?.getBoundingClientRect()
      const unit = viewport.w / (rect && rect.width > 1 ? rect.width : 900)
      const g = computeGuides(nodes, drag.id, x, y, SNAP_PX * unit)
      if (g.vx !== null) x = g.vx
      if (g.hy !== null) y = g.hy
      drag.moved = true
      setGuides(g.vx !== null || g.hy !== null ? g : null)
      setNodes(prev => prev.map(n => n.id === drag.id ? { ...n, x, y } : n))
      return
    }
    const pan = panRef.current
    if (!pan) return
    // 用按下瞬间的固定矩阵换算位移：viewBox 变化不会反过来影响计算结果
    const p = toSvgPoint(e, pan.inverse)
    const dx = p.x - pan.ox, dy = p.y - pan.oy
    if (!pan.moved && Math.abs(dx) + Math.abs(dy) < 0.5) return
    pan.moved = true
    setViewport(v => ({ ...v, x: pan.vx - dx, y: pan.vy - dy }))
  }

  const onSvgUp = async (e: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current
    dragRef.current = null
    panRef.current = null
    setPanning(false)
    setGuides(null)
    try { svgRef.current?.releasePointerCapture(e.pointerId) } catch { /* 忽略 */ }
    if (!isEdit || !drag || !drag.moved || !detail) return
    const moved = nodes.find(n => n.id === drag.id)
    if (!moved) return
    try {
      await api.saveTopologyLayout(detail.id,
        [{ device_id: moved.id, x: moved.x, y: moved.y }])
      broadcastTopologyChange(detail.id)
      onChanged()
      await loadDetail(detail.id, false)
      notify('节点位置已保存')
    } catch (err) {
      notify(String(err), 'error')
      await loadDetail(detail.id, false)
    }
  }

  const zoom = (factor: number) => setViewport(v => {
    // 自动适应后的 viewBox 可能远大于旧的 4000 上限（节点被拖得很远时要完整显示）
    const w = Math.min(20000, Math.max(120, v.w * factor))
    const ratio = w / v.w
    const cx = v.x + v.w / 2
    const cy = v.y + v.h / 2
    return { x: cx - (v.w * ratio) / 2, y: cy - (v.h * ratio) / 2,
             w, h: v.h * ratio }
  })

  /** 「适应画布」与自动适应共用同一算法：按全部节点实际坐标等比居中。 */
  const fitView = () => {
    if (!detail) return
    const rect = svgRef.current?.getBoundingClientRect()
    const cw = rect && rect.width > 1 ? rect.width : 900
    const ch = rect && rect.height > 1 ? rect.height : 560
    setViewport(fitViewport(nodes, detail.canvas, cw, ch))
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
                      <button className="btn sm" onClick={() => openTopology(item.id)}>打开 ›</button>
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
          {isEdit && (
            <div className="topo-crumbs">
              <button className="topo-crumb" onClick={backToList}>网络拓扑</button>
              <span>›</span>
              <button className="topo-crumb" onClick={() => openTopology(detail.id)}>{detail.name}</button>
              <span>›</span>
              <b>编辑画布</b>
              <span className="spacer" />
              <span className="topo-crumb-hash" title={`#topology/${detail.id}/edit`}>#topology/…/edit</span>
            </div>
          )}
          <div className="topo-toolbar">
            <button className="btn sm" onClick={backToList}>
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
            {isEdit ? (
              <>
                <button className="btn sm" disabled={busy}
                  onClick={() => setConfirmRelayout(true)}>重新布局</button>
                <button className="btn sm primary" onClick={finishEdit}>
                  <Icon name="check" size={13} />完成编辑</button>
              </>
            ) : (
              <button className="btn sm primary" id="topology-edit" disabled={!canEdit || busy}
                title={canEdit ? '在新标签页打开全屏编辑画布，调整设备范围、根节点与节点位置'
                  : (planeNote || '当前账号或地址平面不可编辑')}
                onClick={() => enterEdit(detail.id)}>
                <Icon name="edit" size={13} />编辑</button>
            )}
          </div>

          {isEdit && confirmRelayout && (
            <div className="readonly-banner topo-relayout-confirm">
              <Icon name="info" size={14} />
              <span>
                <b>确认重新布局？</b>
                {detail.stats.pinned
                  ? ` 将清除 ${detail.stats.pinned} 个手动固定的坐标，所有节点恢复自动树形布局，且不可撤销。`
                  : ' 所有节点将按当前链路重新生成自动树形布局。'}
              </span>
              <button className="btn sm" onClick={() => setConfirmRelayout(false)}>取消</button>
              <button className="btn sm primary" disabled={!isEdit || busy}
                onClick={runRelayout}>确认重新布局</button>
            </div>
          )}

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
                      <button key={device.id}
                        className={`topo-device-row${checked ? ' on' : ''}${isEdit ? '' : ' static'}`}
                        disabled={!isEdit || busy}
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
              <div className="topo-side-foot">
                {isEdit ? '连线来自链路清单，增删设备后自动重排'
                  : '连线来自链路清单，自动重排'}
              </div>
            </div>

            <div className="topo-canvas">
              <svg ref={svgRef} className="topo-svg" width="100%" height="100%"
                viewBox={`${viewport.x} ${viewport.y} ${viewport.w} ${viewport.h}`}
                style={{ cursor: panning ? 'grabbing' : 'grab' }}
                onPointerDown={onCanvasDown}
                onPointerMove={onSvgMove}
                onPointerUp={e => void onSvgUp(e)}
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
                {/* 拖动节点时的对齐辅助线：用 non-scaling-stroke 保证任何缩放下都是 1px 虚线 */}
                {guides && (
                  <g pointerEvents="none">
                    {guides.vx !== null && (
                      <line x1={guides.vx} y1={viewport.y} x2={guides.vx}
                        y2={viewport.y + viewport.h}
                        stroke="#0F6E56" strokeWidth={1} strokeDasharray="5 4"
                        strokeOpacity={0.9} vectorEffect="non-scaling-stroke" />
                    )}
                    {guides.hy !== null && (
                      <line x1={viewport.x} y1={guides.hy + NODE_H / 2}
                        x2={viewport.x + viewport.w} y2={guides.hy + NODE_H / 2}
                        stroke="#0F6E56" strokeWidth={1} strokeDasharray="5 4"
                        strokeOpacity={0.9} vectorEffect="non-scaling-stroke" />
                    )}
                  </g>
                )}
                {nodes.map(node => {
                  const active = selection?.type === 'node' && selection.id === node.id
                  const fill = node.is_root ? '#B5D4F4' : '#E6F1FB'
                  const border = active ? '#0C447C' : node.is_root ? '#185FA5' : '#85B7EB'
                  return (
                    <g key={node.id} transform={`translate(${node.x - NODE_W / 2},${node.y})`}
                      className="topo-node" onPointerDown={e => onNodeDown(e, node)}
                      style={{ cursor: isEdit ? 'grab' : 'pointer' }}>
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
                {isEdit
                  ? '拖空白处平移画布 · 拖节点调整位置，靠近其它节点自动吸附对齐，松手保存'
                  : '只读视图：拖空白处可平移画布，点选节点 / 连线查看属性'}
              </div>
            </div>

            <div className="topo-side topo-props">
              <div className="topo-side-head"><b>属性</b><span>{detail.vrf}</span></div>
              <div className="field">
                <label>根节点</label>
                {isEdit ? (
                  <select value={detail.root_mode === 'manual' ? (detail.root_device_id ?? '') : ''}
                    disabled={busy} onChange={e => changeRoot(e.target.value)}>
                    <option value="">自动 · 连接度最高</option>
                    {nodes.map(n => <option key={n.id} value={n.id}>{n.name}</option>)}
                  </select>
                ) : (
                  <div className="topo-readonly-value">
                    {detail.root_mode === 'manual'
                      ? (nodeMap.get(detail.root_device_id ?? '')?.name ?? detail.root_device_id ?? '手动指定')
                      : `自动 · ${nodeMap.get(detail.resolved_root ?? '')?.name ?? '连接度最高'}`}
                  </div>
                )}
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
                    {isEdit
                      ? '未拖动的节点始终跟随链路变化自动重排；拖过的节点保持固定，点「重新布局」可全部复位。'
                      : '未拖动的节点始终跟随链路变化自动重排；拖过的节点保持固定。'}
                  </div>
                </div>
              )}
              {detail.missing_devices.length > 0 && (
                <div className="help" style={{ color: 'var(--amber-800)', marginTop: 12 }}>
                  有 {detail.missing_devices.length} 台设备已从台账删除，画布中不再显示
                  {isEdit ? '；重新勾选设备范围即可清理' : ''}。
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
