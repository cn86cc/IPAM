import { Drawer, Tag } from '../components/ui'
import type { View } from '../types'

interface Layer {
  n: string
  mods: { label: string; done: boolean; view?: View }[]
  note: string
  core?: boolean
}

const LAYERS: Layer[] = [
  {
    n: '01 接入与展示层',
    mods: [
      { label: 'Web 控制台', done: true, view: 'dashboard' },
      { label: '登录页', done: true },
      { label: '本地认证 / RBAC', done: true, view: 'users' },
      { label: 'LDAP / AD', done: true },
      { label: 'SSO / OIDC', done: true },
      { label: 'Open API', done: true },
      { label: '架构视图', done: true },
    ],
    note: '所有 /api 入口共用统一鉴权中间件：本地账号 PBKDF2 加盐哈希 + HttpOnly Cookie 会话，管理员 / 只读用户两级角色，只读用户的可见模块与 CIDR 范围由管理员手动分配，写操作在后端直接拒绝。LDAP 目录绑定与 OIDC 授权码 + PKCE 已实现，演示模式开箱可用。顶栏提供全站模糊搜索与可见范围切换。',
  },
  {
    n: '02 业务能力层',
    mods: [
      { label: '地址空间', done: true, view: 'spaces' },
      { label: 'IP 分配 / 回收', done: true, view: 'allocation' },
      { label: '子网划分', done: true, view: 'subnets' },
      { label: '分配申请', done: true, view: 'tickets' },
      { label: 'VRF 地址平面', done: true, view: 'vrf' },
      { label: '设备', done: true, view: 'devices' },
      { label: '机柜', done: true, view: 'racks' },
      { label: '链路', done: true, view: 'links' },
      { label: '位置', done: true, view: 'locations' },
      { label: '角色', done: true, view: 'device_roles' },
      { label: '发现对账', done: true, view: 'reconciliation' },
      { label: '审批工单', done: true, view: 'approvals' },
      { label: '审计日志', done: true, view: 'audit' },
      { label: '查询报表', done: true, view: 'reports' },
      { label: '用户与权限', done: true, view: 'users' },
    ],
    note: '第一版完成地址空间 / 分配与回收 / 利用率看板；「IP 分配/回收」单页双标签共用指标与地址记录表。第四版补齐登录页、本地用户认证、管理员 / 只读角色、可见模块与 CIDR 范围分配，以及 LDAP / SSO 认证源配置。第五版新增与「地址管理」「治理与对账」平级的「设备管理」大分组，下含设备 / 机柜 / 链路 / 位置四个模块，构成位置 → 机柜 → 设备 → 链路的物理拓扑链，并把设备管理 IP 回连到地址空间树。第六版在设备管理分组增加「角色」模块（与设备 / 机柜 / 链路 / 位置同级，位于位置之后），设备表单角色恢复为纯下拉，选项由字典统一提供并在后端校验。第七版完成模型级 VRF 真隔离：每个 VRF 是一张独立地址平面，唯一键为 (VRF, CIDR) / (VRF, IP)，同一网段与地址可跨平面重复登记；前缀冲突、容量统计、分配回收、审计 / 趋势 / 告警、工单与只读授权全部按平面隔离，顶栏提供全局平面切换与「全部 VRF」只读对比视图。',
  },
  {
    n: '03 领域核心层', core: true,
    mods: [
      { label: 'IP 状态机', done: true },
      { label: '冲突校验', done: true },
      { label: 'CIDR 子网计算', done: true, view: 'subnets' },
      { label: '分配锁', done: true },
      { label: '对账引擎', done: true, view: 'reconciliation' },
      { label: '审计留痕', done: true, view: 'audit' },
    ],
    note: '系统心脏：状态机约束所有写操作；CIDR 包含 / 重叠判定与子网等分均在当前 VRF 平面内执行；分配锁按 (VRF, 前缀) 复合键串行化，不同平面同网段互不阻塞；审计只追加并带平面归属。',
  },
  {
    n: '04 集成与同步层',
    mods: [
      { label: 'DNS / DHCP', done: true, view: 'integrations' },
      { label: 'CMDB / 云', done: true, view: 'integrations' },
      { label: '网络设备 SNMP', done: true, view: 'integrations' },
      { label: 'NetFlow 对账', done: true, view: 'integrations' },
      { label: 'Webhook 告警', done: true, view: 'integrations' },
    ],
    note: '六个数据源可启停与手动同步，采集结果回灌为发现记录，形成「登记 → 使用 → 对账 → 回收」闭环。',
  },
  {
    n: '05 数据与基础设施层',
    mods: [
      { label: '持久化（SQLite）', done: true },
      { label: '阈值与地址平面配置', done: true, view: 'settings' },
      { label: '预留过期任务', done: true, view: 'settings' },
      { label: 'PostgreSQL inet/GiST', done: false },
      { label: 'Redis 分布式锁', done: false },
    ],
    note: '大网段不预生成 IP 行，用前缀表 + 空闲区间按需落库。本地用 SQLite 与进程内锁，接口保留生产组件替换位。',
  },
]

export default function ArchDrawer({ open, onClose, onNavigate, current }: {
  open: boolean
  onClose: () => void
  onNavigate: (v: View) => void
  current: View
}) {
  return (
    <Drawer open={open} title="产品架构视图" sub="与五层架构图一一对应 · 点击模块可跳转" onClose={onClose}>
      {LAYERS.map(layer => (
        <div className={`layer${layer.core ? ' core' : ''}`} key={layer.n}>
          <div className="layer-head">
            <span>{layer.n}</span>
            <span className="n">{layer.core ? '领域核心' : `${layer.mods.filter(m => m.done).length}/${layer.mods.length} 已实现`}</span>
          </div>
          <div className="layer-note">{layer.note}</div>
          <div className="chips">
            {layer.mods.map(m => (
              <button key={m.label}
                className={`chip${layer.core ? ' core' : ''}${m.done ? ' done' : ''}`}
                style={{ cursor: m.view ? 'pointer' : 'default' }}
                onClick={() => { if (m.view) { onNavigate(m.view); onClose() } }}>
                {m.label}{m.view && m.view === current ? ' · 当前' : ''}
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="drawer-foot">
        <Tag text="v0.5" tone="blue" /> 灰底为架构规划但尚未落地的生产替换位（PostgreSQL inet/GiST、Redis 分布式锁、JWKS 轮换）。
      </div>
    </Drawer>
  )
}
