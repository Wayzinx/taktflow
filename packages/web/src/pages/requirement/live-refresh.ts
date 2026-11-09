import type { EventEnvelope } from '@taktflow/core'

/** 运行事件成串到达时合并成一次本地重拉；run.finished 不等待窗口。 */
export const LIVE_REFRESH_DEBOUNCE_MS = 400

export interface RequirementLiveRefreshOptions {
  /** 当前跟踪的最近一次运行；事件里 runId 不匹配的（切换前后的残留）忽略。 */
  runId: string
  subscribe: (runId: string, onEvent: (e: EventEnvelope) => void) => () => void
  /** 本地重拉需求与最近运行；不要用全局 invalidate。 */
  refresh: () => void
  debounceMs?: number
}

/**
 * 需求页的运行实时刷新：订阅当前运行的 SSE，普通事件合并成一次本地重拉；
 * run.finished 立即重拉（刷新后运行已是终态，调用方据此取消订阅）。
 * 先订阅再补拉一次，避免首次拉取与订阅之间发生的变化永远看不到。
 * 返回清理函数：取消订阅并丢弃未到期的合并刷新。
 */
export function startRequirementLiveRefresh(options: RequirementLiveRefreshOptions): () => void {
  const { runId, subscribe, refresh, debounceMs = LIVE_REFRESH_DEBOUNCE_MS } = options
  let active = true
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = () => {
    timer = undefined
    if (active) refresh()
  }

  const off = subscribe(runId, (event) => {
    // 订阅本身绑在 runId 上，但重放/残留事件仍可能带别的运行：只认当前运行。
    if (!active || event.runId !== runId) return
    if (event.type === 'run.finished') {
      if (timer !== undefined) clearTimeout(timer)
      flush()
      return
    }
    if (timer !== undefined) return
    timer = setTimeout(flush, debounceMs)
  })

  // 订阅建立之后再补拉，覆盖首屏请求与订阅之间发生的状态变化。
  refresh()

  return () => {
    active = false
    off()
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
}
