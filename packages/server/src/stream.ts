import type { ServerResponse } from 'node:http'
import type { EventEnvelope, EventStore } from '@taktflow/core'
import type { EventStream } from './api-core.js'
import { createEventFeed } from './event-feed.js'

const HEADERS = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' }

function write(response: ServerResponse, event: EventEnvelope): void {
  response.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)
}

/** 兼容旧入口：历史先缓冲，写完 SSE 响应头后再同步回放；实时事件继续同步写出。 */
export async function stream(events: EventStore, runId: string, after: number, response: ServerResponse, connections: Set<() => void>): Promise<void> {
  if (response.destroyed) return
  let closed = false
  let streaming = false
  let timer: ReturnType<typeof setInterval> | undefined
  const buffered: EventEnvelope[] = []
  // 真实 ServerResponse 第一次 write 就会提交隐式响应头，所以历史必须先缓冲到 writeHead 之后。
  const feed = createEventFeed(events, runId, after, (event) => {
    if (closed) return
    if (streaming) write(response, event)
    else buffered.push(event)
  })
  const cleanup = () => {
    if (closed) return
    closed = true
    feed.close()
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
    await feed.ready
    if (closed || response.destroyed) { cleanup(); return }
    response.writeHead(200, HEADERS)
    response.flushHeaders()
    streaming = true
    for (const event of buffered) write(response, event)
    buffered.length = 0
    timer = setInterval(() => { response.write(': keep-alive\n\n') }, 15_000)
    timer.unref()
  } catch (error) {
    cleanup()
    throw error
  }
}

/** 把 ApiCore.events() 的异步迭代器接到 SSE 响应上；关闭、出错和 server.close 都会释放订阅与定时器。 */
export async function streamEvents(events: EventStream, controller: AbortController, response: ServerResponse, connections: Set<() => void>): Promise<void> {
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
