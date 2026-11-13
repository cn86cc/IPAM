import { AddressTable, Icon, Metric } from '../components/ui'
import { useAuth } from '../auth'
import type { AllocTab, Dashboard, JumpTarget, Spaces } from '../types'
import type { ViewProps } from './shared'
import AllocationView from './AllocationView'
import ReclaimView from './ReclaimView'
import { ReadOnlyAllocation, ReadOnlyReclaim } from './ReadOnlyPanels'

interface Props extends ViewProps {
  spaces: Spaces
  dash: Dashboard
  /** 由外层受控：顶栏搜索、旧 #reclaim 链接、页头快捷按钮都可切换标签 */
  tab: AllocTab
  onTabChange: (tab: AllocTab) => void
  focusIp?: JumpTarget | null
  focusAddr?: JumpTarget | null
  /** 底部地址记录的行操作「定位所属网段」跳转回地址空间树 */
  onLocatePrefix?: (cidr: string) => void
}

/**
 * 合并页「IP 分配/回收」：一个侧栏入口、两个标签，共用状态指标与地址记录表。
 * 两个标签的内容保持挂载（用 display 切换），来回切换不会丢失已填表单与查询结果。
 */
export default function AllocationReclaimView({
  spaces, dash, tab, onTabChange, focusIp, focusAddr, onLocatePrefix,
  refreshKey, onChanged, notify,
}: Props) {
  const { isAdmin } = useAuth()
  const status = dash.status

  return (
    <>
      <div className="view-switch-row">
        <div className="view-switch" id="alloc-view-tabs" role="tablist" aria-label="分配与回收">
          <button type="button" role="tab" aria-selected={tab === 'allocation'} id="tab-allocation"
            className={tab === 'allocation' ? 'active' : ''}
            onClick={() => onTabChange('allocation')}>
            <Icon name="plus" size={14} />IP 分配<span className="n">自动 / 手动指定</span>
          </button>
          <button type="button" role="tab" aria-selected={tab === 'reclaim'} id="tab-reclaim"
            className={tab === 'reclaim' ? 'active' : ''}
            onClick={() => onTabChange('reclaim')}>
            <Icon name="undo" size={14} />IP 回收<span className="n">待回收 {status.deprecated ?? 0}</span>
          </button>
        </div>
        <span className="hint">
          全局可用地址 <b>{dash.free.toLocaleString()}</b> 个 · 切换标签保留已填内容
        </span>
      </div>

      <div className="metrics">
        <Metric label="已分配" value={status.assigned ?? 0} unit="个" icon="ip"
          foot="可发起回收" />
        <Metric label="预留" value={status.reserved ?? 0} unit="个" icon="clock"
          foot="可确认分配" />
        <Metric label="待回收" value={status.deprecated ?? 0} unit="个" icon="undo"
          foot="等待释放校验" />
        <Metric label="冲突" value={status.conflict ?? 0} unit="个" icon="alert"
          foot="需处理冲突" />
      </div>

      <div style={{ display: tab === 'allocation' ? undefined : 'none' }}>
        {isAdmin ? (
          <AllocationView embedded spaces={spaces} dash={dash} focusAddr={focusAddr}
            refreshKey={refreshKey} onChanged={onChanged} notify={notify} />
        ) : (
          <ReadOnlyAllocation spaces={spaces} focusAddr={focusAddr}
            refreshKey={refreshKey} notify={notify} />
        )}
      </div>
      <div style={{ display: tab === 'reclaim' ? undefined : 'none' }}>
        {isAdmin ? (
          <ReclaimView embedded dash={dash} focusIp={focusIp}
            refreshKey={refreshKey} onChanged={onChanged} notify={notify} />
        ) : (
          <ReadOnlyReclaim focusIp={focusIp} notify={notify} />
        )}
      </div>

      <div style={{ marginTop: 16 }}>
        <AddressTable prefix="all" actions={isAdmin} menu={isAdmin} refreshKey={refreshKey}
          onChanged={onChanged} notify={notify} onLocatePrefix={onLocatePrefix} />
      </div>
    </>
  )
}
