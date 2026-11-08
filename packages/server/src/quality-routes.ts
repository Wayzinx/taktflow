import { isUtf8 } from 'node:buffer'
import {
  nodeQuality, snapshotMaterials, qualityStatus, syncQuality, repairQuality, QualityConflictError, RewindConflictError,
  type Observation, type SnapshotManifest, type ArtifactContent,
} from '@taktflow/core'
import { actor, artifactPath, body, HttpError, text } from './http.js'
import { requirement, run } from './read-model.js'
import { commandExecutor, type M3Callbacks } from './m3-routes.js'
import { auditSpace } from './space.js'
import type { Handler, RequestContext } from './routes.js'

export const qualityHandler = (handler: Handler): Handler => async context => {
  try { return await handler(context) } catch (error) {
    if (error instanceof HttpError) throw error
    if (error instanceof QualityConflictError || error instanceof RewindConflictError) throw new HttpError(409, error.message)
    const message = error instanceof Error ? error.message : String(error)
    if (/不存在|找不到/.test(message)) throw new HttpError(404, message)
    if (/必须|不能|非法|无效|不合法|缺少|没有|不属于|请|拒绝/.test(message) || error instanceof TypeError) throw new HttpError(400, message)
    throw error
  }
}
async function snapshot({ stores, params }: RequestContext): Promise<SnapshotManifest> {
  const state = await run(stores, params.runId!)
  // 检查点 id 可以含节点分隔符，只用事件身份匹配，不把它拼进文件路径。
  const id = text(params.checkpointId, 'checkpointId')
  if (id.includes('..') || id.includes('\\') || id.includes('\0')) throw new HttpError(400, '检查点 id 不合法；请核对身份')
  for (const nodeId of Object.keys(state.nodes)) {
    const point = (await nodeQuality(stores, state.runId, nodeId)).checkpoints.find(p => p.id === id)
    if (point?.snapshot) {
      artifactPath(point.snapshot.dir)
      if (!point.snapshot.dir.startsWith(`snapshots/${state.runId}/`)) throw new HttpError(400, '快照不属于本运行')
      await snapshotMaterials(stores.taktDir, point.snapshot)
      return point.snapshot
    }
  }
  throw new HttpError(404, '快照不存在；请核对检查点')
}
export function qualityRoutes(register: (method: string, path: string, handler: Handler) => void, options: M3Callbacks): void {
  const add: typeof register = (method, path, handler) => register(method, path, qualityHandler(handler))
  const { execute } = commandExecutor(options)
  const write = (id: string): Handler => async ({ stores, params, request }) => {
    const input = await body(request)
    return execute(stores, request, id, { ...input, requirementId: params.id, defectId: params.defectId, suggestionId: params.sid, checkpointId: params.checkpointId }, text(input.reason ?? input.note, 'reason'))
  }
  add('GET', '/api/runs/:runId/snapshots/:checkpointId', snapshot)
  add('GET', '/api/runs/:runId/snapshots/:checkpointId/file', async (context): Promise<ArtifactContent> => {
    const path = artifactPath(context.url.searchParams.get('path')), manifest = await snapshot(context)
    const file = (await snapshotMaterials(context.stores.taktDir, manifest)).find(f => f.path === path)
    if (!file) throw new HttpError(404, '快照文件不存在')
    const bytes = Buffer.from(file.content)
    const encoding = isUtf8(bytes) && !bytes.includes(0) ? 'utf8' : 'base64'
    return { path, version: file.ref?.version ?? 0, mediaType: 'application/octet-stream', content: bytes.toString(encoding), encoding }
  })
  add('GET', '/api/requirements/:id/observations', async ({ stores, params, url }) => {
    await requirement(stores, params.id!)
    const source = url.searchParams.get('source') ?? undefined
    if (source && !['review', 'judge', 'gate', 'human', 'external'].includes(source)) throw new HttpError(400, '观察来源不合法')
    return stores.quality!.observations({ requirementId: params.id!, source: source as Observation['source'], runId: url.searchParams.get('run') ?? undefined })
  })
  add('PATCH', '/api/requirements/:id/defects/:defectId', write('defect.update'))
  add('GET', '/api/requirements/:id/defects/merge-suggestions', async ({ stores, params }) => {
    await requirement(stores, params.id!)
    return stores.quality!.mergeSuggestions(params.id!)
  })
  add('POST', '/api/requirements/:id/defects/merge-suggestions/:sid', write('defect.merge'))
  add('POST', '/api/requirements/:id/defects/:defectId/checkpoints/:checkpointId', write('defect.miss'))
  add('GET', '/api/quality/status', ({ stores }) => qualityStatus(stores))
  add('POST', '/api/quality/sync', async ({ stores, request }) => {
    const input = await body(request), reason = text(input.reason, 'reason')
    await auditSpace(stores, actor(request, stores), reason, 'quality.sync')
    await syncQuality(stores, input.runId === undefined ? undefined : text(input.runId, 'runId'))
    return qualityStatus(stores)
  })
  add('POST', '/api/quality/repair', async ({ stores, request }) => {
    const input = await body(request), reason = text(input.reason, 'reason')
    try { return await repairQuality(stores, actor(request, stores), reason) }
    catch (error) { throw new HttpError(409, `${error instanceof Error ? error.message : String(error)}；请人工检查质量日志`) }
  })
}
