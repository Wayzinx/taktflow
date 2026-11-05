import type { EventEnvelope } from '@taktflow/core'

export interface EventFeed {
  /** 历史读取完成；读失败时 reject。完成后新增事件直接交给 receive。 */
  readonly ready: Promise<void>
  close(): void
}

/**
 * 先订阅再读历史，补上读取期间新增的事件；历史与缓冲合并排序，按 seq 去重。
 * receive 在 ready 完成前就可能被调用（历史回放），调用方需要自行缓冲或直接写出。
 */
export interface SequenceSource<T> {
  read(id: string, opts?: { afterSeq?: number }): Promise<T[]>
  subscribe(id: string, onEvent: (event: T) => void): () => void
}

export function createEventFeed<T extends { seq: number } = EventEnvelope>(events: SequenceSource<T>, runId: string, after: number, receive: (event: T) => void): EventFeed {
  let replaying = true
  let closed = false
  let last = after
  let unsubscribe: () => void = () => {}
  const buffered: T[] = []
  const send = (event: T) => {
    if (closed || event.seq <= last) return
    last = event.seq
    receive(event)
  }
  const close = () => {
    if (closed) return
    closed = true
    unsubscribe()
  }
  const ready = (async () => {
    unsubscribe = events.subscribe(runId, (event) => {
      if (replaying) buffered.push(event)
      else send(event)
    })
    try {
      const history = await events.read(runId, { afterSeq: after })
      if (closed) return
      // 回放期间不会插入异步点，合并后的同步循环里也不会再收到实时事件。
      for (const event of [...history, ...buffered].sort((a, b) => a.seq - b.seq)) send(event)
      buffered.length = 0
      replaying = false
    } catch (error) {
      close()
      throw error
    }
  })()
  return { ready, close }
}
