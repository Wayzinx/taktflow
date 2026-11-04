import type { ApiError } from '@taktflow/core'
import type { DataSource } from './source'

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message)
  }
}

const enc = encodeURIComponent

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined) p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ''
}

/** 基于 fetch 的类型化客户端，路由与 packages/core/src/api.ts 顶部的接口表一一对应。 */
export function createHttpSource(base = '/api'): DataSource {
  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    const data = text ? (JSON.parse(text) as unknown) : undefined
    if (!res.ok) {
      const err = data as ApiError | undefined
      throw new ApiRequestError(res.status, err?.error ?? `${method} ${path} → ${res.status}`, err?.detail)
    }
    return data as T
  }
  const get = <T,>(path: string) => req<T>('GET', path)

  return {
    mock: false,
    project: () => get('/project'),
    requirements: () => get('/requirements'),
    requirement: (id) => get(`/requirements/${enc(id)}`),
    artifacts: (id) => get(`/requirements/${enc(id)}/artifacts`),
    artifact: (id, path, version) => get(`/requirements/${enc(id)}/artifact${qs({ path, version })}`),
    editArtifact: (id, path, body) => req('PUT', `/requirements/${enc(id)}/artifact${qs({ path })}`, body),
    comments: (id, path) => get(`/requirements/${enc(id)}/comments${qs({ path })}`),
    addComment: (id, body) => req('POST', `/requirements/${enc(id)}/comments`, body),
    trace: (id) => get(`/requirements/${enc(id)}/trace`),
    metrics: (id) => get(`/requirements/${enc(id)}/metrics`),
    runs: (requirement) => get(`/runs${qs({ requirement })}`),
    run: (runId) => get(`/runs/${enc(runId)}`),
    events: (runId, opts = {}) => get(`/runs/${enc(runId)}/events${qs({ after: opts.after, node: opts.node })}`),
    node: (runId, nodeId) => get(`/runs/${enc(runId)}/nodes/${enc(nodeId)}`),
    audit: (runId) => get(`/runs/${enc(runId)}/audit`),
    attention: (pending) => get(`/attention${qs({ pending: pending ? 1 : undefined })}`),
    answer: (requestId, body) => req('POST', `/attention/${enc(requestId)}`, body),
    subscribe(runId, onEvent) {
      const es = new EventSource(`${base}/runs/${enc(runId)}/stream`)
      es.onmessage = (m) => {
        try {
          onEvent(JSON.parse(m.data as string))
        } catch {
          // 非 JSON 的保活行忽略
        }
      }
      return () => es.close()
    },
  }
}

/** 真实 API 是否可达（1.5 秒超时）。 */
export async function probeApi(base = '/api'): Promise<boolean> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 1500)
  try {
    const res = await fetch(`${base}/project`, { signal: ctrl.signal })
    if (!res.ok) return false
    const body = (await res.json()) as { requirements?: unknown }
    return Array.isArray(body.requirements)
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
