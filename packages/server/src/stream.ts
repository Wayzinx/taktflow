import type { EventStream } from './api-core.js'
import type { EventEnvelope } from '@taktflow/core'
import type { ServerResponse } from 'node:http'
import type { EventStore } from '@taktflow/core'

export async function stream<T extends { seq: number } = Awaited<ReturnType<EventStore['read']>>[number]>(events: { read(id: string, opts?: { afterSeq?: number }): Promise<T[]>; subscribe(id: string, onEvent: (event: T) => void): () => void }, runId: string, after: number, response: ServerResponse, connections: Set<() => void>): Promise<void> {
  if (response.destroyed) return
  let replaying = true
  let closed = false
  let last = after
  const buffered: T[] = []
  let unsubscribe: () => void = () => {}
  let timer: ReturnType<typeof setInterval> | undefined
  const cleanup = () => {
    if (closed) return
    closed = true
    unsubscribe()
    clearInterval(timer)
    connections.delete(close)
    response.off('close', cleanup)
    response.off('error', cleanup)
  }
  const close = () => { cleanup(); response.end() }
  const send = (event: T) => {
    if (closed || event.seq <= last) return
    last = event.seq
    response.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)
  }
  response.once('close', cleanup)
  response.once('error', cleanup)
  connections.add(close)
  try {
    // 先订阅，补上历史读取期间的新增事件；重复部分用 seq 去重。
    unsubscribe = events.subscribe(runId, (event) => { if (replaying) buffered.push(event); else send(event) })
    const history = await events.read(runId, { afterSeq: after })
    if (closed || response.destroyed) { cleanup(); return }
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' })
    response.flushHeaders()
    for (const event of history.sort((a, b) => a.seq - b.seq)) send(event)
    for (const event of buffered.sort((a, b) => a.seq - b.seq)) send(event)
    buffered.length = 0
    replaying = false
    timer = setInterval(() => { response.write(': keep-alive\n\n') }, 15_000)
    timer.unref()
  } catch (error) { cleanup(); throw error }
}

const HEADERS = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' }

function write(response: ServerResponse, event: { seq: number }): void {
  response.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)
}

/** 把 ApiCore.events() 的异步迭代器接到 SSE 响应上；关闭、出错和 server.close 都会释放订阅与定时器。 */
export async function streamEvents<T extends { seq: number }>(events: EventStream<T>, controller: AbortController, response: ServerResponse, connections: Set<() => void>): Promise<void> {
  if (response.destroyed) { controller.abort(); return }
  let closed = false
  let timer: ReturnType<typeof setInterval> | undefined
  const iterator = events[Symbol.asyncIterator]()
  const cleanup = () => {
    if (closed) return
    closed = true
    controller.abort()
    clearInterval(timer)
    connections.delete(close)
    response.off('close', cleanup)
    response.off('error', cleanup)
  }
  const close = () => { cleanup(); response.end() }
  response.once('close', cleanup)
  response.once('error', cleanup)
  connections.add(close)
  try {
    // 与旧实现一致：历史读取失败时还没写响应头，路由可以把错误映射成原来的 JSON 500。
    await events.ready
    if (closed || response.destroyed) return
    response.writeHead(200, HEADERS)
    response.flushHeaders()
    timer = setInterval(() => { response.write(': keep-alive\n\n') }, 15_000)
    timer.unref()
    while (!closed) {
      const next = await iterator.next()
      if (next.done) break
      if (!closed) write(response, next.value)
    }
  } catch (error) {
    cleanup()
    if (response.headersSent) { response.destroy(); return }
    throw error
  } finally {
    cleanup()
    await iterator.return?.()
  }
}
