/**
 * 同一浏览器里的多个标签页（以及同一标签里的多个订阅者）共用一条长连接。
 * 浏览器对同一地址最多 6 条 HTTP/1.1 连接、所有标签共用：每个标签各连一条管家流，开四五个标签，普通请求就排队、页面停在骨架上。
 * 做法：按 key 用 Web Locks 选一个标签去连，收到的消息直接交给本标签的订阅者，再经 BroadcastChannel 转给其他标签；
 * 持有连接的标签退订（关掉、隐藏够久）时释放锁，排队的标签接手重连。只用于没有游标、不回放历史的流（管家的动态流、会话流）。
 */

type Open<T> = (emit: (v: T) => void) => () => void

interface Hub {
  listeners: Set<(v: unknown) => void>
  stop: () => void
}

const hubs = new Map<string, Hub>()

/** 订阅 key 对应的共享流；没有 Web Locks / BroadcastChannel 的环境直接各连各的。返回值退订。 */
export function sharedStream<T>(key: string, open: Open<T>, on: (v: T) => void): () => void {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (!locks || typeof BroadcastChannel === 'undefined') return open(on)
  let hub = hubs.get(key)
  if (!hub) {
    hub = startHub(key, open as Open<unknown>, locks)
    hubs.set(key, hub)
  }
  const h = hub
  const listener = on as (v: unknown) => void
  h.listeners.add(listener)
  return () => {
    if (!h.listeners.delete(listener) || h.listeners.size) return
    if (hubs.get(key) === h) hubs.delete(key)
    h.stop()
  }
}

function startHub(key: string, open: Open<unknown>, locks: LockManager): Hub {
  const listeners = new Set<(v: unknown) => void>()
  const deliver = (v: unknown) => {
    for (const l of [...listeners]) l(v)
  }
  const channel = new BroadcastChannel(`takt-stream:${key}`)
  channel.onmessage = (e: MessageEvent) => deliver(e.data)
  const ctrl = new AbortController()
  let stopped = false
  let release: (() => void) | undefined
  let close: (() => void) | undefined
  locks
    .request(`takt-stream:${key}`, { signal: ctrl.signal }, () => {
      // 退订和拿到锁同时发生：不再连，立刻把锁让给下一个标签
      if (stopped) return undefined
      return new Promise<void>((resolve) => {
        release = resolve
        close = open((v) => {
          deliver(v)
          try {
            channel.postMessage(v)
          } catch {
            // 频道已关（正在退订）
          }
        })
      })
    })
    .catch(() => undefined) // 还在排队时退订：AbortError
  return {
    listeners,
    stop: () => {
      stopped = true
      ctrl.abort()
      close?.()
      release?.()
      channel.close()
    },
  }
}
