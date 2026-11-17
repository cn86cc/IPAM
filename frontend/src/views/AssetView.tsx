import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { api, getApiVrf } from '../api'
import { AdminOnly, useAuth } from '../auth'
import { Card, Drawer, Icon, MiniStat, Tag } from '../components/ui'
import {
  ASSET_ID_PATTERN, ASSET_KIND_LABEL, ASSET_ROLE_LABEL, ASSET_STATUS_LABEL,
  type AssetData, type AssetKind, type AssetOption, type AssetPayload,
  type AssetRow, type View,
} from '../types'
import { csvDownload, useLoad, type ViewProps } from './shared'

type FieldType = 'text' | 'number' | 'select' | 'textarea' | 'urange'

type Choice = { value: string; label: string }

interface FieldDef {
  key: string
  label: string
  type?: FieldType
  choices?: Choice[]
  source?: 'locations' | 'racks' | 'devices' | 'vrfs' | 'roles'
  placeholder?: string
  full?: boolean
  defaultValue?: string | number
  help?: string
  /** 把数据中已经出现过的值（含历史 / 停用角色）并入候选项 */
  dynamic?: boolean
  labelMap?: Record<string, string>
}

interface ColumnDef {
  key: string
  label: string
  render: (row: AssetRow) => ReactNode
  text: (row: AssetRow) => string | number
}

interface KindConfig {
  fields: FieldDef[]
  columns: ColumnDef[]
  stats: { key: string; label: string; foot: string; tone?: 'red' | 'amber' | 'teal' | 'blue' }[]
  filter: { key: string; label: string; choices: Choice[]; dynamic?: boolean
    source?: 'roles'; labelMap?: Record<string, string> }
  idHint: string
  idExample: string
}

const CHOICES = {
  role: Object.entries(ASSET_ROLE_LABEL).map(([value, label]) => ({ value, label })),
  deviceStatus: [{ value: 'online', label: '在线' }, { value: 'offline', label: '离线' },
    { value: 'maintenance', label: '维护中' }],
  rackStatus: [{ value: 'active', label: '在用' }, { value: 'planned', label: '规划中' },
    { value: 'retired', label: '已退役' }],
  linkStatus: [{ value: 'up', label: '已连通' }, { value: 'down', label: '中断' },
    { value: 'planned', label: '规划中' }],
  linkKind: [{ value: 'trunk', label: 'Trunk' }, { value: 'access', label: 'Access' },
    { value: 'uplink', label: '上联' }, { value: 'stack', label: '堆叠' },
    { value: 'wan', label: '广域网' }],
  locationKind: [{ value: 'campus', label: '园区' }, { value: 'building', label: '楼宇' },
    { value: 'floor', label: '楼层' }, { value: 'room', label: '机房' }],
}

function toneOf(value?: string): 'red' | 'amber' | 'teal' | 'blue' | 'neutral' {
  if (value === 'online' || value === 'up' || value === 'active') return 'teal'
  if (value === 'offline' || value === 'down') return 'red'
  if (value === 'maintenance' || value === 'planned' || value === 'retired') return 'amber'
  return 'blue'
}

function statusLabel(row: AssetRow): string {
  const key = row.kind === 'campus' || row.kind === 'building' || row.kind === 'floor'
    || row.kind === 'room' ? row.kind : (row.status || '')
  return ASSET_STATUS_LABEL[key] ?? key ?? '—'
}

const text = (v: unknown) => (v === null || v === undefined ? '' : String(v))
const mono = (v: unknown) => <span className="mono">{text(v) || '—'}</span>
const statusTag = (row: AssetRow) => (
  <Tag text={statusLabel(row)} tone={toneOf(row.status)} />
)

/* ---------------- 多 U 设备：范围文本 + 高度下拉联动 ---------------- */

/** 与后端 assets.MAX_U_HEIGHT 保持一致：单个设备最多连续占用 60U。 */
export const MAX_U_HEIGHT = 60

/** '38' → null；'38-40' / '40~38' → { start:38, height:3 }。 */
export function parseURange(raw: unknown): { start: number; height: number } | null {
  const m = /^(\d+)\s*[-~]\s*(\d+)$/.exec(text(raw).trim())
  if (!m) return null
  const a = Number(m[1]), b = Number(m[2])
  return { start: Math.min(a, b), height: Math.abs(b - a) + 1 }
}

/** 高度下拉常规只给 1–12U；范围文本推导出更大高度时补一个展示项，
 * 否则受控 select 的 value 没有匹配 option，会显示成空白。 */
export function uHeightExtraOption(current: unknown): Choice | null {
  const h = Math.max(1, Math.min(MAX_U_HEIGHT, Number(text(current)) || 1))
  return h > 12 ? { value: String(h), label: `${h} U（范围输入）` } : null
}

/** 设备行的 U 位展示文案：1U 显示 U38，多 U 显示 U38–U40。 */
export function uDisplay(row: AssetRow): string {
  const s = Number(row.rack_u)
  if (!Number.isInteger(s) || s < 1) return '—'
  const h = Math.max(1, Number(row.u_height) || 1)
  return h > 1 ? `U${s}–U${s + h - 1}` : `U${s}`
}

/** 从表单推导占用区间：范围文本优先，其次「单数字 + 高度下拉」。 */
export function uSpanOf(form: AssetPayload): {
  start: number | null; height: number; end: number | null
  label: string; error: string
} {
  const height = Math.max(1, Math.min(MAX_U_HEIGHT, Number(form.u_height) || 1))
  const raw = text(form.rack_u).trim()
  const range = parseURange(raw)
  let start: number | null = null
  if (range) start = range.start
  else if (/^\d+$/.test(raw)) start = Number(raw)
  else if (raw) {
    return { start: null, height, end: null, label: '—',
      error: 'U 位需填 38 或 38-40 这样的数字 / 连续范围' }
  }
  const h = range ? range.height : height
  if (h > MAX_U_HEIGHT) {
    return { start, height: h, end: null, label: '—',
      error: `占用高度需在 1–${MAX_U_HEIGHT} U 之间` }
  }
  if (start !== null && start < 1) {
    return { start, height: h, end: null, label: '—',
      error: 'U 位需从 1 开始' }
  }
  const end = start === null ? null : start + h - 1
  return { start, height: h, end,
    label: start === null ? '未上架' : (h > 1 ? `U${start}–U${end}` : `U${start}`),
    error: '' }
}

/** U 位文本与高度下拉联动。
 *
 * 关键约束：rack_u 是受控输入，**输入过程中的每一个中间态都必须原样保留**。
 * 早期版本在每个 onChange 里就把 '38-4' / '42-4' 归一成 '4-38' / '4-42'，
 * 受控 input 的 value 被改写后光标与后续字符串位，用户逐字符输入
 * '38-40' 会得到 '4-380'、输入 '42-44' 会得到 '4-424'，范围根本没法手动填。
 * 因此这里只同步「高度下拉」用于展示；范围文本本身始终以用户输入为准
 * （uSpanOf 范围优先，文本即最终区间）。只有用户主动操作高度下拉时，
 * 才反向把文本展开成规范范围。 */
export function linkUField(form: AssetPayload, key: 'rack_u' | 'u_height',
  value: string): AssetPayload {
  if (key === 'rack_u') {
    const r = parseURange(value)
    return { ...form, rack_u: value,
      u_height: r ? Math.max(1, Math.min(MAX_U_HEIGHT, r.height)) : 1 }
  }
  const h = Math.max(1, Math.min(MAX_U_HEIGHT, Number(value) || 1))
  const next: AssetPayload = { ...form, u_height: h }
  const r = parseURange(form.rack_u)
  if (r) next.rack_u = `${r.start}-${r.start + h - 1}`
  else if (/^\d+$/.test(text(form.rack_u).trim())) {
    const s = Number(text(form.rack_u).trim())
    next.rack_u = h > 1 ? `${s}-${s + h - 1}` : String(s)
  }
  return next
}

/** 同机柜内的区间重叠检查，用于表单实时提示（不含自身）。 */
export function uClash(form: AssetPayload, rows: AssetRow[], excludeId?: string,
  rackId?: string): string {
  const s = uSpanOf(form)
  if (s.error || s.start === null || s.end === null) return ''
  for (const r of rows) {
    if (r.id === excludeId) continue
    if (rackId && r.rack_id !== rackId) continue
    const rs = Number(r.rack_u)
    if (!Number.isInteger(rs) || rs < 1) continue
    const rh = Math.max(1, Number(r.u_height) || 1)
    const re = rs + rh - 1
    if (!(s.end < rs || s.start > re)) {
      return `与设备 ${r.name || r.id}（${rh > 1 ? `U${rs}–U${re}` : `U${rs}`}）重叠`
    }
  }
  return ''
}

/** 表单 U 位区域下方的实时占用预览 / 冲突提示。 */
export function URangePreview({ form, units, rows, excludeId, rackId }: {
  form: AssetPayload; units?: number; rows?: AssetRow[]
  excludeId?: string; rackId?: string
}) {
  const s = uSpanOf(form)
  // 三个分支统一 id，便于自动化与一致性断言；错误态此前漏了 id，导致
  // 「格式错误 / 高度超限」提示无法被定位。
  if (s.error) return <div className="u-range-preview bad" id="asset-u-preview">{s.error}</div>
  if (s.start === null) {
    return <div className="u-range-preview muted" id="asset-u-preview">未上架 · 不占用 U 位</div>
  }
  const bad = (units && s.end && s.end > units)
    ? `超出机柜容量 1–${units} U`
    : uClash(form, rows ?? [], excludeId, rackId)
  return (
    <div className={`u-range-preview ${bad ? 'bad' : 'ok'}`} id="asset-u-preview">
      {bad ? `⚠ ${bad}` : `✓ 占用 ${s.label} · ${s.height}U，空间可用`}
    </div>
  )
}

const U_HEIGHT_CHOICES: Choice[] = Array.from({ length: 12 }, (_, i) => ({
  value: String(i + 1), label: `${i + 1} U`,
}))

export const CONFIG: Record<AssetKind, KindConfig> = {
  devices: {
    idHint: '设备编号', idExample: 'DEV-0013',
    stats: [
      { key: 'total', label: '设备总数', foot: '纳入资产台账', tone: 'blue' },
      { key: 'online', label: '在线设备', foot: '状态为在线', tone: 'teal' },
      { key: 'maintenance', label: '维护中', foot: '含离线与待上架', tone: 'amber' },
      { key: 'with_ip', label: '已配管理 IP', foot: '关联地址空间树' },
    ],
    filter: { key: 'role', label: '角色', choices: CHOICES.role,
      source: 'roles', dynamic: true, labelMap: ASSET_ROLE_LABEL },
    fields: [
      { key: 'name', label: '设备名称', placeholder: '例如 core-sw-03' },
      { key: 'role', label: '角色', type: 'select', choices: CHOICES.role,
        source: 'roles', defaultValue: 'other',
        help: '仅可从角色字典中下拉选择；如需新增角色，请前往「角色」模块。' },
      { key: 'vendor', label: '厂商', placeholder: '例如 Huawei' },
      { key: 'model', label: '型号', placeholder: '例如 CE6881' },
      { key: 'mgmt_ip', label: '管理 IP', placeholder: '例如 10.1.10.6', help: '会自动回查所属前缀与 IPAM 登记状态' },
      { key: 'status', label: '运行状态', type: 'select', choices: CHOICES.deviceStatus, defaultValue: 'online' },
      { key: 'vrf', label: '所属 VRF 地址平面', type: 'select', source: 'vrfs', defaultValue: 'default',
        help: '新建设备默认归属顶栏当前地址平面，不能跨平面登记；如需在其它平面新增设备，请先切换顶栏地址平面。' },
      { key: 'location_id', label: '所属位置', type: 'select', source: 'locations' },
      { key: 'rack_id', label: '所属机柜', type: 'select', source: 'racks' },
      { key: 'rack_u', label: '机柜 U 位', type: 'urange', placeholder: '例如 38 或 38-40',
        help: '可填单个 U 位或连续范围；范围会自动同步下方「占用高度」，也可用高度下拉反向展开范围。' },
      { key: 'u_height', label: '占用高度', type: 'select', choices: U_HEIGHT_CHOICES,
        defaultValue: 1, help: '多 U 设备按连续区间占用，机柜正视图会跨格显示；最多 60U，可直接填范围突破 12U 下拉。' },
      { key: 'owner', label: '负责人 / 团队', placeholder: '例如 网络组 · 赵强' },
      { key: 'note', label: '备注', type: 'textarea', full: true },
    ],
    columns: [
      { key: 'name', label: '设备 / 编号',
        render: r => <div className="asset-primary"><b>{r.name}</b><small className="mono">{r.id}</small></div>,
        text: r => `${r.name} ${r.id}` },
      { key: 'role', label: '角色',
        render: r => <Tag text={ASSET_ROLE_LABEL[r.role || ''] ?? r.role ?? '—'} tone="blue" />,
        text: r => ASSET_ROLE_LABEL[r.role || ''] ?? r.role ?? '' },
      { key: 'mgmt_ip', label: '管理 IP', render: r => mono(r.mgmt_ip), text: r => r.mgmt_ip ?? '' },
      { key: 'prefix_cidr', label: '所属地址段',
        render: r => r.prefix_cidr
          ? <span className="asset-cidr"><Tag text={r.prefix_cidr} tone="neutral" />
            {r.ipam_registered && <Tag text="已登记" tone="teal" />}</span>
          : <span className="muted">—</span>,
        text: r => r.prefix_cidr ?? '' },
      { key: 'location_name', label: '位置', render: r => text(r.location_name) || '—', text: r => r.location_name ?? '' },
      { key: 'rack', label: '机柜 / U 位',
        render: r => r.rack_name && r.rack_name !== '—'
          ? <span>{r.rack_name} <b className="mono">{uDisplay(r)}</b></span>
          : <span className="muted">未上架</span>,
        text: r => r.rack_name && r.rack_name !== '—' ? `${r.rack_name} ${uDisplay(r)}` : '' },
      { key: 'status', label: '状态', render: statusTag, text: r => ASSET_STATUS_LABEL[r.status || ''] ?? r.status ?? '' },
      { key: 'vrf', label: '所属平面', render: r => mono(r.vrf), text: r => r.vrf ?? '' },
    ],
  },
  racks: {
    idHint: '机柜编号', idExample: 'RACK-A3-04',
    stats: [
      { key: 'total', label: '机柜总数', foot: '含规划中机柜', tone: 'blue' },
      { key: 'active', label: '在用机柜', foot: '状态为在用', tone: 'teal' },
      { key: 'used_u', label: '已占用 U 位', foot: '按设备实际占用 U 数累加', tone: 'amber' },
      { key: 'util', label: '整体 U 位利用率', foot: '已用 / 总容量' },
    ],
    filter: { key: 'status', label: '机柜状态', choices: CHOICES.rackStatus },
    fields: [
      { key: 'name', label: '机柜名称', placeholder: '例如 A3 业务柜 04' },
      { key: 'location_id', label: '所属位置', type: 'select', source: 'locations' },
      { key: 'units', label: '机柜容量 (U)', type: 'number', defaultValue: 42 },
      { key: 'power_kw', label: '供电功率 (kW)', type: 'number', defaultValue: 6 },
      { key: 'status', label: '机柜状态', type: 'select', choices: CHOICES.rackStatus, defaultValue: 'active' },
      { key: 'note', label: '备注', type: 'textarea', full: true },
    ],
    columns: [
      { key: 'name', label: '机柜 / 编号',
        render: r => <div className="asset-primary"><b>{r.name}</b><small className="mono">{r.id}</small></div>,
        text: r => `${r.name} ${r.id}` },
      { key: 'location_name', label: '所属位置',
        render: r => <span className="muted">{r.location_name || '—'}</span>, text: r => r.location_name ?? '' },
      { key: 'units', label: '容量', render: r => <b className="mono">{r.units} U</b>, text: r => r.units ?? 0 },
      { key: 'used_u', label: '已用 / 空闲',
        render: r => <span><b className="mono">{r.used_u}</b> / <span className="mono">{r.free_u}</span> U</span>,
        text: r => r.used_u ?? 0 },
      { key: 'util', label: 'U 位占用',
        render: r => <div className="asset-util"><div className="asset-util-track">
          <i style={{ width: `${Math.min(100, r.util || 0)}%` }} /></div><small>{r.util}%</small></div>,
        text: r => `${r.util}%` },
      { key: 'power_kw', label: '供电', render: r => `${r.power_kw} kW`, text: r => `${r.power_kw} kW` },
      { key: 'status', label: '状态', render: statusTag,
        text: r => ASSET_STATUS_LABEL[r.status || ''] ?? r.status ?? '' },
    ],
  },
  links: {
    idHint: '链路编号', idExample: 'LNK-0011',
    stats: [
      { key: 'total', label: '链路总数', foot: '设备端口互联', tone: 'blue' },
      { key: 'up', label: '已连通', foot: '状态为 up', tone: 'teal' },
      { key: 'down', label: '中断', foot: '需排查处理', tone: 'red' },
      { key: 'bandwidth', label: '总带宽 (Gbps)', foot: '所有链路合计' },
    ],
    filter: { key: 'status', label: '链路状态', choices: CHOICES.linkStatus },
    fields: [
      { key: 'name', label: '链路名称', placeholder: '留空自动生成' },
      { key: 'kind', label: '链路类型', type: 'select', choices: CHOICES.linkKind, defaultValue: 'trunk' },
      { key: 'local_device_id', label: '本端设备', type: 'select', source: 'devices' },
      { key: 'local_port', label: '本端端口', placeholder: '例如 Eth1/1' },
      { key: 'remote_device_id', label: '对端设备', type: 'select', source: 'devices' },
      { key: 'remote_port', label: '对端端口', placeholder: '例如 Eth1/2' },
      { key: 'bandwidth_gbps', label: '带宽 (Gbps)', type: 'number', defaultValue: 10 },
      { key: 'vlan', label: 'VLAN', placeholder: '例如 101,102 或留空' },
      { key: 'status', label: '链路状态', type: 'select', choices: CHOICES.linkStatus, defaultValue: 'up' },
      { key: 'note', label: '备注', type: 'textarea', full: true },
    ],
    columns: [
      { key: 'name', label: '链路 / 编号',
        render: r => <div className="asset-primary"><b>{r.name}</b><small className="mono">{r.id}</small></div>,
        text: r => `${r.name} ${r.id}` },
      { key: 'ends', label: '本端 → 对端',
        render: r => <div className="link-ends">
          <span className="link-end"><b>{r.local_device_name}</b><code>{r.local_port}</code></span>
          <span className="link-arrow">→</span>
          <span className="link-end"><b>{r.remote_device_name}</b><code>{r.remote_port}</code></span>
        </div>,
        text: r => `${r.local_device_name}:${r.local_port} → ${r.remote_device_name}:${r.remote_port}` },
      { key: 'kind', label: '类型',
        render: r => <Tag text={ASSET_STATUS_LABEL[r.kind || ''] ?? r.kind ?? '—'} tone="blue" />,
        text: r => ASSET_STATUS_LABEL[r.kind || ''] ?? r.kind ?? '' },
      { key: 'bandwidth_gbps', label: '带宽',
        render: r => <b className="mono">{r.bandwidth_gbps} G</b>, text: r => r.bandwidth_gbps ?? 0 },
      { key: 'vlan', label: 'VLAN', render: r => mono(r.vlan), text: r => r.vlan ?? '' },
      { key: 'status', label: '状态', render: statusTag,
        text: r => ASSET_STATUS_LABEL[r.status || ''] ?? r.status ?? '' },
    ],
  },
  locations: {
    idHint: '位置编号', idExample: 'LOC-A3-R02',
    stats: [
      { key: 'total', label: '位置节点', foot: '园区 / 楼宇 / 楼层 / 机房', tone: 'blue' },
      { key: 'rooms', label: '机房数量', foot: '可承载机柜', tone: 'teal' },
      { key: 'racks', label: '在册机柜', foot: '全部位置合计' },
      { key: 'devices', label: '在册设备', foot: '全部位置合计' },
    ],
    filter: { key: 'kind', label: '位置类型', choices: CHOICES.locationKind },
    fields: [
      { key: 'name', label: '位置名称', placeholder: '例如 核心机房 A3' },
      { key: 'kind', label: '位置类型', type: 'select', choices: CHOICES.locationKind, defaultValue: 'room' },
      { key: 'parent_id', label: '上级位置', type: 'select', source: 'locations', help: '园区为顶级节点，可不填' },
      { key: 'address', label: '详细地址' },
      { key: 'contact', label: '联系人' },
      { key: 'note', label: '备注', type: 'textarea', full: true },
    ],
    columns: [
      { key: 'name', label: '位置层级',
        render: r => <div className="asset-primary"><b>{r.name}</b><small className="mono">{r.id}</small></div>,
        text: r => `${r.path ?? r.name} (${r.id})` },
      { key: 'kind', label: '类型',
        render: r => <Tag text={ASSET_STATUS_LABEL[r.kind || ''] ?? r.kind ?? '—'} tone="blue" />,
        text: r => ASSET_STATUS_LABEL[r.kind || ''] ?? r.kind ?? '' },
      { key: 'path', label: '完整路径',
        render: r => <span className="muted asset-path">{r.path || '—'}</span>, text: r => r.path ?? '' },
      { key: 'child_count', label: '下级', render: r => r.child_count ?? 0, text: r => r.child_count ?? 0 },
      { key: 'rack_count', label: '机柜', render: r => r.rack_count ?? 0, text: r => r.rack_count ?? 0 },
      { key: 'device_count', label: '设备', render: r => r.device_count ?? 0, text: r => r.device_count ?? 0 },
      { key: 'contact', label: '联系人', render: r => text(r.contact) || '—', text: r => r.contact ?? '' },
    ],
  },
}

const QUICK_NAV: { key: View; label: string; icon: string; stat?: 'devices' | 'racks' | 'links' | 'locations' }[] = [
  { key: 'locations', label: '位置', icon: 'network', stat: 'locations' },
  { key: 'racks', label: '机柜', icon: 'database', stat: 'racks' },
  { key: 'devices', label: '设备', icon: 'cpu', stat: 'devices' },
  { key: 'links', label: '链路', icon: 'swap', stat: 'links' },
  { key: 'device_roles', label: '角色', icon: 'tag' },
  { key: 'topology', label: '拓扑', icon: 'network' },
]

export function initialForm(kind: AssetKind, row?: AssetRow): AssetPayload {
  const form: AssetPayload = {}
  for (const field of CONFIG[kind].fields) {
    form[field.key] = row ? (row[field.key] ?? '') as string | number | null
      : (field.defaultValue ?? '')
  }
  // 新建设备默认归属全局当前地址平面（机柜正视图「双击空闲 U 增加设备」也走这里）；
  // 后端 _validate 会复核，跨平面登记一律拒绝。
  if (!row && kind === 'devices') {
    const plane = getApiVrf()
    form.vrf = plane === 'all' ? 'default' : plane
  }
  // 编辑多 U 设备时把 (起始 U, 高度) 还原成「38-40」范围文本，
  // 与表单的范围输入 / 高度下拉联动保持一致。
  if (row && kind === 'devices') {
    const h = Math.max(1, Number(row.u_height) || 1)
    form.u_height = h
    const s = Number(row.rack_u)
    if (Number.isInteger(s) && s > 0 && h > 1) form.rack_u = `${s}-${s + h - 1}`
  }
  return form
}

/** 合并静态选项与数据里已出现的值，让自定义角色也能被复用、筛选。 */
export function mergeChoices(rows: AssetRow[], base: Choice[], key: string,
  labelMap?: Record<string, string>): Choice[] {
  const map = new Map<string, string>()
  base.forEach(c => map.set(c.value, c.label))
  rows.forEach(r => {
    const value = String(r[key] ?? '').trim()
    if (value && !map.has(value)) map.set(value, labelMap?.[value] ?? value)
  })
  return [...map.entries()].map(([value, label]) => ({ value, label }))
}

export function optionChoices(data: AssetData | null, field: FieldDef,
  current = ''): Choice[] {
  // 数据未加载时沿用静态候选，避免下拉先空后闪
  if (!data) return field.choices ?? []
  if (field.source === 'roles') {
    // 角色为纯下拉：只取字典中启用的角色，预置角色显示中文名。
    // 停用 / 历史角色不因「已有设备在用」而回到下拉；仅编辑该设备时补当前值，
    // 保证既有记录打开编辑不会被清空。筛选下拉仍会合并历史值（见 filterChoices）。
    const base: Choice[] = (data.options.roles ?? [])
      .filter(o => o.enabled !== false)
      .map(o => ({ value: o.id, label: ASSET_ROLE_LABEL[o.id] ?? o.name ?? o.id }))
    if (current && !base.some(c => c.value === current)) {
      base.push({ value: current, label: ASSET_ROLE_LABEL[current] ?? current })
    }
    return base
  }
  let base: Choice[]
  if (field.source) {
    const list: AssetOption[] = data.options[field.source] ?? []
    base = list.map(o => ({
      value: o.id,
      label: field.source === 'locations' && o.path ? `${o.name} · ${o.path}` : o.name,
    }))
  } else {
    base = field.choices ?? []
  }
  return field.dynamic ? mergeChoices(data.items, base, field.key, field.labelMap) : base
}

/* ------------------------------- 辅助可视化 ------------------------------- */

function Distribution({ title, rows, total }: {
  title: string
  rows: { label: string; value: number; tone?: string }[]
  total: number
}) {
  return (
    <Card title={title} hint={`共 ${total} 项`}>
      {rows.length === 0 && <div className="empty">暂无数据</div>}
      {rows.map(r => (
        <div className="rank-row" key={r.label}>
          <div className="label"><b>{r.label}</b></div>
          <div className="track"><i style={{ width: `${total ? r.value / total * 100 : 0}%`,
            background: r.tone === 'red' ? 'var(--red)' : r.tone === 'amber'
              ? 'var(--amber-800)' : 'var(--blue)' }} /></div>
          <div className="pct mono">{r.value}</div>
        </div>
      ))}
    </Card>
  )
}

/* --------------------------------- 主视图 --------------------------------- */

export default function AssetView({ kind, notify, onChanged, refreshKey, onNavigate,
  onRackDetail, onLocationDetail, onRenamed }:
  ViewProps & { kind: AssetKind; onNavigate: (v: View) => void;
    onRackDetail?: (id: string | null) => void;
    onLocationDetail?: (id: string | null) => void;
    onRenamed?: (kind: AssetKind, previousId: string, nextId: string) => void }) {
  const { isAdmin, can, vrf: plane } = useAuth()
  const planeWritable = plane !== 'all'
  const cfg = CONFIG[kind]
  // 机柜、位置两类清单都有各自的二级页面，整行可点击
  const hasDetail = kind === 'racks' || kind === 'locations'
  const detailLabel = kind === 'racks' ? '机柜视图' : '位置视图'
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState('all')
  const [vrfFilter, setVrfFilter] = useState('all')
  const [editor, setEditor] = useState<{ mode: 'create' | 'edit'; row?: AssetRow } | null>(null)
  const [form, setForm] = useState<AssetPayload>({})
  const [newId, setNewId] = useState('')
  const [formError, setFormError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  const { data, loading, reload } = useLoad(
    () => Promise.all([api.assets(kind), api.assetOverview()]),
    [kind, refreshKey], notify,
  )
  const [asset, counts] = data ?? [null, null]
  const items = asset?.items ?? []

  useEffect(() => { setVrfFilter('all') }, [kind])

  const filterChoices = useMemo(() => {
    const base: Choice[] = cfg.filter.source === 'roles'
      ? (asset?.options.roles ?? [])
          .filter(o => o.enabled !== false)
          .map(o => ({ value: o.id, label: ASSET_ROLE_LABEL[o.id] ?? o.name ?? o.id }))
      : cfg.filter.choices
    return cfg.filter.dynamic
      ? mergeChoices(items, base, cfg.filter.key, cfg.filter.labelMap)
      : base
  }, [items, asset, cfg])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return items.filter(row => {
      if (filter !== 'all' && String(row[cfg.filter.key] ?? '') !== filter) return false
      if (kind === 'devices' && vrfFilter !== 'all' && String(row.vrf ?? '') !== vrfFilter) return false
      if (!needle) return true
      return [row.id, row.name, row.path, row.mgmt_ip, row.vendor, row.model, row.owner,
        row.role, row.vrf, row.location_name, row.rack_name, row.local_device_name, row.remote_device_name,
        row.prefix_cidr, row.note, row.address, row.contact]
        .some(v => String(v ?? '').toLowerCase().includes(needle))
    })
  }, [items, q, filter, cfg.filter.key, kind, vrfFilter])

  function openDetail(row: AssetRow) {
    if (kind === 'racks') onRackDetail?.(row.id)
    else if (kind === 'locations') onLocationDetail?.(row.id)
  }

  function guardPlaneWrite(): boolean {
    if (kind === 'devices' && !planeWritable) {
      notify('请先从顶栏选定具体的 VRF 地址平面，不能在汇总视图下新增 / 编辑 / 删除设备', 'error')
      return false
    }
    return true
  }

  function openCreate() {
    if (!guardPlaneWrite()) return
    setEditor({ mode: 'create' })
    setForm(initialForm(kind))
    setNewId('')
    setFormError('')
  }

  function openEdit(row: AssetRow) {
    if (!guardPlaneWrite()) return
    setEditor({ mode: 'edit', row })
    setForm(initialForm(kind, row))
    setNewId(row.id)
    setFormError('')
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!editor) return
    const id = newId.trim()
    if (!ASSET_ID_PATTERN.test(id)) {
      setFormError('编号必填，仅支持字母、数字、. _ -，长度 2–48')
      return
    }
    setBusy(true)
    setFormError('')
    try {
      // 编辑态也提交 id：后端在同一事务内改主键并级联同步所有引用。
      const payload: AssetPayload = { id, ...form }
      const res = editor.mode === 'create'
        ? await api.createAsset(kind, payload)
        : await api.updateAsset(kind, editor.row!.id, payload)
      const renamed = editor.mode === 'edit' && res.id !== editor.row!.id
      const label = ASSET_KIND_LABEL[kind]
      const verb = editor.mode === 'create' ? '已新建' : '已更新'
      const name = String(form.name || editor.row?.name || '')
      notify(`${label} ${verb}：${name}${renamed ? `（编号 ${editor.row!.id} → ${res.id}）` : ''}`)
      if (renamed) {
        setConfirmId(null)
        onRenamed?.(kind, editor.row!.id, res.id)
      }
      setEditor(null)
      reload()
      onChanged()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  async function remove(row: AssetRow) {
    if (!guardPlaneWrite()) return
    setBusy(true)
    try {
      const res = await api.deleteAsset(kind, row.id)
      notify(`已删除${ASSET_KIND_LABEL[kind]} ${res.name}`)
      setConfirmId(null)
      reload()
      onChanged()
    } catch (err) {
      notify(err instanceof Error ? err.message : '删除失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  function exportCsv() {
    csvDownload(
      `ipam-${kind}.csv`,
      [...cfg.columns.map(c => c.label), '备注'],
      filtered.map(r => [...cfg.columns.map(c => c.text(r)), r.note ?? '']),
    )
    notify(`已导出 ${filtered.length} 条${ASSET_KIND_LABEL[kind]}记录`)
  }

  const distribution = useMemo(() => {
    if (!items.length) return []
    const groupKey = kind === 'devices' ? 'role' : kind === 'links' ? 'kind'
      : kind === 'locations' ? 'kind' : 'status'
    const map = new Map<string, number>()
    items.forEach(r => {
      const key = String(r[groupKey] ?? '—')
      map.set(key, (map.get(key) ?? 0) + 1)
    })
    return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([key, value]) => ({
      label: (groupKey === 'role' ? ASSET_ROLE_LABEL[key] : ASSET_STATUS_LABEL[key]) ?? key,
      value,
      tone: toneOf(key),
    }))
  }, [items, kind])

  const vrfDistribution = useMemo(() => {
    if (kind !== 'devices') return []
    const map = new Map<string, number>()
    items.forEach(r => {
      const key = String(r.vrf ?? 'default')
      map.set(key, (map.get(key) ?? 0) + 1)
    })
    return [...map.entries()].sort((a, b) => b[1] - a[1])
      .map(([label, value]) => ({ label, value }))
  }, [items, kind])

  return (
    <>
      <div className="stat-row">
        {cfg.stats.map(s => (
          <MiniStat key={s.key} label={s.label} tone={s.tone}
            value={asset?.stats[s.key] ?? 0}
            foot={s.key === 'util' ? `${s.foot}（%）` : s.foot} />
        ))}
      </div>

      <div className="asset-quicknav" id="asset-quicknav">
        <span className="asset-quicknav-title"><Icon name="cpu" size={14} />设备管理</span>
        {QUICK_NAV.filter(n => (n.key !== 'device_roles' || can('device_roles'))
          && (n.key !== 'topology' || can('topology'))).map(n => (
          <button key={n.key} className={`asset-quicknav-item${kind === n.key ? ' active' : ''}`}
            onClick={() => onNavigate(n.key)}>
            <Icon name={n.icon} size={13} />{n.label}
            {n.stat && <span className="n">{counts?.[n.stat] ?? 0}</span>}
          </button>
        ))}
        {asset?.scope_limited && (
          <span className="asset-scope-note">按可见范围收敛：{asset.visible_scopes?.join('、')}</span>
        )}
      </div>

      <div className={planeWritable ? 'vrf-notice' : 'readonly-banner'}
        id="asset-plane-note" style={{ marginTop: 12 }}>
        <Icon name="database" size={14} />
        <span>
          <b>当前地址平面 {planeWritable ? plane : '全部 VRF（跨平面对比）'}</b>
          {' · '}设备清单按平面过滤，新建设备自动归属该平面；机柜 / 位置 / 链路是平面无关的物理资源，全局可见。
          {!planeWritable && ' 汇总视图下设备的写操作已停用，请先从顶栏选定具体平面。'}
        </span>
      </div>

      <Card title={`${ASSET_KIND_LABEL[kind]}清单`}
        hint={loading ? '加载中…'
          : `共 ${filtered.length} / ${items.length} 条${kind === 'racks' ? ' · 点击行进入机柜正视图' : ''}`}>
        <div className="toolbar asset-toolbar">
          <div className="search" style={{ marginLeft: 0, width: 240 }}>
            <Icon name="search" size={14} />
            <input id="asset-search" value={q} onChange={e => setQ(e.target.value)}
              placeholder={`搜索${ASSET_KIND_LABEL[kind]}名称 / 编号 / IP`} />
          </div>
          <select className="asset-filter" id="asset-filter" value={filter}
            onChange={e => setFilter(e.target.value)}>
            <option value="all">全部{cfg.filter.label}</option>
            {filterChoices.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
          {kind === 'devices' && !planeWritable && (
            <select className="asset-filter" id="asset-vrf-filter" value={vrfFilter}
              onChange={e => setVrfFilter(e.target.value)}>
              <option value="all">全部地址平面</option>
              {(asset?.options.vrfs ?? []).map(o => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          )}
          <span className="spacer" />
          {kind === 'devices' && can('device_roles') && (
            <button className="btn sm" id="asset-role-dict"
              onClick={() => onNavigate('device_roles')}>
              <Icon name="tag" size={13} />角色字典
            </button>
          )}
          <button className="btn sm" id="asset-export" onClick={exportCsv}>
            <Icon name="download" size={13} />导出 CSV
          </button>
          <AdminOnly>
            <button className="btn sm primary" id="asset-create" onClick={openCreate}>
              <Icon name="plus" size={13} />新建{ASSET_KIND_LABEL[kind]}
            </button>
          </AdminOnly>
        </div>

        {filtered.length === 0
          ? <div className="empty">{loading ? '正在加载…' : '当前筛选条件下没有记录'}</div>
          : (
            <div className="asset-table-wrap">
              <table className="asset-table">
                <thead><tr>
                  {cfg.columns.map(c => <th key={c.key}>{c.label}</th>)}
                  {(isAdmin || hasDetail) && <th>操作</th>}
                </tr></thead>
                <tbody>
                  {filtered.map(row => (
                    <tr key={row.id}
                      className={hasDetail ? 'clickable' : ''}
                      title={hasDetail
                        ? (kind === 'racks' ? '点击进入机柜正视图' : '点击进入位置机柜平面图')
                        : undefined}
                      onClick={() => openDetail(row)}>
                      {cfg.columns.map(c => <td key={c.key}>{c.render(row)}</td>)}
                      {(isAdmin || hasDetail) && (
                        <td onClick={e => e.stopPropagation()}>
                          {isAdmin && confirmId === row.id ? (
                            <span className="asset-confirm">
                              <span>确认删除？</span>
                              <button className="row-act danger" id={`asset-del-yes-${row.id}`}
                                disabled={busy} onClick={() => void remove(row)}>确认</button>
                              <button className="row-act" onClick={() => setConfirmId(null)}>取消</button>
                            </span>
                          ) : (
                            <span className="asset-row-actions">
                              {hasDetail && (
                                <button className="row-act" id={`asset-open-${row.id}`}
                                  onClick={() => openDetail(row)}>{detailLabel}</button>
                              )}
                              {isAdmin && (
                                <>
                                  <button className="row-act" id={`asset-edit-${row.id}`}
                                    onClick={() => openEdit(row)}>编辑</button>
                                  <button className="row-act danger" id={`asset-del-${row.id}`}
                                    onClick={() => setConfirmId(row.id)}>删除</button>
                                </>
                              )}
                            </span>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Card>

      <div className="grid-2 asset-bottom">
        {kind === 'racks' && (
          <Distribution title="机柜状态分布" rows={distribution} total={items.length} />
        )}
        {kind === 'devices' && (
          <div className="stack-col">
            <Distribution title="角色分布" rows={distribution} total={items.length} />
            <Distribution title="地址平面分布" rows={vrfDistribution} total={items.length} />
          </div>
        )}
        {kind === 'links' && (
          <Distribution title="链路类型分布" rows={distribution} total={items.length} />
        )}
        {kind === 'locations' && (
          <Distribution title="位置层级分布" rows={distribution} total={items.length} />
        )}
        <Card title="与地址空间的关系" hint="02 业务能力层">
          <div className="asset-relation">
            <div className="asset-relation-row"><Icon name="network" size={15} />
              <span><b>位置 → 机柜 → 设备</b>：物理承载链，设备可落到具体机柜 U 位。</span></div>
            <div className="asset-relation-row"><Icon name="swap" size={15} />
              <span><b>链路</b>：连接两台设备的端口，记录类型、带宽、VLAN 与连通状态。</span></div>
            <div className="asset-relation-row"><Icon name="ip" size={15} />
              <span><b>管理 IP</b>：自动回查地址空间树中最细的所属前缀，并标记是否已在 IPAM 登记。</span></div>
            <div className="asset-relation-row"><Icon name="shield" size={15} />
              <span><b>权限</b>：只读用户按管理员分配的模块与 CIDR 范围查看，写操作由后端统一拒绝。</span></div>
          </div>
          <div className="asset-rel-actions">
            <button className="btn sm" onClick={() => onNavigate('spaces')}>查看地址空间树</button>
            <button className="btn sm" onClick={() => onNavigate('allocation')}>IP 分配/回收</button>
          </div>
        </Card>
      </div>

      <Drawer open={!!editor}
        title={`${editor?.mode === 'create' ? '新建' : '编辑'}${ASSET_KIND_LABEL[kind]}`}
        sub={editor?.mode === 'create'
          ? `${cfg.idHint}保存后仍可再次编辑`
          : `原编号 ${editor?.row?.id} · 编号可修改并自动同步引用`}
        onClose={() => setEditor(null)}>
        <form id="asset-form" onSubmit={save}>
          <div className="field">
            <label>{cfg.idHint} <b className="req">*</b></label>
            <input id="asset-id" value={newId} maxLength={48}
              onChange={e => setNewId(e.target.value)} placeholder={`例如 ${cfg.idExample}`} />
            <div className="help">
              {editor?.mode === 'create'
                ? '仅支持字母、数字、. _ -，长度 2–48；保存后仍可再次编辑。'
                : '可再次编辑；仅支持字母、数字、. _ -，长度 2–48，修改后自动同步相关引用。'}
            </div>
          </div>
          <div className="form-grid">
            {cfg.fields.map(f => {
              const choices = optionChoices(asset, f,
                f.source === 'roles' ? text(form[f.key]) : '')
              const wide = f.full || f.type === 'textarea'
              const extraHeight = f.key === 'u_height' ? uHeightExtraOption(form.u_height) : null
              return (
                <div className={`field${wide ? ' full' : ''}`} key={f.key}>
                  <label>{f.label}</label>
                  {f.type === 'select' ? (
                    <select id={`asset-f-${f.key}`} value={text(form[f.key])}
                      onChange={e => setForm(p => f.key === 'u_height'
                        ? linkUField(p, 'u_height', e.target.value)
                        : ({ ...p, [f.key]: e.target.value }))}>
                      <option value="">— 请选择 —</option>
                      {extraHeight && <option value={extraHeight.value}>{extraHeight.label}</option>}
                      {choices.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                    </select>
                  ) : f.type === 'textarea' ? (
                    <textarea id={`asset-f-${f.key}`} value={text(form[f.key])}
                      onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}
                      placeholder={f.placeholder} />
                  ) : f.type === 'urange' ? (
                    <input id={`asset-f-${f.key}`} type="text" value={text(form[f.key])}
                      onChange={e => setForm(p => linkUField(p, 'rack_u', e.target.value))}
                      placeholder={f.placeholder} />
                  ) : (
                    <input id={`asset-f-${f.key}`} type={f.type === 'number' ? 'number' : 'text'}
                      step={f.key === 'power_kw' || f.key === 'bandwidth_gbps' ? '0.1' : undefined}
                      value={text(form[f.key])}
                      onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}
                      placeholder={f.placeholder} />
                  )}
                  {f.type === 'urange' && (
                    <URangePreview form={form}
                      units={Number(asset?.options.racks.find(o => o.id === text(form.rack_id))?.units ?? 0) || undefined}
                      rows={text(form.rack_id) ? items : []}
                      excludeId={editor?.row?.id} rackId={text(form.rack_id)} />
                  )}
                  {f.help && <div className="help">{f.help}</div>}
                  {f.key === 'role' && can('device_roles') && (
                    <button type="button" className="role-manage-link" id="asset-role-manage"
                      onClick={() => { setEditor(null); onNavigate('device_roles') }}>
                      <Icon name="tag" size={12} />去管理角色
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          {formError && <div className="check-note bad" id="asset-form-error">{formError}</div>}
          <div className="drawer-actions">
            <button type="button" className="btn ghost" onClick={() => setEditor(null)}>取消</button>
            <button type="submit" className="btn primary" id="asset-save" disabled={busy}>
              {busy ? '保存中…' : '保存'}
            </button>
          </div>
        </form>
      </Drawer>
    </>
  )
}
