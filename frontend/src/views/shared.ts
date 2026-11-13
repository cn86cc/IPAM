import { useCallback, useEffect, useState } from 'react'
import type { Prefix } from '../types'

export type Notify = (msg: string, kind?: 'ok' | 'error') => void

export interface ViewProps {
  notify: Notify
  onChanged: () => void
  refreshKey: number
}

/** 统一的数据加载：依赖变化或手动 reload 时重新拉取，卸载后不再 setState。 */
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[], notify: Notify) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick(t => t + 1), [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    loader()
      .then(res => { if (alive) setData(res) })
      .catch(err => { if (alive) notify(err instanceof Error ? err.message : '加载失败', 'error') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, notify])

  return { data, loading, reload }
}

export function csvDownload(filename: string, headers: string[], rows: (string | number)[][]) {
  const esc = (v: string | number) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const text = '\uFEFF' + [headers, ...rows].map(r => r.map(esc).join(',')).join('\r\n')
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export function shortTime(ts: string | null): string {
  return ts ? ts.slice(5, 16) : '—'
}

/**
 * 机柜物理尺寸与固定比例尺（工程制图口径，所有视图共用）。
 * 1U = 44.45 mm；19 英寸安装有效宽度 = 482.6 mm；外壳宽度 = 800 mm。
 * 视图只用固定 px 尺寸，不做任何按容器 / 页面宽度的自适应缩放：
 * 正视图 1U = 32px，位置平面图为固定 1:2 缩尺（1U = 16px），两者长宽比完全一致。
 */
export const RACK_MM = {
  uHeight: 44.45,
  mountWidth: 19 * 25.4,
  outerWidth: 800,
} as const

export interface RackScale {
  uPx: number
  mountPx: number
  outerPx: number
  sidePx: number
  pxPerMm: number
  label: string
}

function makeRackScale(uPx: number, label: string): RackScale {
  const pxPerMm = uPx / RACK_MM.uHeight
  const mountPx = RACK_MM.mountWidth * pxPerMm
  const outerPx = RACK_MM.outerWidth * pxPerMm
  return { uPx, mountPx, outerPx, sidePx: (outerPx - mountPx) / 2, pxPerMm, label }
}

/** 机柜正视图：1U = 32px，外壳 576px，19″ 安装区 347px。 */
export const RACK_DETAIL_SCALE = makeRackScale(32, '正视图 · 1U = 32px')
/** 位置机柜平面图：固定 1:2 缩尺，1U = 16px，外壳 288px，19″ 安装区 174px。 */
export const RACK_FLOOR_SCALE = makeRackScale(16, '平面图 · 固定 1:2 缩尺，1U = 16px')

export function rackHeightMm(units: number): number {
  return units * RACK_MM.uHeight
}

/** 按 CIDR 数值排序前缀，供地址空间树、分配页等复用。 */
export function sortPrefixes(list: Prefix[]): Prefix[] {
  const key = (cidr: string) => {
    const o = cidr.split('/')[0].split('.').map(Number)
    return ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3]
  }
  return [...list].sort((a, b) => key(a.cidr) - key(b.cidr))
}
