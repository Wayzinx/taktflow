import { ApiRequestError, qs } from './client'
import { RevisionConflictError, RewindConflictError, type M5Source } from './source-m5'

interface Http {
  req: <T>(method: string, path: string, body?: unknown) => Promise<T>
  get: <T>(path: string) => Promise<T>
}

const enc = encodeURIComponent
const NODE = (runId: string, nodeId: string) => `/runs/${enc(runId)}/nodes/${enc(nodeId)}`
const DEFECT = (id: string, defectId: string) => `/requirements/${enc(id)}/defects/${enc(defectId)}`

/** 409 换成调用方能认的错误类型；其它错误原样抛出。 */
function on409<T>(p: Promise<T>, err: (message: string) => Error): Promise<T> {
  return p.catch((e: unknown) => {
    if (e instanceof ApiRequestError && e.status === 409) throw err(e.message)
    throw e
  })
}

/** M5 接口的 HTTP 实现（docs/design/21、26）。 */
export function createM5Http({ req, get }: Http): M5Source {
  return {
    timeline: (runId) => get(`/runs/${enc(runId)}/timeline`),
    nodeChanges: (runId, nodeId) => get(`${NODE(runId, nodeId)}/changes`),
    nodeDiff: (runId, nodeId, path) => get(`${NODE(runId, nodeId)}/diff${qs({ path })}`),
    rewindPreview: (runId, nodeId) => req('POST', `${NODE(runId, nodeId)}/rewind/preview`),
    rewind: (runId, nodeId, body) => on409(req('POST', `${NODE(runId, nodeId)}/rewind`, body), (m) => new RewindConflictError(m)),
    resendDelegation: (messageId, reason) => req('POST', `/steward/delegations/${enc(messageId)}/resend`, { reason }),
    resendRoomTask: (id, messageId, reason) => req('POST', `/requirements/${enc(id)}/room/tasks/${enc(messageId)}/resend`, { reason }),

    snapshot: (runId, checkpointId) => get(`/runs/${enc(runId)}/snapshots/${enc(checkpointId)}`),
    snapshotFile: (runId, checkpointId, path) => get(`/runs/${enc(runId)}/snapshots/${enc(checkpointId)}/file${qs({ path })}`),
    observations: (id, opts = {}) => get(`/requirements/${enc(id)}/observations${qs({ source: opts.source, run: opts.run })}`),
    updateDefect: (id, defectId, body) => on409(req('PATCH', DEFECT(id, defectId), body), (m) => new RevisionConflictError(m)),
    mergeSuggestions: (id) => get(`/requirements/${enc(id)}/defects/merge-suggestions`),
    decideMerge: (id, sid, body) => req('POST', `/requirements/${enc(id)}/defects/merge-suggestions/${enc(sid)}`, body),
    decideMiss: (id, defectId, checkpointId, body) => req('POST', `${DEFECT(id, defectId)}/checkpoints/${enc(checkpointId)}`, body),
    createEvalSample: (body) => req('POST', '/eval/samples', body),
    retireEvalSample: (caseId, reason) => req('POST', `/eval/samples/${enc(caseId)}/retire`, { reason }),
    qualityStatus: () => get('/quality/status'),
    syncQuality: (body) => req('POST', '/quality/sync', body),
    repairQuality: (reason) => req('POST', '/quality/repair', { reason }),
  }
}
