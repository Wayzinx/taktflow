import type { Actor, ProjectStores, WorkflowEditRequest, WorkflowLayout, WorkflowSourceRequest } from '@taktflow/core'
import type { WorkflowStore } from '@taktflow/workflow-source'
import { ApiError as HttpError } from './errors.js'
import { safeId, text } from './validation.js'

export type WorkflowReadOp = 'workflows' | 'workflow' | 'workflow.source' | 'workflow.revisions' | 'workflow.revision'
export type WorkflowWriteOp = 'workflow.edit' | 'workflow.source.replace' | 'workflow.layout' | 'workflow.rollback'
type Params = Record<string, string | undefined>

export async function workflowOperation<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn() } catch (error) {
    if (error instanceof HttpError) throw error
    const message = error instanceof Error ? error.message : String(error)
    if (/workflow 不存在|修订不存在/.test(message)) throw new HttpError(404, message)
    if (/非法|不合法|必须|不能|无效/.test(message) || error instanceof TypeError) throw new HttpError(400, message)
    throw error
  }
}

export async function readWorkflow(stores: ProjectStores, store: WorkflowStore, op: WorkflowReadOp, params: Params): Promise<unknown> {
  return workflowOperation(async () => {
    switch (op) {
      case 'workflows': {
        const runs = await stores.runs.list()
        return (await store.list()).map((item) => ({ ...item, runs: runs.filter((run) => run.workflowId === item.id).length }))
      }
      case 'workflow': case 'workflow.source': return store.get(safeId(params.id!))
      case 'workflow.revisions': {
        const id = safeId(params.id!)
        const file = (await store.list({ record: false })).find((item) => item.id === id)
        if (!file) throw new HttpError(404, 'workflow 不存在')
        const revisions = await store.revisions(id)
        return revisions.length ? revisions : [{ rev: file.rev, at: file.updatedAt, author: { type: 'system', id: 'workflow-source' }, reason: '记录初始源码', summary: '初始修订' }]
      }
      case 'workflow.revision': return store.revision(safeId(params.id!), params.rev!)
    }
  })
}

export async function writeWorkflow(store: WorkflowStore, op: WorkflowWriteOp, params: Params, input: Record<string, unknown>, author: Actor): Promise<unknown> {
  return workflowOperation(async () => {
    switch (op) {
      case 'workflow.edit': {
        text(input.baseRev, 'baseRev')
        if (input.reason !== undefined) text(input.reason, 'reason')
        if (!Array.isArray(input.edits)) throw new HttpError(400, 'edits 必须是数组')
        return store.edit(safeId(params.id!), { ...input as unknown as WorkflowEditRequest, author })
      }
      case 'workflow.source.replace': {
        text(input.baseRev, 'baseRev'); text(input.source, 'source')
        if (input.reason !== undefined) text(input.reason, 'reason')
        return store.replaceSource(safeId(params.id!), { ...input as unknown as WorkflowSourceRequest, author })
      }
      case 'workflow.layout': {
        if (!input.nodes || typeof input.nodes !== 'object' || Array.isArray(input.nodes)) throw new HttpError(400, 'nodes 必须是坐标表')
        for (const value of Object.values(input.nodes)) {
          if (!value || typeof value !== 'object' || !Number.isFinite(value.x) || !Number.isFinite(value.y)) throw new HttpError(400, '节点坐标不合法')
        }
        if (input.viewport !== undefined) {
          const v = input.viewport as Record<string, unknown>
          if (!v || ![v.x, v.y, v.zoom].every((n) => typeof n === 'number' && Number.isFinite(n))) throw new HttpError(400, 'viewport 不合法')
        }
        return store.setLayout(safeId(params.id!), input as unknown as WorkflowLayout)
      }
      case 'workflow.rollback': {
        return store.rollback(safeId(params.id!), text(input.rev, 'rev'), author, text(input.reason, 'reason'))
      }
    }
  })
}
