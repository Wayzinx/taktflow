import type { WorkflowEditRequest, WorkflowLayout, WorkflowSourceRequest } from '@taktflow/core'
import { convertWorkflowSource, sourceDiff } from '@taktflow/workflow-source'
import { relative } from 'node:path'
import { requireRole, systemWrite, type Actor, type ProjectStores, type WorkflowConvertResult } from '@taktflow/core'
import type { WorkflowStore } from '@taktflow/workflow-source'
import { actor, body, HttpError, json, safeId, text } from './http.js'
import { auditSpace, workflowStore } from './space.js'
import { STREAMING, type Handler } from './routes.js'
import { liveStream } from './live-stream.js'

export function workflowRoutes(register: (method: string, path: string, handler: Handler) => void, connections: Set<() => void>, getStore: (stores: Parameters<typeof workflowStore>[0]) => WorkflowStore) {
  const add: typeof register = (method, path, handler) => register(method, path, async (ctx) => {
    try { return await handler(ctx) } catch (error) {
      if (error instanceof HttpError) throw error
      const message = error instanceof Error ? error.message : String(error)
      if (/workflow 不存在|修订不存在/.test(message)) throw new HttpError(404, message)
      if (/非法|不合法|必须|不能|无效/.test(message) || error instanceof TypeError) throw new HttpError(400, message)
      throw error
    }
  })
  // 编辑器写源码、修订记录和布局（读取也会补记初始修订）都是 serve 自己的写入：运行中节点的写权限守卫不能把它们算到 Agent 头上。
  const guarded = <T>(stores: ProjectStores, fn: () => Promise<T>) =>
    systemWrite(stores.projectDir, [`${relative(stores.projectDir, stores.paths.workflows)}/**`, '.takt/workflow-revisions/**', '.takt/space-events.jsonl*'], fn)
  add('POST', '/api/workflows/:id/convert', async ({ stores, params, request }) => {
    const input = await body(request)
    if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') throw new HttpError(400, 'dryRun 必须是布尔值')
    return guarded(stores, () => convertWorkflow(stores, safeId(params.id!), { dryRun: input.dryRun as boolean | undefined, baseRev: input.baseRev as string | undefined, reason: input.reason as string | undefined }, actor(request, stores), getStore(stores)))
  })
  add('GET', '/api/workflows', async ({ stores }) => {
    const runs = await stores.runs.list()
    return (await guarded(stores, () => getStore(stores).list())).map((item) => ({ ...item, runs: runs.filter((run) => run.workflowId === item.id).length }))
  })
  const result = (value: Awaited<ReturnType<WorkflowStore['edit']>>, response: Parameters<typeof json>[0]) => {
    if ('error' in value) { json(response, value, value.error === 'conflict' ? 409 : 400); return STREAMING }
    return value
  }
  add('GET', '/api/workflows/:id', ({ stores, params }) => guarded(stores, () => getStore(stores).get(safeId(params.id!))))
  add('PATCH', '/api/workflows/:id', async ({ stores, params, request, response }) => {
    const input = await body(request)
    text(input.baseRev, 'baseRev')
    if (input.reason !== undefined) text(input.reason, 'reason')
    if (!Array.isArray(input.edits)) throw new HttpError(400, 'edits 必须是数组')
    return result(await guarded(stores, () => getStore(stores).edit(safeId(params.id!), { ...input as unknown as WorkflowEditRequest, author: actor(request, stores) })), response)
  })
  add('PUT', '/api/workflows/:id/source', async ({ stores, params, request, response }) => {
    const input = await body(request)
    text(input.baseRev, 'baseRev'); text(input.source, 'source')
    if (input.reason !== undefined) text(input.reason, 'reason')
    return result(await guarded(stores, () => getStore(stores).replaceSource(safeId(params.id!), { ...input as unknown as WorkflowSourceRequest, author: actor(request, stores) })), response)
  })
  add('PUT', '/api/workflows/:id/layout', async ({ stores, params, request }) => {
    const input = await body(request)
    if (!input.nodes || typeof input.nodes !== 'object' || Array.isArray(input.nodes)) throw new HttpError(400, 'nodes 必须是坐标表')
    for (const value of Object.values(input.nodes)) {
      if (!value || typeof value !== 'object' || !Number.isFinite(value.x) || !Number.isFinite(value.y)) throw new HttpError(400, '节点坐标不合法')
    }
    if (input.viewport !== undefined) {
      const v = input.viewport as Record<string, unknown>
      if (!v || ![v.x, v.y, v.zoom].every((n) => typeof n === 'number' && Number.isFinite(n))) throw new HttpError(400, 'viewport 不合法')
    }
    return guarded(stores, () => getStore(stores).setLayout(safeId(params.id!), input as unknown as WorkflowLayout))
  })
  add('GET', '/api/workflows/:id/revisions', async ({ stores, params }) => {
    const store = getStore(stores)
    const id = safeId(params.id!)
    const file = (await store.list({ record: false })).find((item) => item.id === id)
    if (!file) throw new HttpError(404, 'workflow 不存在')
    const revisions = await store.revisions(id)
    return revisions.length ? revisions : [{ rev: file.rev, at: file.updatedAt, author: { type: 'system', id: 'workflow-source' }, reason: '记录初始源码', summary: '初始修订' }]
  })
  add('GET', '/api/workflows/:id/revisions/:rev', ({ stores, params }) => getStore(stores).revision(safeId(params.id!), params.rev!))
  add('POST', '/api/workflows/:id/rollback', async ({ stores, params, request, response }) => {
    const input = await body(request)
    return result(await guarded(stores, () => getStore(stores).rollback(safeId(params.id!), text(input.rev, 'rev'), actor(request, stores), text(input.reason, 'reason'))), response)
  })
  add('GET', '/api/workflows/:id/stream', async ({ stores, params, response }) => {
    const store = getStore(stores)
    await store.get(safeId(params.id!))
    liveStream(response, connections, (send, fail) => {
      const unwatch = store.watch((event) => { if (event.workflowId === params.id) send(event) }, fail)
      return () => { void unwatch().catch(fail) }
    })
    return STREAMING
  })
}

export async function convertWorkflow(stores: ProjectStores, id: string, input: { dryRun?: boolean; baseRev?: string; reason?: string }, author: Actor, store = workflowStore(stores)): Promise<WorkflowConvertResult> {
  try { requireRole(stores, author, 'maintainer', 'workflow.convert') }
  catch (error) { throw new HttpError(403, error instanceof Error ? error.message : String(error)) }
  const current = await store.get(id, { record: !input.dryRun })
  const converted = convertWorkflowSource(current.source)
  if (!converted.ok) return converted
  const source = converted.source!, diff = await sourceDiff(current.source, source)
  if (input.dryRun) return { ok: true, source, diff }
  const reason = text(input.reason, 'reason')
  const result = await store.replaceSource(id, { source, baseRev: input.baseRev ?? current.rev, author, reason })
  if ('error' in result) throw new HttpError(result.error === 'conflict' ? 409 : 400, JSON.stringify(result))
  await auditSpace(stores, author, reason, `workflow.convert ${id}`)
  return { ok: true, source, diff, document: result }
}
