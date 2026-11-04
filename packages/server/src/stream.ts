import type { ServerResponse } from 'node:http'
import type { EventEnvelope, EventStore } from '@taktflow/core'

export async function stream(events: EventStore, runId: string, after: number, response: ServerResponse, connections: Set<() => void>): Promise<void> {
  if (response.destroyed) return
  let replaying = true
  let closed = false
  let last = after
  const buffered: EventEnvelope[] = []
  let unsubscribe: () => void = () => {}
  let timer: ReturnType<typeof setInterval> | undefined
  const cleanup = () => {
    if (closed) return
    closed = true
    unsubscribe()
    clearInterval(timer)
    connections.delete(close)
  }
  const close = () => { cleanup(); response.end() }
  const send = (event: EventEnvelope) => {
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
