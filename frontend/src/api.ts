import type {
  AllocationPayload, AllocationResult, Dashboard, IPList, Spaces, Action, AuditItem,
  Overview, Vrf, IntegrationData, DiscoveryRecord, ReconciliationData, TicketData,
  TicketPayload, PlanResult, ReportData, AuditData, SettingsData, Thresholds,
  PrefixPreflight, PrefixImpact, PrefixWritePayload, PrefixWriteResult,
  CustomPage, CustomBlock, VrfPayload, VrfWriteResult, VrfOverlap, ManualCheck, IPLookup, AddressMap,
  SearchResult, IPUpdatePayload, IPUpdateResult,
  LoginPayload, LoginResult, MeResult, PublicSources, SsoStart, UsersData,
  AuthConfigData, AuthSourceConfig, UserPayload, AuthUser, AuthProvider,
  AssetKind, AssetData, AssetOverview, AssetPayload, AssetWriteResult,
  RackDetailData, RackMoveResult, LocationDetailData, RackReorderResult,
  DeviceRolesData, DeviceRolePayload, DeviceRoleWriteResult,
} from './types'

const BASE = '/api'

/** 只读用户手动选择的当前可见范围；由 AuthProvider 在切换时同步。 */
let apiScope = 'all'
export function setApiScope(scope: string) { apiScope = scope || 'all' }

/** 当前 VRF 地址平面：所有地址类接口都据此在后端做 (vrf, ...) 隔离。
 *  'all' 表示跨平面对比视图，写操作会被后端拒绝。 */
let apiVrf = 'default'
export function setApiVrf(vrf: string) { apiVrf = vrf || 'default' }
export function getApiVrf() { return apiVrf }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(BASE + path, {
      ...init,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-IPAM-VRF': apiVrf,
        ...(apiScope !== 'all' ? { 'X-IPAM-Scope': apiScope } : {}),
        ...(init?.headers ?? {}),
      },
    })
  } catch {
    throw new Error('无法连接后端服务，请确认 API 已启动（端口 8000）')
  }
  if (res.status === 401) {
    window.dispatchEvent(new Event('ipam:unauthorized'))
  }
  if (!res.ok) {
    let detail = `请求失败 (${res.status})`
    try {
      const body = await res.json()
      if (body?.detail) detail = String(body.detail)
    } catch { /* 保留默认错误 */ }
    throw new Error(detail)
  }
  return res.json() as Promise<T>
}

const get = <T,>(path: string) => request<T>(path)
const post = <T,>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) })
const qs = (params: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams()
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== '' && v !== 'all') q.set(k, String(v))
  })
  return q.toString() ? '?' + q.toString() : ''
}

export const api = {
  health: () => get<{ ok: boolean; service: string; version: string }>('/health'),
  search: (q: string) => get<SearchResult>('/search' + qs({ q })),

  spaces: () => get<Spaces>('/spaces'),

  // 地址空间树编辑：与后端写操作共用同一套 CIDR 校验规则
  preflightPrefix: (params: { cidr: string; current?: string; parent?: string;
    kind?: string; vrf?: string }) =>
    get<PrefixPreflight>('/spaces/preflight' + qs(params)),
  prefixImpact: (cidr: string, vrf?: string) =>
    get<PrefixImpact>('/spaces/impact' + qs({ cidr, vrf })),
  updatePrefix: (cidr: string, payload: PrefixWritePayload) =>
    request<PrefixWriteResult>(`/spaces/${encodeURIComponent(cidr)}`, {
      method: 'PUT', body: JSON.stringify(payload),
    }),
  createPrefix: (payload: PrefixWritePayload) => post<PrefixWriteResult>('/spaces', payload),
  deletePrefix: (cidr: string) =>
    request<PrefixWriteResult>(`/spaces/${encodeURIComponent(cidr)}`, { method: 'DELETE' }),

  ips: (params: { prefix?: string; status?: string; q?: string; page?: number; page_size?: number }) =>
    get<IPList>('/ips' + qs({ ...params, page: params.page ?? 1 })),

  dashboard: () => get<Dashboard>('/dashboard'),

  allocate: (payload: AllocationPayload) => post<AllocationResult>('/allocations', payload),
  checkAllocation: (params: { addr: string; prefix?: string }) =>
    get<ManualCheck>('/allocations/check' + qs(params)),
  lookupIp: (addr: string) => get<IPLookup>('/ips/lookup' + qs({ addr })),
  addressMap: (cidr: string, block = 0) =>
    get<AddressMap>('/address-map' + qs({ cidr, block })),

  updateIp: (addr: string, payload: IPUpdatePayload) =>
    request<IPUpdateResult>(`/ips/${encodeURIComponent(addr)}`, {
      method: 'PUT', body: JSON.stringify(payload),
    }),

  transition: (addr: string, action: Action) =>
    post<{ addr: string; from: string; to: string; label: string }>(
      `/ips/${encodeURIComponent(addr)}/transition`, { action },
    ),

  audit: () => get<{ items: AuditItem[] }>('/audit'),

  // 第二版：工作台与 01 层
  overview: () => get<Overview>('/overview'),
  vrfs: () => get<{ items: Vrf[] }>('/vrfs'),
  vrfOverlap: () => get<VrfOverlap>('/vrfs/overlap'),
  createVrf: (payload: VrfPayload) => post<VrfWriteResult>('/vrfs', payload),
  updateVrf: (name: string, payload: VrfPayload) =>
    request<VrfWriteResult>(`/vrfs/${encodeURIComponent(name)}`, {
      method: 'PUT', body: JSON.stringify(payload),
    }),
  deleteVrf: (name: string, targetVrf?: string) =>
    request<VrfWriteResult>(
      `/vrfs/${encodeURIComponent(name)}` +
      (targetVrf ? `?target_vrf=${encodeURIComponent(targetVrf)}` : ''),
      { method: 'DELETE' }),

  // 第三版：可自定义编辑的页面内容
  page: (key: string) => get<CustomPage>(`/pages/${encodeURIComponent(key)}`),
  savePage: (key: string, payload: {
    title: string; subtitle: string; blocks: CustomBlock[]; updated_by?: string
  }) => request<CustomPage>(`/pages/${encodeURIComponent(key)}`, {
    method: 'PUT', body: JSON.stringify(payload),
  }),

  // 04 集成与同步层
  integrations: () => get<IntegrationData>('/integrations'),
  toggleSource: (id: string, enabled: boolean) =>
    post<{ id: string; enabled: boolean }>(`/integrations/${id}/toggle`, { enabled }),
  syncSource: (id: string) => post<{ source: string; records: number; new_diffs: number; synced_at: string }>(
    `/integrations/${id}/sync`),
  discovery: (limit = 50) => get<{ items: DiscoveryRecord[] }>('/discovery' + qs({ limit })),

  // 02 治理与对账
  reconciliation: (status = 'all', type = 'all') =>
    get<ReconciliationData>('/reconciliation' + qs({ status, type })),
  resolveDiff: (id: number, action: string, note = '') =>
    post<{ id: number; action: string; status: string; outcome: string }>(
      `/reconciliation/${id}/resolve`, { action, note },
    ),

  // 02 审批工单
  tickets: (status = 'all') => get<TicketData>('/tickets' + qs({ status })),
  createTicket: (payload: TicketPayload) => post<{ id: string; status: string; type: string }>('/tickets', payload),
  decideTicket: (id: string, decision: 'approve' | 'reject', approver: string, note = '') =>
    post<{ id: string; status: string; result: string | null }>(
      `/tickets/${encodeURIComponent(id)}/decide`, { decision, approver, note },
    ),

  // 03 子网计算：limit=0 表示一次列出可承载的全部子网
  planSubnets: (parent: string, new_prefix: number, offset = 0, limit = 0, vrf?: string) =>
    post<PlanResult>('/subnets/plan', { parent, new_prefix, offset, limit, vrf }),
  subnetPlanExportPath: (parent: string, new_prefix: number, vrf?: string) =>
    `/subnets/plan/export?parent=${encodeURIComponent(parent)}&new_prefix=${new_prefix}` +
    (vrf ? `&vrf=${encodeURIComponent(vrf)}` : ''),
  commitSubnets: (payload: { parent: string; cidrs: string[]; name?: string; vlan?: number | null; vrf?: string | null }) =>
    post<{ created: number; cidrs: string[] }>('/subnets', payload),

  // 02 报表 / 审计
  reports: (dimension: string, vrf?: string) =>
    get<ReportData>('/reports' + qs({ dimension, vrf })),
  auditLog: (action = 'all', q = '', limit = 100) =>
    get<AuditData>('/audit' + qs({ action, q, limit })),

  // 05 设置与维护
  settings: () => get<SettingsData>('/settings'),
  updateSettings: (payload: Record<string, string | number>) =>
    request<{ updated: Record<string, string>; thresholds: Thresholds }>('/settings', {
      method: 'PUT', body: JSON.stringify(payload),
    }),
  expireReservations: () =>
    post<{ expired: number; ttl_hours: number; addrs: string[] }>('/maintenance/expire-reservations'),
  takeSnapshot: () =>
    post<{ day: string; vrf: string; planes: { vrf: string; occupied: number; util: number }[] }>(
      '/maintenance/snapshot'),

  // 01 接入层：认证、会话与用户权限
  authSources: () => get<PublicSources>('/auth/sources/public'),
  login: (payload: LoginPayload) => post<LoginResult>('/auth/login', payload),
  logout: () => post<{ ok: boolean }>('/auth/logout'),
  me: () => get<MeResult>('/auth/me'),
  changePassword: (old_password: string, new_password: string) =>
    post<{ ok: boolean }>('/auth/password', { old_password, new_password }),
  ssoStart: () => get<SsoStart>('/auth/sso/start'),

  users: () => get<UsersData>('/auth/admin/users'),
  createUser: (payload: UserPayload) => post<AuthUser>('/auth/admin/users', payload),
  updateUser: (username: string, payload: UserPayload) =>
    request<AuthUser>(`/auth/admin/users/${encodeURIComponent(username)}`, {
      method: 'PUT', body: JSON.stringify(payload),
    }),
  deleteUser: (username: string) =>
    request<{ username: string; deleted: boolean }>(
      `/auth/admin/users/${encodeURIComponent(username)}`, { method: 'DELETE' }),
  authConfig: () => get<AuthConfigData>('/auth/admin/sources'),
  saveAuthSource: (key: 'ldap' | 'sso', enabled: boolean, config: AuthSourceConfig) =>
    request<{ key: AuthProvider; enabled: boolean; config: AuthSourceConfig }>(
      `/auth/admin/sources/${key}`, {
        method: 'PUT', body: JSON.stringify({ enabled, config }),
      }),
  testAuthSource: (key: 'ldap' | 'sso') =>
    post<{ ok: boolean; mode: string; detail: string }>(`/auth/admin/sources/${key}/test`),

  // 02 设备管理：位置 → 机柜 → 设备 → 链路
  assetOverview: () => get<AssetOverview>('/assets/overview'),
  // 角色字典（声明在 /assets/{kind} 之前的后端路由）
  deviceRoles: () => get<DeviceRolesData>('/assets/device-roles'),
  createDeviceRole: (payload: DeviceRolePayload) =>
    post<DeviceRoleWriteResult>('/assets/device-roles', payload),
  updateDeviceRole: (key: string, payload: DeviceRolePayload) =>
    request<DeviceRoleWriteResult>(`/assets/device-roles/${encodeURIComponent(key)}`, {
      method: 'PUT', body: JSON.stringify(payload),
    }),
  deleteDeviceRole: (key: string) =>
    request<DeviceRoleWriteResult>(`/assets/device-roles/${encodeURIComponent(key)}`,
      { method: 'DELETE' }),
  assets: (kind: AssetKind) => get<AssetData>(`/assets/${kind}`),
  createAsset: (kind: AssetKind, payload: AssetPayload) =>
    post<AssetWriteResult>(`/assets/${kind}`, payload),
  updateAsset: (kind: AssetKind, id: string, payload: AssetPayload) =>
    request<AssetWriteResult>(`/assets/${kind}/${encodeURIComponent(id)}`, {
      method: 'PUT', body: JSON.stringify(payload),
    }),
  deleteAsset: (kind: AssetKind, id: string) =>
    request<AssetWriteResult>(`/assets/${kind}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  assetRackDetail: (id: string) =>
    get<RackDetailData>(`/assets/racks/${encodeURIComponent(id)}/detail`),
  moveRackDevice: (rackId: string, deviceId: string, rackU: number) =>
    post<RackMoveResult>(`/assets/racks/${encodeURIComponent(rackId)}/move`,
      { device_id: deviceId, rack_u: rackU }),
  assetLocationDetail: (id: string) =>
    get<LocationDetailData>(`/assets/locations/${encodeURIComponent(id)}/detail`),
  reorderLocationRacks: (id: string, order: string[]) =>
    post<RackReorderResult>(`/assets/locations/${encodeURIComponent(id)}/reorder`, { order }),
}
