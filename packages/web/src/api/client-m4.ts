import type { KnowledgeBuild, KnowledgePublishResponse } from '@taktflow/core'
import { currentSpaceId } from '../lib/space'
import { ApiRequestError, qs } from './client'
import type { CrudSource, KnowledgeSource, StewardSource } from './source-m4'

interface Http {
  req: <T>(method: string, path: string, body?: unknown) => Promise<T>
  get: <T>(path: string) => Promise<T>
  /** 加上 /api 与（空间内接口的）/s/:spaceId 前缀，给 EventSource 用。 */
  url: (path: string) => string
  stream: <T>(url: string, on: (v: T) => void) => () => void
  /** 管家的流：要带身份头（EventSource 带不了），用 fetch 流（api/sse.ts）。 */
  stewardStream: <T>(url: string, on: (v: T) => void) => () => void
}

const enc = encodeURIComponent
const KB = (id: string) => `/knowledge/bases/${enc(id)}`

/** M4 三节接口的 HTTP 实现（路由见 packages/core/src/api.ts 顶部的接口表）。 */
export function createM4Http({ req, get, url, stream, stewardStream }: Http): CrudSource & StewardSource & KnowledgeSource {
  return {
    // ---------------------------------------------------------------- 需求与空间增删改
    serverInfo: () => get('/server'),
    routePreviewDraft: (body) => req('POST', '/route/preview', body),
    createRequirement: (body) => req('POST', '/requirements', body),
    updateRequirement: (id, body) => req('PATCH', `/requirements/${enc(id)}`, body),
    archiveRequirement: (id, reason) => req('POST', `/requirements/${enc(id)}/archive`, { reason }),
    restoreRequirement: (id, reason) => req('POST', `/requirements/${enc(id)}/restore`, { reason }),
    deleteRequirement: (id, reason) => req('DELETE', `/requirements/${enc(id)}`, { reason }),
    createSpace: (body) => req('POST', '/spaces', body),
    updateSpace: (id, body) => req('PATCH', `/spaces/${enc(id)}`, body),
    archiveSpace: (id, reason) => req('POST', `/spaces/${enc(id)}/archive`, { reason }),
    restoreSpace: (id, reason) => req('POST', `/spaces/${enc(id)}/restore`, { reason }),
    deleteSpace: (id, body) => req('DELETE', `/spaces/${enc(id)}`, body),
    convertWorkflow: (id, body) => req('POST', `/workflows/${enc(id)}/convert`, body),

    // ---------------------------------------------------------------- 管家（全局，不加空间前缀）
    stewardThreads: () => get('/steward/threads'),
    createStewardThread: (body) => req('POST', '/steward/threads', body),
    stewardThread: (id) => get(`/steward/threads/${enc(id)}`),
    postStewardMessage: (id, body) => req('POST', `/steward/threads/${enc(id)}/messages`, body),
    subscribeSteward: (id, on) => stewardStream(url(`/steward/threads/${enc(id)}/stream`), on),
    stewardFeedback: (messageId, body) => req('POST', `/steward/messages/${enc(messageId)}/feedback`, body),
    proposals: (status) => get(`/steward/proposals${qs({ status })}`),
    approveProposal: (id, body) => req('POST', `/steward/proposals/${enc(id)}/approve`, body),
    rejectProposal: (id, reason) => req('POST', `/steward/proposals/${enc(id)}/reject`, { reason }),
    undoProposal: (id, reason) => req('POST', `/steward/proposals/${enc(id)}/undo`, { reason }),
    risks: (opts = {}) => get(`/steward/risks${qs({ space: opts.space, state: opts.state })}`),
    setRiskState: (key, body) => req('POST', `/steward/risks/${enc(key)}/state`, body),
    digest: (since, opts) => get(`/steward/digest${qs({ since, peek: opts?.peek ? 1 : undefined })}`),
    stewardFeed: () => get('/steward/feed'),
    subscribeStewardFeed: (on) => stewardStream(url('/steward/stream'), on),
    stewardPrefs: () => get('/steward/prefs'),
    saveStewardPrefs: (prefs) => req('PUT', '/steward/prefs', prefs),
    stewardProfile: () => get('/steward/profile'),
    saveStewardProfile: (content) => req('PUT', '/steward/profile', { content }),
    stewardSuggestions: ({ page, space, id }) => get(`/steward/suggestions${qs({ page, space: space ?? currentSpaceId(), id })}`),
    productMetrics: () => get('/steward/metrics'),
    reportProductEvent: (e) => req<void>('POST', '/steward/events', e).catch(() => undefined),

    // ---------------------------------------------------------------- 知识库（空间内）
    knowledgeKinds: () => get('/knowledge/kinds'),
    knowledgeBases: () => get('/knowledge/bases'),
    createKnowledgeBase: (body) => req('POST', '/knowledge/bases', body),
    knowledgeBase: (id) => get(KB(id)),
    updateKnowledgeBase: (id, body) => req('PATCH', KB(id), body),
    deleteKnowledgeBase: (id, reason) => req('DELETE', KB(id), { reason }),
    testKnowledgeBase: (id) => req('POST', `${KB(id)}/test`, {}),
    uploadKnowledge: (id, body) => req('POST', `${KB(id)}/upload`, body),
    knowledgeDocs: (id) => get(`${KB(id)}/docs`),
    startKnowledgeBuild: (id, reason) => req('POST', `${KB(id)}/builds`, { reason }),
    knowledgeBuild: (id, buildId) => get(`${KB(id)}/builds/${enc(buildId)}`),
    subscribeKnowledgeBuild: (id, buildId, on) => {
      let off = () => {}
      off = stream<KnowledgeBuild>(url(`${KB(id)}/builds/${enc(buildId)}/stream`), (b) => {
        on(b)
        if (b.status !== 'running') off()
      })
      return () => off()
    },
    cancelKnowledgeBuild: (id, buildId) => req('POST', `${KB(id)}/builds/${enc(buildId)}/cancel`, {}),
    queryKnowledge: (id, body) => req('POST', `${KB(id)}/query`, body),
    publishKnowledge: (id, body) =>
      req<KnowledgePublishResponse>('POST', `${KB(id)}/publish`, body).catch((e: unknown) => {
        if (e instanceof ApiRequestError && e.status === 409 && (e.body as KnowledgePublishResponse | undefined)?.gate) return e.body as KnowledgePublishResponse
        throw e
      }),
    knowledgeEvalSets: (id) => get(`${KB(id)}/evals`),
    saveKnowledgeEvalCases: (id, setId, cases) => req('PUT', `${KB(id)}/evals/${enc(setId)}/cases`, { cases }),
    synthesizeKnowledgeCases: (id, setId, count) => req('POST', `${KB(id)}/evals/${enc(setId)}/synthesize`, { count }),
    harvestKnowledgeCases: (id, setId) => req('POST', `${KB(id)}/evals/${enc(setId)}/harvest`, {}),
    knowledgeEvalRuns: (id) => get(`${KB(id)}/eval-runs`),
    startKnowledgeEvalRun: (id, body) => req('POST', `${KB(id)}/eval-runs`, body),
    knowledgeEvalRun: (id, runId) => get(`${KB(id)}/eval-runs/${enc(runId)}`),
    knowledgeBindings: () => get('/knowledge/bindings'),
    saveKnowledgeBindings: (bindings, reason) => req('PUT', '/knowledge/bindings', { bindings, reason }),
    knowledgeSecrets: () => get('/knowledge/secrets'),
    // 协议写的是 { value }，服务端还要求 reason（写审计）：一并带上（见 knownIssues）
    putKnowledgeSecret: (name, value) => req('PUT', `/knowledge/secrets/${enc(name)}`, { value, reason: `在知识库页面保存密钥 ${name}` }),
    migrateKnowledge: (dryRun) => req('POST', '/knowledge/migrate', { dryRun }),
  }
}
