/** 质量日志页的读数：大数带千分位；每个运行的入账进度（服务端给出事件总数时算落后多少）。 */

export const fmtCount = (n: number) => n.toLocaleString('zh-CN')

export interface CursorState {
  /** 落后的事件数；服务端没给总数时为 undefined（看不出是否落后）。 */
  behind?: number
  text: string
  /** 只有落后或看不出时才给"补算"。 */
  canSync: boolean
}

export function cursorState(seq: number, head?: number): CursorState {
  if (head === undefined) return { text: `已入账到第 ${fmtCount(seq)} 条事件 · 总数未提供，暂无法判断是否落后`, canSync: true }
  const behind = Math.max(0, head - seq)
  return behind
    ? { behind, text: `已入账 ${fmtCount(seq)} / 共 ${fmtCount(head)} 条事件，落后 ${fmtCount(behind)} 条`, canSync: true }
    : { behind, text: `已入账 ${fmtCount(seq)} / 共 ${fmtCount(head)} 条事件，已追平`, canSync: false }
}
