import { useSyncExternalStore } from 'react'

/**
 * 与 takt serve 的连接状态（api/client 的每个请求都会报告）：网络失败（fetch 抛 TypeError、浏览器离线）→ 断开；之后任何一次请求拿到响应 → 恢复。
 * 恢复时通知 onReconnect 的订阅者（外壳据此让当前页重新取数）；顶栏节拍指示断开时显示"连接已断开"。
 */
let online = typeof navigator === 'undefined' || navigator.onLine !== false
const subs = new Set<() => void>()
const reconnects = new Set<() => void>()

export function reportConnection(ok: boolean) {
  if (ok === online) return
  online = ok
  subs.forEach((f) => f())
  if (ok) reconnects.forEach((f) => f())
}

export const isOnline = () => online

export function useOnline(): boolean {
  return useSyncExternalStore(
    (f) => {
      subs.add(f)
      return () => subs.delete(f)
    },
    () => online,
  )
}

/** 断开后恢复连接时调用 cb。 */
export function onReconnect(cb: () => void): () => void {
  reconnects.add(cb)
  return () => reconnects.delete(cb)
}

/** 网络层失败（连不上、断网），不是服务端回了错误：fetch 抛的 TypeError（Failed to fetch / NetworkError / Load failed）。 */
export function isNetworkError(e: unknown): boolean {
  if (typeof (e as { status?: unknown } | undefined)?.status === 'number') return false
  return e instanceof TypeError && /fetch|network|load failed/i.test(e.message)
}
