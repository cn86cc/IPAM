export type Status = 'assigned' | 'reserved' | 'deprecated' | 'conflict' | 'available'
export type View =
  | 'dashboard' | 'spaces' | 'allocation' | 'subnets' | 'tickets' | 'vrf'
  | 'devices' | 'device_roles' | 'racks' | 'links' | 'locations'
  | 'reconciliation' | 'approvals' | 'audit' | 'users'
  | 'reports' | 'integrations' | 'settings'

/** 「IP 分配/回收」单页内的两个标签；旧的 #reclaim 链接映射为 reclaim 标签。 */
export type AllocTab = 'allocation' | 'reclaim'
export type Action = 'confirm' | 'release' | 'reclaim' | 'resolve'

export interface Prefix {
  cidr: string
  parent_cidr: string | null
  name: string
  kind: 'root' | 'aggregate' | 'subnet'
  site: string | null
  vlan: number | null
  vrf: string
  description: string | null
  updated_at: string | null
  total: number
  retained: number
  occupied: number
  reserved: number
  free: number
  util: number
  child_count: number
}

export interface IPRecord {
  vrf: string
  addr: string
  addr_int: number
  prefix_cidr: string
  status: Status
  hostname: string
  business: string
  owner: string
  vlan: number
  updated_at: string
}

export interface IPList {
  vrf: string
  items: IPRecord[]
  total: number
  page: number
  page_size: number
  pages: number
}

/** 地址记录行内编辑：只提交显式改动的描述性字段，状态变更必须走状态机。 */
export interface IPUpdatePayload {
  hostname?: string
  business?: string
  owner?: string
  vlan?: number | string | null
}

export interface IPUpdateResult {
  item: IPRecord
  changes: string[]
  unchanged: boolean
}

export interface RankItem {
  vrf: string
  cidr: string
  name: string
  site: string | null
  vlan: number | null
  util: number
  free: number
  occupied: number
}

export interface AuditItem {
  ts: string
  action: string
  addr: string | null
  detail: string
}

export interface Thresholds {
  warn: number
  crit: number
  reservation_ttl_hours: number
  default_vrf: string
  gateway_offset: number
}

export interface Dashboard {
  vrf: string
  thresholds: Thresholds
  total: number
  retained: number
  occupied: number
  reserved: number
  free: number
  util: number
  status: Record<string, number>
  subnet_count: number
  ranking: RankItem[]
  alerts: RankItem[]
  trend: { day: string; occupied: number; util: number; vrf?: string }[]
  audit: AuditItem[]
}

export interface Spaces {
  vrf: string
  prefixes: Prefix[]
  transitions: Record<string, string[]>
}

export interface AllocationResult {
  vrf: string
  addr: string
  prefix: string
  status: Status
  hostname: string
  business: string
  owner: string
  vlan: number
  updated_at: string
  source?: 'auto' | 'manual'
}

export interface AllocationPayload {
  prefix: string
  business: string
  owner: string
  hostname?: string
  mode: 'assigned' | 'reserved'
  addr?: string
  vrf?: string
}

export interface ManualCheckInfo {
  cidr: string
  name: string
  vlan: number | null
  first_host: string
  last_host: string
  usable: number
  free: number
}

export interface ManualCheck {
  vrf: string
  addr: string
  prefix: string
  valid: boolean
  issues: string[]
  resolved_prefix: string | null
  info: ManualCheckInfo | null
  suggestion: string | null
}

export interface IPLookup {
  item: IPRecord
  actions: Record<Action, { label: string; to: string }>
}

/* --------------------- 子网地址可视化（分配页手动模式） --------------------- */

export type MapState = Status | 'retained' | 'child'

export interface AddressCell {
  addr: string
  host: number
  state: MapState
  label: string
  retained_label: string | null
  child_prefix: string | null
  hostname: string | null
  business: string | null
  owner: string | null
  updated_at: string | null
  prefix_cidr: string | null
}

export interface AddressMap {
  cidr: string
  name: string
  site: string | null
  vlan: number | null
  vrf: string
  info: {
    network: string
    broadcast: string
    mask: string
    prefixlen: number
    first_host: string
    last_host: string
    total: number
    usable: number
  }
  block: number
  block_count: number
  block_size: number
  blocks: { index: number; first: string; last: string; label: string }[]
  cells: AddressCell[]
  counts: {
    total: number
    retained: number
    child: number
    available: number
    free: number
    occupied: number
    assigned: number
    reserved: number
    deprecated: number
    conflict: number
    util: number
  }
  block_counts: Record<string, number>
}

/* --------------------------- 全站顶栏模糊搜索 --------------------------- */

export interface SearchIp extends IPRecord {
  status_label: string
}

export interface SearchPrefix {
  cidr: string
  name: string
  kind: Prefix['kind']
  site: string | null
  vlan: number | null
  vrf: string
  description: string | null
  util: number
  free: number
  occupied: number
  total: number
  match: 'exact' | 'contains' | 'cidr' | 'text'
  relation: string
}

export interface SearchPool {
  vrf: string
  addr: string
  finest: string | null
  prefixes: string[]
  allocatable: boolean
}

export interface SearchResult {
  vrf: string
  q: string
  ips: SearchIp[]
  prefixes: SearchPrefix[]
  pool: SearchPool | null
  ip_total: number
  prefix_total: number
}

/** 顶栏搜索跳转目标；nonce 保证连续点击同一地址也能触发目标视图的副作用。 */
export interface JumpTarget {
  addr: string
  vrf?: string
  nonce: number
}

export const STATUS_LABEL: Record<Status, string> = {
  assigned: '已分配',
  reserved: '预留',
  deprecated: '待回收',
  conflict: '冲突',
  available: '可用',
}

/* ------------------------------- 第二版模块类型 ------------------------------- */

export interface Overview {
  open_diffs: number
  pending_tickets: number
  sources: number
  vrfs: number
  webhooks: number
}

export interface Vrf {
  name: string
  tenant: string
  description: string
  created_at: string
  prefix_count: number
  prefixes: string[]
  prefix_names: Record<string, string>
  /** 引用数用于统计与删除保护；同一 CIDR 可同时存在于多个 VRF 平面 */
  subnet_count: number
  root_count: number
  total: number
  occupied: number
  free: number
  util: number
  device_count: number
  devices: string[]
  device_names: Record<string, string>
  ip_count: number
  reference_count: number
  is_default: boolean
  /** VRF 级容量阈值；null 表示沿用系统全局设置 */
  warn_threshold: number | null
  crit_threshold: number | null
  /** 与全局阈值合并后的实际生效值 */
  effective_warn: number
  effective_crit: number
}

/** 跨平面地址复用全景：同一 CIDR / IP 在多个 VRF 平面重复登记 */
export interface VrfOverlap {
  planes: string[]
  prefix_count: number
  ip_count: number
  prefix_overlap: { cidr: string; plane_count: number; vrfs: string }[]
  ip_overlap: { addr: string; plane_count: number; vrfs: string; statuses: string }[]
}

/* --------------------------- 自定义页面（第三版） --------------------------- */

export type PageTone = 'blue' | 'teal' | 'amber' | 'neutral'

export interface CustomBlock {
  id: string
  title: string
  body: string
  tone: PageTone
}

export interface CustomPage {
  key: string
  title: string
  subtitle: string
  blocks: CustomBlock[]
  updated_at: string | null
  updated_by: string | null
}

export interface VrfPayload {
  name: string
  tenant: string
  description: string
  /** null / 留空 = 沿用系统全局容量阈值 */
  warn_threshold?: number | null
  crit_threshold?: number | null
}

export interface VrfWriteResult {
  name: string
  previous_name?: string
  changes?: string[]
  synced_prefixes?: number
  synced_devices?: number
  synced_ips?: number
  deleted?: boolean
  migrated_to?: string | null
  moved?: Record<string, number>
}

export interface IntegrationSource {
  id: string
  name: string
  kind: string
  endpoint: string | null
  enabled: number
  last_sync: string | null
  sync_count: number
  note: string | null
}

export interface WebhookEvent {
  id: number
  ts: string
  event: string
  target: string | null
  payload: string
}

export interface IntegrationData {
  items: IntegrationSource[]
  events: WebhookEvent[]
}

export interface DiscoveryRecord {
  id: number
  addr: string
  prefix_cidr: string
  mac: string | null
  hostname: string | null
  source: string
  signal: string
  observed_at: string
}

export interface Diff {
  id: number
  addr: string
  prefix_cidr: string
  type: string
  type_label: string
  severity: string
  source: string
  detail: string
  status: string
  discovered_at: string
  resolved_at: string | null
  resolution: string | null
  resolved: boolean
}

export interface ReconciliationData {
  items: Diff[]
  open: number
  resolved: number
  ignored: number
  by_type: Record<string, number>
}

export interface Ticket {
  id: string
  type: string
  type_label: string
  title: string
  applicant: string
  business: string | null
  prefix_cidr: string | null
  addr: string | null
  count: number
  reason: string | null
  status: string
  created_at: string
  updated_at: string
  approver: string | null
  decision_note: string | null
  result: string | null
}

export interface TicketData {
  items: Ticket[]
  pending: number
  approved: number
  rejected: number
}

export interface TicketPayload {
  type: 'allocate' | 'release' | 'expand'
  title?: string
  applicant: string
  business?: string
  prefix_cidr?: string | null
  addr?: string | null
  count?: number
  reason?: string
}

export interface CidrInfo {
  cidr: string
  prefixlen: number
  mask: string
  wildcard: string
  network: string
  broadcast: string
  first_host: string
  last_host: string
  total: number
  usable: number
}

export interface SubnetCandidate {
  /** 在完整等分结果中的全局序号（0 起）；分页时用于显示真实编号 */
  index: number
  cidr: string
  mask: string
  network: string
  broadcast: string
  first_host: string
  last_host: string
  total: number
  usable: number
  conflicts: string[]
  available: boolean
}

export interface PlanResult {
  parent: CidrInfo
  new_prefix: number
  /** 父前缀按目标掩码等分后的真实子网总数，不再截断为 64 */
  total_in_parent: number
  offset: number
  limit: number
  shown: number
  has_more: boolean
  /** 全量统计（跨所有分页），不是本页统计 */
  available_count: number
  conflict_count: number
  items: SubnetCandidate[]
}

export interface ReportRow {
  key: string
  label: string
  total: number
  retained?: number
  occupied: number
  free: number
  util: number
  subnets?: number
}

export interface ReportData {
  dimension: string
  label: string
  rows: ReportRow[]
  summary: { groups: number; total: number; occupied: number }
}

export interface AuditData {
  items: AuditItem[]
  actions: string[]
  total: number
}

export interface SettingItem {
  key: string
  value: string
  label: string
  note: string | null
}

export interface SettingsData {
  items: SettingItem[]
  thresholds: Thresholds
}

export const DIFF_TYPE_LABEL: Record<string, string> = {
  unregistered: '未登记使用',
  conflict: '地址冲突',
  zombie: '僵尸 IP',
  dns_mismatch: 'DNS 不一致',
}

export const TICKET_STATUS_LABEL: Record<string, string> = {
  pending: '待审批',
  approved: '已通过',
  rejected: '已驳回',
  failed: '执行失败',
}

/* -------------------------- 地址空间树编辑（03 层） -------------------------- */

export interface PrefixPreflight {
  valid: boolean
  info: CidrInfo | null
  cidr: string
  issues: string[]
  warnings: string[]
  conflicts: string[]
  children: string[]
  affected_ips: number
  can_apply: boolean
}

export interface PrefixImpact {
  cidr: string
  children: number
  ips: number
  open_diffs: number
  pending_tickets: number
  can_delete: boolean
  reasons: string[]
}

export interface PrefixWritePayload {
  cidr?: string
  parent_cidr?: string | null
  name?: string
  site?: string | null
  vlan?: number | null
  vrf?: string
  description?: string | null
  kind?: Prefix['kind']
  cascade_children?: boolean
}

export interface PrefixWriteResult {
  cidr: string
  previous_cidr?: string
  changes?: string[]
  cascaded?: number
  affected_ips?: number
  deleted?: boolean
  name?: string
  kind?: string
  parent_cidr?: string
}

export const PREFIX_KIND_LABEL: Record<Prefix['kind'], string> = {
  root: '根空间', aggregate: '汇聚前缀', subnet: '可分配子网',
}

/* ------------------------- 第四版：认证、角色与可见范围 ------------------------- */

export type Role = 'admin' | 'viewer'
export type AuthProvider = 'local' | 'ldap' | 'sso'

export interface AuthUser {
  username: string
  display_name: string
  email: string | null
  role: Role
  source: AuthProvider
  enabled: boolean
  modules: View[]
  /** 可见 CIDR 范围；空数组表示不限制地址段 */
  scopes: string[]
  must_change_password: boolean
  created_at: string
  last_login_at: string | null
}

export interface AuthModule {
  key: View
  label: string
  group: string
}

export interface PublicSources {
  local: { enabled: boolean; label: string }
  ldap: { enabled: boolean; label: string; demo_mode: boolean }
  sso: { enabled: boolean; label: string; demo_mode: boolean }
}

export interface LoginPayload {
  method: 'local' | 'ldap'
  username: string
  password: string
}

export interface LoginResult {
  user: AuthUser
  session_hours: number
}

export interface MeResult {
  user: AuthUser
  modules: AuthModule[]
  scopes: string[]
  /** 系统设置的默认地址平面；用户未手动切换过时前端据此初始化 */
  default_vrf: string
  session_source: string | null
}

export interface SessionInfo {
  username: string
  display_name: string | null
  source: AuthProvider
  created_at: string
  last_seen: string
  expires_at: string
}

export interface UsersData {
  items: AuthUser[]
  modules: AuthModule[]
  sessions: SessionInfo[]
}

export interface DemoDirUser {
  username: string
  password: string
  display_name: string
  email: string
}

export interface AuthSourceConfig {
  label?: string
  demo_mode?: boolean
  server_url?: string
  bind_dn?: string
  bind_password?: string
  base_dn?: string
  user_filter?: string
  use_tls?: boolean
  display_name_attr?: string
  email_attr?: string
  demo_users?: DemoDirUser[]
  provider?: string
  issuer?: string
  client_id?: string
  client_secret?: string
  redirect_uri?: string
  scope?: string
  default_modules?: View[]
  default_scopes?: string[]
}

export interface AuthSourceItem {
  key: 'ldap' | 'sso'
  enabled: boolean
  config: AuthSourceConfig
}

export interface AuthConfigData {
  items: AuthSourceItem[]
  local: { label: string; password_min_length: number; session_hours: number;
           lock_threshold: number; lock_minutes: number }
}

export interface UserPayload {
  username?: string
  display_name?: string
  email?: string
  role?: Role
  password?: string
  enabled?: boolean
  modules?: View[]
  scopes?: string[]
  must_change_password?: boolean
}

export interface SsoStart {
  mode: 'demo' | 'oidc'
  state: string
  authorize_url: string
}

export const ROLE_LABEL: Record<Role, string> = {
  admin: '管理员', viewer: '只读用户',
}

export const SOURCE_LABEL: Record<AuthProvider, string> = {
  local: '本地账号', ldap: 'LDAP / AD', sso: 'SSO / OIDC',
}

/* ------------------------------ 设备管理（位置 / 机柜 / 设备 / 链路） ------------------------------ */

export type AssetKind = 'devices' | 'racks' | 'links' | 'locations'

/** 四类资产编号的通用格式；前端预校验与后端 ID_RE 保持一致。 */
export const ASSET_ID_PATTERN = /^[A-Za-z0-9._-]{2,48}$/

/** 四类资产共用的行结构；不同 kind 只使用其中的一组字段。 */
export interface AssetRow {
  /** 四类资产字段不同，允许按配置里的字段名做通用读取 / 筛选。 */
  [key: string]: unknown
  id: string
  name: string
  // 位置
  kind?: string
  parent_id?: string | null
  address?: string
  contact?: string
  path?: string
  child_count?: number
  // 机柜
  location_id?: string | null
  location_name?: string
  units?: number
  power_kw?: number
  used_u?: number
  free_u?: number
  util?: number
  online?: number
  device_count?: number
  rack_count?: number
  layout_order?: number
  occupants?: { id: string; name: string; rack_u: number | null; status: string }[]
  // 设备
  vendor?: string
  model?: string
  role?: string
  mgmt_ip?: string | null
  rack_id?: string | null
  rack_name?: string
  rack_u?: number | null
  vrf?: string
  owner?: string
  prefix_cidr?: string | null
  ipam_registered?: boolean
  // 链路
  local_device_id?: string
  local_device_name?: string
  local_device_ip?: string
  local_port?: string
  remote_device_id?: string
  remote_device_name?: string
  remote_device_ip?: string
  remote_port?: string
  bandwidth_gbps?: number
  vlan?: string
  // 通用
  status?: string
  note?: string
  created_at?: string
  updated_at?: string | null
  addr?: string | null
}

export interface AssetOption {
  id: string
  name: string
  path?: string
  kind?: string
  location_id?: string
  units?: number
  /** 角色字典：停用角色不进入设备下拉，但保留历史引用 */
  enabled?: boolean
  builtin?: boolean
}

export interface AssetData {
  kind: AssetKind
  label: string
  items: AssetRow[]
  stats: Record<string, number>
  options: {
    locations: AssetOption[]
    racks: AssetOption[]
    devices: AssetOption[]
    vrfs: AssetOption[]
    /** 角色字典：新建 / 编辑设备的角色下拉唯一来源 */
    roles: AssetOption[]
  }
  scope_limited?: boolean
  visible_scopes?: string[]
}

export type AssetPayload = Record<string, string | number | null>

export interface AssetOverview {
  locations: number
  racks: number
  devices: number
  links: number
  online_devices: number
  up_links: number
}

export interface AssetWriteResult {
  id: string
  name?: string
  created?: boolean
  deleted?: boolean
  unchanged?: boolean
  changes?: string[]
  /** 编号被再次编辑时返回旧编号；未改名时为 null。 */
  previous_id?: string | null
  /** 本次编号变更同步更新的引用条数。 */
  references_updated?: number
}

export const ASSET_ROLE_LABEL: Record<string, string> = {
  core_switch: '核心交换机', access_switch: '接入交换机', router: '路由器',
  firewall: '防火墙', load_balancer: '负载均衡', server: '服务器',
  storage: '存储设备', other: '其它设备',
}

/* ------------------------------ 角色模块 ------------------------------ */

/** 角色字典条目；key 同时是保存到 asset_devices.role 的值。 */
export interface DeviceRole {
  key: string
  description: string
  builtin: boolean
  enabled: boolean
  sort_order: number
  created_at: string
  updated_at: string | null
  /** 引用该角色的设备台数 */
  usage: number
}

export interface DeviceRolesData {
  items: DeviceRole[]
  stats: {
    total: number
    builtin: number
    custom: number
    enabled: number
    in_use: number
    devices: number
  }
  options?: { roles: AssetOption[] }
  scope_limited?: boolean
  visible_scopes?: string[]
}

export interface DeviceRolePayload {
  key?: string
  description?: string
  enabled?: boolean
}

export interface DeviceRoleWriteResult extends DeviceRolePayload {
  key: string
  created?: boolean
  deleted?: boolean
  unchanged?: boolean
  changes?: string[]
  previous_key?: string | null
  references_updated?: number
}

export const ASSET_STATUS_LABEL: Record<string, string> = {
  online: '在线', offline: '离线', maintenance: '维护中',
  up: '已连通', down: '中断', planned: '规划中',
  active: '在用', retired: '已退役',
  campus: '园区', building: '楼宇', floor: '楼层', room: '机房',
  trunk: 'Trunk', access: 'Access', uplink: '上联', stack: '堆叠', wan: '广域网',
}

export const ASSET_KIND_LABEL: Record<AssetKind, string> = {
  devices: '设备', racks: '机柜', links: '链路', locations: '位置',
}

/** 机柜二级页面（正视图）数据：机柜本体 + 可直接编辑的设备明细。 */
export interface RackDetailData {
  rack: AssetRow
  devices: AssetRow[]
  stats: {
    units: number
    used: number
    free: number
    util: number
    online: number
  }
  options: AssetData['options']
  /** 可见范围内已使用的角色（含自定义值），供组合框候选复用 */
  role_choices?: string[]
  scope_limited?: boolean
  visible_scopes?: string[]
}

/** 拖拽 / 编辑面板调整 U 位的结果。 */
export interface RackMoveResult {
  id: string
  rack_u: number
  action: 'move' | 'swap' | 'unchanged'
  from_u: number | null
  swapped_with: string | null
}

/** 位置二级页面（机柜横向平面图）数据。 */
export interface LocationDetailData {
  location: AssetRow
  /** 已按 layout_order 升序返回，前端按此顺序等宽横向排列。 */
  racks: AssetRow[]
  children: AssetRow[]
  stats: {
    rack_count: number
    units_total: number
    used_u: number
    util: number
    device_count: number
    max_units: number
    min_units: number
  }
  scope_limited?: boolean
  visible_scopes?: string[]
}

/** 左右拖动后持久化的机柜横向顺序。 */
export interface RackReorderResult {
  location_id: string
  order: string[]
  action: 'reorder' | 'unchanged'
  from: string[]
}
