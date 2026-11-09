import type { ApiError, LeadPresence, RoomMessage, WorkflowConflict } from '@taktflow/core'
import { currentSpaceId } from '../lib/space'
import { actingUserHeader } from '../lib/acting-user'
import { createM4Http } from './client-m4'
import { createM5Http } from './client-m5'
import { createM6Http } from './client-m6'
import { createM8Http } from './client-m8'
import { fetchStream } from './sse'
import { WorkflowConflictError, type DataSource, type EvalOutputSnapshot } from './source'

/** 调用方已带 reason（以后协议补上字段时）就用它，否则用按操作生成的说明。 */
const auditReason = (body: object, fallback: string): string => {
  const r = (body as { reason?: unknown }).reason
  return typeof r === 'string' && r.trim() ? r : fallback
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: unknown,
    /** 原始响应体（例如知识库发布 409 的 KnowledgePublishResponse）。 */
    readonly body?: unknown,
  ) {
    super(message)
  }
}

const enc = encodeURIComponent

/** 全局接口：管家、空间列表与增删改、服务信息，不加 /s/:spaceId 前缀（docs/design/22）。 */
const GLOBAL_PATH = /^\/(steward|spaces|server)(\/|\?|$)/
/** 管家接口：按人存，用全局身份（lib/acting-user 的 stewardUser），不按空间取。 */
const STEWARD_PATH = /^\/steward(\/|\?|$)/

export function qs(params: Record<string, string | number | boolean | undefined>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined) p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ''
}

/** 基于 fetch 的类型化客户端，路由与 packages/core/src/api.ts 顶部的接口表一一对应。 */
export function createHttpSource(base = '/api', space?: string): DataSource {
  // 多空间：当前 URL 带 /s/:spaceId 时空间内接口加同样的前缀；全局接口（GLOBAL_PATH）不加。绑定了空间（forSpace）时用绑定的
  const scoped = (path: string) => {
    const sid = space ?? currentSpaceId()
    return sid && !GLOBAL_PATH.test(path) ? `${base}/s/${enc(sid)}${path}` : base + path
  }
  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    // 服务端 validateWriteRequest 要求所有写请求都是 application/json（无 body 的 POST 会 415）：写方法没给 body 时发 {}
    const write = method !== 'GET' && method !== 'HEAD'
    const payload = body === undefined ? (write ? {} : undefined) : body
    const res = await fetch(scoped(path), {
      method,
      headers: { ...actingUserHeader(STEWARD_PATH.test(path)), ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    })
    const text = await res.text()
    const data = text ? (JSON.parse(text) as unknown) : undefined
    if (res.status === 409 && (data as WorkflowConflict | undefined)?.error === 'conflict') throw new WorkflowConflictError(data as WorkflowConflict)
    if (!res.ok) {
      const err = data as ApiError | undefined
      throw new ApiRequestError(res.status, err?.error ?? `${method} ${path} → ${res.status}`, err?.detail, data)
    }
    return data as T
  }
  const get = <T,>(path: string) => req<T>('GET', path)

  const bound = new Map<string, DataSource>()
  return {
    mock: false,
    forSpace: (id) => bound.get(id) ?? bound.set(id, createHttpSource(base, id)).get(id)!,
    project: () => get('/project'),
    me: () => get('/me'),
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
    harnesses: () => get('/harnesses'),
    models: () => get('/models'),
    subscribe: (runId, onEvent) => stream(scoped(`/runs/${enc(runId)}/stream`), onEvent),
    spaces: (opts) => get(`/spaces${qs({ archived: opts?.archived ? 1 : undefined })}`),
    space: () => get('/space'),
    // 服务端成员接口接受数组 + x-takt-reason 头，或 { members, reason }；用 body 形式，避免非 ASCII 原因放进请求头
    setMembers: (members, reason) => req('PUT', '/space/members', { members, reason }),
    addRepo: (repo, reason) => req('POST', '/space/repos', { ...repo, reason }),
    updateRepo: (repoId, patch, reason) => req('PATCH', `/space/repos/${enc(repoId)}`, { ...patch, reason }),
    syncRepo: (repoId, reason) => req('POST', `/space/repos/${enc(repoId)}/sync`, { reason }),
    spaceFile: (kind, name) => get(`/space/files${qs({ kind, name })}`),
    saveSpaceFile: (kind, name, body) => req('PUT', `/space/files${qs({ kind, name })}`, body),
    room: (id) => get(`/requirements/${enc(id)}/room`),
    addRoomMembers: (id, members) => req('POST', `/requirements/${enc(id)}/room/members`, members),
    chat: (id, opts = {}) => get(`/requirements/${enc(id)}/chat${qs({ after: opts.after, limit: opts.limit })}`),
    postChat: (id, body) => req('POST', `/requirements/${enc(id)}/chat`, body),
    subscribeChat: (id, onMessage, onLead) => stream<RoomMessage>(scoped(`/requirements/${enc(id)}/chat/stream`), onMessage, onLead && { lead: (d) => onLead(d as LeadPresence) }),
    requirementReviews: (id) => get(`/requirements/${enc(id)}/reviews`),
    disposeReview: (runId, nodeId, body) => req('POST', `/runs/${enc(runId)}/nodes/${enc(nodeId)}/dispositions`, body),
    routePreview: (id, body) => req('POST', `/requirements/${enc(id)}/route`, body),
    commands: () => get('/commands'),
    runCommand: (id, body) => req('POST', `/commands/${enc(id)}`, body),
    lessons: (status) => get(`/lessons${qs({ status })}`),
    updateLesson: (id, body) => req('PATCH', `/lessons/${enc(id)}`, body),
    scorecards: (by, workflow) => get(`/eval/scorecards${qs({ by, workflow })}`),
    evalCases: (target, opts) => get(`/eval/cases${qs({ target, retired: opts?.retired ? '1' : undefined })}`),
    // 评测 / 缺陷的写操作在服务端走写命令（eval.* / defect.*），注册表要求非空 reason，但 api.ts 的请求体没有这个字段：
    // 先由客户端按操作内容生成审计原因（见交付说明的协议变更请求），协议补上后改成界面收集。
    collectEvalCases: (body) => req('POST', '/eval/cases/collect', { ...body, reason: auditReason(body, '从历史与缺陷收集评测用例') }),
    evalRuns: () => get('/eval/runs'),
    evalRun: (id) => get(`/eval/runs/${enc(id)}`),
    startEvalRun: (body) => req('POST', '/eval/runs', { ...body, reason: auditReason(body, `回放评测：${body.variants.map((v) => v.label).join(' / ')}`) }),
    evalOutput: (runId, caseId, variant) =>
      get<EvalOutputSnapshot>(`/eval/runs/${enc(runId)}/output${qs({ case: caseId, variant })}`).catch((e: unknown) => {
        if (e instanceof ApiRequestError && e.status === 404) return { runId, caseId, variant, files: [] }
        throw e
      }),
    defects: (id) => get(`/requirements/${enc(id)}/defects`),
    reportDefect: (id, body) => req('POST', `/requirements/${enc(id)}/defects`, { ...body, reason: auditReason(body, `录入逃逸缺陷：${body.title}`) }),
    attributeDefect: (id, defectId) => req('POST', `/requirements/${enc(id)}/defects/${enc(defectId)}/attribute`, { reason: `发起缺陷 ${defectId} 的归因` }),
    confirmDefect: (id, defectId, body) =>
      req('POST', `/requirements/${enc(id)}/defects/${enc(defectId)}/confirm`, { ...body, reason: auditReason(body, body.note?.trim() || `确认缺陷 ${defectId} 的归因${body.attribution ? '（含人工修改）' : ''}`) }),
    workflows: () => get('/workflows'),
    workflow: (id) => get(`/workflows/${enc(id)}`),
    editWorkflow: (id, body) => req('PATCH', `/workflows/${enc(id)}`, body),
    replaceWorkflowSource: (id, body) => req('PUT', `/workflows/${enc(id)}/source`, body),
    saveWorkflowLayout: (id, layout) => req('PUT', `/workflows/${enc(id)}/layout`, layout),
    workflowRevisions: (id) => get(`/workflows/${enc(id)}/revisions`),
    workflowRevision: (id, rev) => get(`/workflows/${enc(id)}/revisions/${enc(rev)}`),
    rollbackWorkflow: (id, body) => req('POST', `/workflows/${enc(id)}/rollback`, body),
    subscribeWorkflow: (id, onChange) => stream(scoped(`/workflows/${enc(id)}/stream`), onChange),
    ...createM4Http({ req, get, url: scoped, stream, stewardStream: (url, on) => fetchStream(url, on, () => actingUserHeader(true)) }),
    ...createM5Http({ req, get }),
    ...createM6Http({ req, get }),
    ...createM8Http({ req, get }),
  }
}

/** SSE：默认事件（无 event: 行）交给 on；named 里的具名事件（如群聊的 `event: lead`）分别处理。 */
export function stream<T>(url: string, on: (v: T) => void, named?: Record<string, (data: unknown) => void>): () => void {
  const es = new EventSource(url)
  const parse = (raw: unknown, fn: (v: never) => void) => {
    try {
      fn(JSON.parse(raw as string) as never)
    } catch {
      // 非 JSON 的保活行忽略
    }
  }
  es.onmessage = (m) => parse(m.data, on)
  for (const [name, fn] of Object.entries(named ?? {})) es.addEventListener(name, (m) => parse((m as MessageEvent).data, fn))
  return () => es.close()
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
