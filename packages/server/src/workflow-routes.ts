import type { Actor, WorkflowEditRequest, WorkflowLayout, WorkflowSourceRequest } from '@taktflow/core'
import type { WorkflowStore } from '@taktflow/workflow-source'
import { actor, body, HttpError, json, safeId, text } from './http.js'
import { workflowStore } from './space.js'
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
  add('GET', '/api/workflows', async ({ stores }) => {
    const runs = await stores.runs.list()
    return (await getStore(stores).list()).map((item) => ({ ...item, runs: runs.filter((run) => run.workflowId === item.id).length }))
  })
  const author = (request: Parameters<typeof actor>[0]): Actor => actor(request)
  const result = (value: Awaited<ReturnType<WorkflowStore['edit']>>, response: Parameters<typeof json>[0]) => {
    if ('error' in value) { json(response, value, value.error === 'conflict' ? 409 : 400); return STREAMING }
    return value
  }
  add('GET', '/api/workflows/:id', ({ stores, params }) => getStore(stores).get(safeId(params.id!)))
  add('PATCH', '/api/workflows/:id', async ({ stores, params, request, response }) => {
    const input = await body(request)
    text(input.baseRev, 'baseRev')
    if (input.reason !== undefined) text(input.reason, 'reason')
    if (!Array.isArray(input.edits)) throw new HttpError(400, 'edits 必须是数组')
    return result(await getStore(stores).edit(safeId(params.id!), { ...input as unknown as WorkflowEditRequest, author: author(request) }), response)
  })
  add('PUT', '/api/workflows/:id/source', async ({ stores, params, request, response }) => {
    const input = await body(request)
    text(input.baseRev, 'baseRev'); text(input.source, 'source')
    if (input.reason !== undefined) text(input.reason, 'reason')
    return result(await getStore(stores).replaceSource(safeId(params.id!), { ...input as unknown as WorkflowSourceRequest, author: author(request) }), response)
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
    return getStore(stores).setLayout(safeId(params.id!), input as unknown as WorkflowLayout)
  })
  add('GET', '/api/workflows/:id/revisions', async ({ stores, params }) => {
    const store = getStore(stores); await store.get(safeId(params.id!))
    return store.revisions(params.id!)
  })
  add('GET', '/api/workflows/:id/revisions/:rev', ({ stores, params }) => getStore(stores).revision(safeId(params.id!), params.rev!))
  add('POST', '/api/workflows/:id/rollback', async ({ stores, params, request, response }) => {
    const input = await body(request)
    return result(await getStore(stores).rollback(safeId(params.id!), text(input.rev, 'rev'), author(request), text(input.reason, 'reason')), response)
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
