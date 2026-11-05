import type { ServerResponse } from 'node:http'

export function liveStream<T>(response: ServerResponse, connections: Set<() => void>, subscribe: (send: (value: T) => void, fail: (error: unknown) => void) => () => void) {
  let closed = false
  let unsubscribe = () => {}
  let timer: ReturnType<typeof setInterval> | undefined
  const close = () => {
    if (closed) return
    closed = true
    unsubscribe(); clearInterval(timer); connections.delete(close)
    response.end()
  }
  const fail = () => { close() }
  response.once('close', close); response.once('error', close)
  connections.add(close)
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
  response.flushHeaders()
  try {
    unsubscribe = subscribe((value) => { if (!closed) response.write(`data: ${JSON.stringify(value)}\n\n`) }, fail)
    timer = setInterval(() => response.write(': keep-alive\n\n'), 15000)
    timer.unref()
  } catch (error) { close(); throw error }
}
