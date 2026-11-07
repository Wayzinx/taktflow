import type { ApiError, LeadPresence, RoomMessage, WorkflowConflict } from '@taktflow/core'
import { currentSpaceId } from '../lib/space'
import { actingUserHeader } from '../lib/acting-user'
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
  // 多空间：当前 URL 带 /s/:spaceId 时所有接口加同样的前缀；/spaces 列表本身不加
  const scoped = (path: string) => {
    const sid = currentSpaceId()
    return sid && path !== '/spaces' ? `${base}/s/${enc(sid)}${path}` : base + path
  }
  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(scoped(path), {
      method,
      headers: { ...actingUserHeader(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    const data = text ? (JSON.parse(text) as unknown) : undefined
    if (res.status === 409 && (data as WorkflowConflict | undefined)?.error === 'conflict') throw new WorkflowConflictError(data as WorkflowConflict)
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
    spaces: () => get('/spaces'),
    space: () => get('/space'),
    // 服务端成员接口接受数组 + x-takt-reason 头，或 { members, reason }；用 body 形式，避免非 ASCII 原因放进请求头
    setMembers: (members, reason) => req('PUT', '/space/members', { members, reason }),
    addRepo: (repo, reason) => req('POST', '/space/repos', { ...repo, reason }),
    updateRepo: (repoId, patch, reason) => req('PATCH', `/space/repos/${enc(repoId)}`, { ...patch, reason }),
    syncRepo: (repoId, reason) => req('POST', `/space/repos/${enc(repoId)}/sync`, { reason }),
    spaceFile: (kind, name) => get(`/space/files${qs({ kind, name })}`),
    saveSpaceFile: (kind, name, body) => req('PUT', `/space/files${qs({ kind, name })}`, body),
    host: { kind: 'standalone', manageRuntime: true, manageMembers: true },
    settings: () => get('/space/settings'),
    updateConfig: (patch, reason) => req('PATCH', '/space/config', { patch, reason }),
    saveRole: (role, body) => req('PUT', `/space/agents/${enc(role)}`, body),
    deleteRole: (role, reason) => req('POST', `/space/agents/${enc(role)}/delete`, { reason }),
    saveSkill: (name, body) => req('PUT', `/space/skills/${enc(name)}`, body),
    deleteSkill: (name, reason) => req('POST', `/space/skills/${enc(name)}/delete`, { reason }),
    fileRevisions: (kind, name) => get(`/space/revisions${qs({ kind, name })}`),
    rollbackFile: (kind, name, rev, reason) => req('POST', `/space/revisions/rollback${qs({ kind, name })}`, { rev, reason }),
    createWorkflow: (body) => req('POST', '/workflows', body),
    updateWorkflowMeta: (id, body) => req('PATCH', `/workflows/${enc(id)}/meta`, body),
    deleteWorkflow: (id, reason) => req('POST', `/workflows/${enc(id)}/delete`, { reason }),
    upgradeSpace: (dryRun, reason) => req('POST', '/space/upgrade', { dryRun, reason }),
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
    evalCases: (target) => get(`/eval/cases${qs({ target })}`),
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
  }
}

/** SSE：默认事件（无 event: 行）交给 on；named 里的具名事件（如群聊的 `event: lead`）分别处理。 */
function stream<T>(url: string, on: (v: T) => void, named?: Record<string, (data: unknown) => void>): () => void {
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
