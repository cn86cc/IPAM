import { useMemo, useState, type FormEvent } from 'react'
import { api } from '../api'
import { AdminOnly, useAuth } from '../auth'
import { Card, Drawer, Icon, MiniStat, Tag } from '../components/ui'
import { ASSET_ROLE_LABEL, type DeviceRole, type View } from '../types'
import { csvDownload, useLoad, type ViewProps } from './shared'

/** 预置角色显示中文名，自定义角色直接显示其名称（字典里保存的就是展示值）。 */
const labelOf = (key: string) => ASSET_ROLE_LABEL[key] ?? key

type Editor = { mode: 'create' | 'edit'; role?: DeviceRole } | null

/**
 * 「角色」模块（与设备 / 机柜 / 链路 / 位置同级）：维护设备表单角色下拉的选项字典。
 * 预置角色不可删除 / 改名；自定义角色可改名（自动同步已引用设备）、停用与删除。
 */
export default function DeviceRolesView({ notify, onChanged, refreshKey, onNavigate }:
  ViewProps & { onNavigate: (v: View) => void }) {
  const { isAdmin } = useAuth()
  const { data, loading, reload } = useLoad(() => api.deviceRoles(), [refreshKey], notify)
  const items = data?.items ?? []
  const stats = data?.stats
  const [q, setQ] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [editor, setEditor] = useState<Editor>(null)
  const [key, setKey] = useState('')
  const [description, setDescription] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [formError, setFormError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmKey, setConfirmKey] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return items.filter(r => {
      if (typeFilter === 'builtin' && !r.builtin) return false
      if (typeFilter === 'custom' && r.builtin) return false
      if (typeFilter === 'disabled' && r.enabled) return false
      if (!needle) return true
      return [r.key, labelOf(r.key), r.description]
        .some(v => String(v ?? '').toLowerCase().includes(needle))
    })
  }, [items, q, typeFilter])

  const distribution = useMemo(() => items
    .filter(r => r.usage > 0)
    .sort((a, b) => b.usage - a.usage)
    .slice(0, 8), [items])

  function openCreate() {
    setEditor({ mode: 'create' })
    setKey(''); setDescription(''); setEnabled(true); setFormError('')
  }

  function openEdit(row: DeviceRole) {
    setEditor({ mode: 'edit', role: row })
    setKey(row.key); setDescription(row.description); setEnabled(row.enabled)
    setFormError('')
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!editor) return
    const name = key.trim()
    if (!name) { setFormError('角色名称不能为空'); return }
    setBusy(true); setFormError('')
    try {
      const payload = { key: name, description: description.trim(), enabled }
      const res = editor.mode === 'create'
        ? await api.createDeviceRole(payload)
        : await api.updateDeviceRole(editor.role!.key, payload)
      const renamed = editor.mode === 'edit' && res.key !== editor.role!.key
      notify(`${editor.mode === 'create' ? '已新增' : '已更新'}角色：${res.key}`
        + (renamed
          ? `（${editor.role!.key} → ${res.key}，同步 ${res.references_updated ?? 0} 台设备）`
          : ''))
      setEditor(null)
      reload()
      onChanged()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  async function toggle(row: DeviceRole) {
    setBusy(true)
    try {
      await api.updateDeviceRole(row.key, { enabled: !row.enabled })
      notify(`角色「${labelOf(row.key)}」已${row.enabled ? '停用' : '启用'}`)
      reload()
      onChanged()
    } catch (err) {
      notify(err instanceof Error ? err.message : '操作失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  async function remove(row: DeviceRole) {
    setBusy(true)
    try {
      await api.deleteDeviceRole(row.key)
      notify(`已删除角色 ${labelOf(row.key)}`)
      setConfirmKey(null)
      reload()
      onChanged()
    } catch (err) {
      notify(err instanceof Error ? err.message : '删除失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  function exportCsv() {
    csvDownload('ipam-device-roles.csv',
      ['角色名称', '角色值', '类型', '状态', '引用设备数', '说明', '创建时间'],
      filtered.map(r => [labelOf(r.key), r.key, r.builtin ? '预置' : '自定义',
        r.enabled ? '启用' : '停用', r.usage, r.description, r.created_at]))
    notify(`已导出 ${filtered.length} 个角色`)
  }

  const builtinLocked = editor?.mode === 'edit' && !!editor.role?.builtin

  return (
    <>
      <div className="stat-row">
        <MiniStat label="角色总数" value={stats?.total ?? 0} tone="blue" foot="预置 + 自定义" />
        <MiniStat label="预置角色" value={stats?.builtin ?? 0} tone="teal" foot="不可删除 / 改名" />
        <MiniStat label="自定义角色" value={stats?.custom ?? 0} tone="amber" foot="可新增 / 停用 / 删除" />
        <MiniStat label="已引用角色" value={stats?.in_use ?? 0}
          foot={`覆盖 ${stats?.devices ?? 0} 台设备`} />
      </div>

      <div className="role-hint" id="role-hint">
        <Icon name="info" size={15} />
        <span>
          新建 / 编辑设备时，「角色」<b>只能下拉选择</b>，选项来自本字典中已启用的角色。
          需要新角色请在这里新增；停用后不再出现在设备下拉中，但已引用该角色的设备仍正常显示。
        </span>
      </div>

      <Card title="角色字典"
        hint={loading ? '加载中…' : `共 ${filtered.length} / ${items.length} 个角色 · 按预置优先、创建顺序排列`}>
        <div className="toolbar asset-toolbar">
          <div className="search" style={{ marginLeft: 0, width: 240 }}>
            <Icon name="search" size={14} />
            <input id="role-search" value={q} onChange={e => setQ(e.target.value)}
              placeholder="搜索角色名称 / 角色值 / 说明" />
          </div>
          <select className="asset-filter" id="role-type-filter" value={typeFilter}
            onChange={e => setTypeFilter(e.target.value)}>
            <option value="all">全部角色</option>
            <option value="builtin">仅预置角色</option>
            <option value="custom">仅自定义角色</option>
            <option value="disabled">仅已停用</option>
          </select>
          <span className="spacer" />
          <button className="btn sm" id="role-goto-devices" onClick={() => onNavigate('devices')}>
            <Icon name="cpu" size={13} />设备清单
          </button>
          <button className="btn sm" id="role-export" onClick={exportCsv}>
            <Icon name="download" size={13} />导出 CSV
          </button>
          <AdminOnly>
            <button className="btn sm primary" id="role-create" onClick={openCreate}>
              <Icon name="plus" size={13} />新建角色
            </button>
          </AdminOnly>
        </div>

        {filtered.length === 0
          ? <div className="empty">{loading ? '正在加载…' : '当前筛选条件下没有角色'}</div>
          : (
            <div className="asset-table-wrap">
              <table className="asset-table role-table">
                <thead><tr>
                  <th>角色名称 / 值</th>
                  <th>类型</th>
                  <th>状态</th>
                  <th>引用设备</th>
                  <th>说明</th>
                  <th>创建时间</th>
                  <th>操作</th>
                </tr></thead>
                <tbody>
                  {filtered.map(r => (
                    <tr key={r.key}>
                      <td>
                        <div className="asset-primary">
                          <b>{labelOf(r.key)}</b>
                          {labelOf(r.key) !== r.key && <small className="mono">{r.key}</small>}
                          {labelOf(r.key) === r.key && !r.builtin && <small>自定义角色值</small>}
                        </div>
                      </td>
                      <td><Tag text={r.builtin ? '预置' : '自定义'} tone={r.builtin ? 'blue' : 'amber'} /></td>
                      <td><Tag text={r.enabled ? '启用' : '停用'} tone={r.enabled ? 'teal' : 'neutral'} /></td>
                      <td><b className="mono">{r.usage}</b> 台</td>
                      <td className="role-desc">{r.description || '—'}</td>
                      <td className="mono role-time">{r.created_at || '—'}</td>
                      <td>
                        {isAdmin && confirmKey === r.key ? (
                          <span className="asset-confirm">
                            <span>确认删除？</span>
                            <button className="row-act danger" id={`role-del-yes-${r.key}`}
                              disabled={busy} onClick={() => void remove(r)}>确认</button>
                            <button className="row-act" onClick={() => setConfirmKey(null)}>取消</button>
                          </span>
                        ) : (
                          <span className="asset-row-actions">
                            {isAdmin ? (
                              <>
                                <button className="row-act" id={`role-edit-${r.key}`}
                                  onClick={() => openEdit(r)}>编辑</button>
                                <button className="row-act" id={`role-toggle-${r.key}`}
                                  disabled={busy} onClick={() => void toggle(r)}>
                                  {r.enabled ? '停用' : '启用'}
                                </button>
                                {!r.builtin && (
                                  <button className="row-act danger" id={`role-del-${r.key}`}
                                    disabled={r.usage > 0}
                                    title={r.usage > 0
                                      ? `已被 ${r.usage} 台设备引用，请先修改角色或停用`
                                      : '删除该自定义角色'}
                                    onClick={() => setConfirmKey(r.key)}>删除</button>
                                )}
                              </>
                            ) : <span className="muted">只读</span>}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Card>

      <div className="grid-2 asset-bottom">
        <Card title="角色引用分布" hint="按引用设备台数降序 · Top 8">
          {distribution.length === 0
            ? <div className="empty">暂无设备引用角色</div>
            : distribution.map(r => (
              <div className="rank-row" key={r.key}>
                <div className="label"><b>{labelOf(r.key)}</b></div>
                <div className="track">
                  <i style={{ width: `${stats?.devices ? r.usage / stats.devices * 100 : 0}%`,
                    background: 'var(--blue)' }} />
                </div>
                <div className="pct mono">{r.usage}</div>
              </div>
            ))}
        </Card>
        <Card title="与设备表单的关系" hint="02 业务能力层">
          <div className="asset-relation">
            <div className="asset-relation-row"><Icon name="tag" size={15} />
              <span><b>唯一来源</b>：设备清单与机柜二级页的角色下拉，只列出本字典中已启用的角色；后端写入时同样校验，避免下拉与库内值不一致。</span></div>
            <div className="asset-relation-row"><Icon name="shield" size={15} />
              <span><b>预置保护</b>：8 个预置角色不可删除 / 改名，可停用；停用后历史设备仍显示原角色。</span></div>
            <div className="asset-relation-row"><Icon name="edit" size={15} />
              <span><b>改名级联</b>：自定义角色改名时，后端在同一事务内同步全部已引用设备的角色值。</span></div>
            <div className="asset-relation-row"><Icon name="trash" size={15} />
              <span><b>删除保护</b>：仅未被任何设备引用的自定义角色可删除；已引用的角色请先改角色或停用。</span></div>
          </div>
          <div className="asset-rel-actions">
            <button className="btn sm" onClick={() => onNavigate('devices')}>查看设备清单</button>
            <button className="btn sm" onClick={() => onNavigate('racks')}>机柜正视图</button>
          </div>
        </Card>
      </div>

      <Drawer open={!!editor}
        title={`${editor?.mode === 'create' ? '新建' : '编辑'}角色`}
        sub={editor?.mode === 'create'
          ? '保存后即可在新建 / 编辑设备的角色下拉中选择'
          : `角色值 ${editor?.role?.key}${builtinLocked ? ' · 预置角色名称不可修改' : ' · 改名将同步已引用设备'}`}
        onClose={() => setEditor(null)}>
        <form id="role-form" onSubmit={save}>
          <div className="field">
            <label>角色名称 <b className="req">*</b></label>
            <input id="role-key" value={key} maxLength={64} disabled={builtinLocked}
              onChange={e => setKey(e.target.value)}
              placeholder="例如 边缘网关 / edge_gateway" />
            <div className="help">
              2–64 个字符，支持中英文、数字、. _ - 与空格；该名称同时是设备记录中保存的角色值。
              {editor?.mode === 'edit' && !builtinLocked
                ? ' 修改后自动同步所有引用该角色的设备。'
                : ''}
            </div>
          </div>
          <div className="field">
            <label>角色说明</label>
            <input id="role-description" value={description} maxLength={128}
              onChange={e => setDescription(e.target.value)}
              placeholder="例如 园区出口边缘网关设备" />
            <div className="help">选填，最多 128 个字符，仅用于字典页展示。</div>
          </div>
          <div className="field">
            <label>下拉可用状态</label>
            <select id="role-enabled" value={enabled ? '1' : '0'}
              onChange={e => setEnabled(e.target.value === '1')}>
              <option value="1">启用 · 出现在角色下拉中</option>
              <option value="0">停用 · 保留历史引用但不在下拉中显示</option>
            </select>
            <div className="help">停用不会修改已使用该角色的设备，仅从新建 / 编辑设备的可选项中移除。</div>
          </div>
          {formError && <div className="check-note bad" id="role-form-error">{formError}</div>}
          <div className="drawer-actions">
            <button type="button" className="btn ghost" onClick={() => setEditor(null)}>取消</button>
            <button type="submit" className="btn primary" id="role-save" disabled={busy}>
              {busy ? '保存中…' : '保存'}
            </button>
          </div>
        </form>
      </Drawer>
    </>
  )
}
