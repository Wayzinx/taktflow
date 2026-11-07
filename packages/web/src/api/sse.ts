/**
 * 基于 fetch 的 SSE：EventSource 发不了请求头，管家的线程流 / feed 要带 `x-takt-user`（按人存的会话），
 * 否则服务端回落到缺省 owner，别人的会话一律 404（评审发现 #2）。
 * 行为对齐 EventSource：断线 3 秒后重连；4xx（除 408 / 429）不再重连，避免无限重试一个打不开的流。
 */

/** 从缓冲里切出完整的事件（空行分隔），返回每个事件的 data（多行 data 用 \n 连接）与剩余缓冲。 */
export function parseSse(buffer: string): { data: string[]; rest: string } {
  const text = buffer.replace(/\r\n?/g, '\n')
  const data: string[] = []
  let start = 0
  for (let i = text.indexOf('\n\n'); i >= 0; i = text.indexOf('\n\n', start)) {
    const block = text.slice(start, i)
    start = i + 2
    const lines = block.split('\n').filter((l) => l.startsWith('data:'))
    // 只有注释（": keep-alive"）或具名字段没有 data 时跳过
    if (lines.length) data.push(lines.map((l) => l.slice(5).replace(/^ /, '')).join('\n'))
  }
  return { data, rest: text.slice(start) }
}

export function fetchStream<T>(url: string, on: (v: T) => void, headers: () => Record<string, string>, retryMs = 3000): () => void {
  let closed = false
  let ctrl: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const connect = async () => {
    ctrl = new AbortController()
    let permanent = false
    try {
      const res = await fetch(url, { headers: { accept: 'text/event-stream', ...headers() }, signal: ctrl.signal, cache: 'no-store' })
      if (!res.ok || !res.body) {
        permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429
        throw new Error(`stream ${res.status}`)
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done || closed) break
        const parsed = parseSse(buf + value)
        buf = parsed.rest
        for (const d of parsed.data) {
          let v: T
          try {
            v = JSON.parse(d) as T
          } catch {
            continue // 非 JSON 的数据行忽略
          }
          on(v)
        }
      }
    } catch {
      // 断线 / 中止：下面统一决定是否重连
    }
    if (!closed && !permanent) timer = setTimeout(() => void connect(), retryMs)
  }
  void connect()
  return () => {
    closed = true
    clearTimeout(timer)
    ctrl?.abort()
  }
}
