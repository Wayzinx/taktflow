import type { WorkflowEdit, WorkflowEditRequest, WorkflowLayout, WorkflowSourceRequest } from '@taktflow/core'
import { applyEdits, convertWorkflowSource, parseWorkflowSource, sourceDiff } from '@taktflow/workflow-source'
import { requireRole, systemWrite, type Actor, type ProjectStores, type WorkflowConvertResult, type WorkflowDocument } from '@taktflow/core'
import type { WorkflowStore } from '@taktflow/workflow-source'
import { actor, body, HttpError, json, requires, roleDenied, safeId, text } from './http.js'
import { auditSpace, changeConfig, workflowSource, workflowStore, workflowWritePaths } from './space.js'
import { templatesDir, workflowModuleScope, workflowTemplates, workflowTemplateSource } from './space-admin.js'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { STREAMING, type Handler } from './routes.js'
import { liveStream } from './live-stream.js'

export function workflowRoutes(register: (method: string, path: string, handler: Handler) => void, connections: Set<() => void>, getStore: (stores: Parameters<typeof workflowStore>[0]) => WorkflowStore) {
  // what：写接口的操作说明。改流水线（源码、布局、回滚、转换、新建）需要 maintainer，和命令表的 workflow.edit / workflow.convert 一致
  const add = (method: string, path: string, handler: Handler, what?: string) => {
    const mapped: Handler = async (ctx) => {
      try { return await handler(ctx) } catch (error) {
        if (error instanceof HttpError) throw error
        const message = error instanceof Error ? error.message : String(error)
        if (/workflow 不存在|修订不存在/.test(message)) throw new HttpError(404, message)
        if (/非法|不合法|必须|不能|无效/.test(message) || error instanceof TypeError) throw new HttpError(400, message)
        throw error
      }
    }
    register(method, path, what ? requires('maintainer', what, mapped) : mapped)
  }
  // 编辑器写源码、修订记录和布局（读取也会补记初始修订）都是 serve 自己的写入：运行中节点的写权限守卫不能把它们算到 Agent 头上。
  const guarded = <T>(stores: ProjectStores, fn: () => Promise<T>) => systemWrite(stores.projectDir, workflowWritePaths(stores), fn)
  add('POST', '/api/workflows/:id/convert', async ({ stores, params, request }) => {
    const input = await body(request)
    if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') throw new HttpError(400, 'dryRun 必须是布尔值')
    return guarded(stores, () => convertWorkflow(stores, safeId(params.id!), { dryRun: input.dryRun as boolean | undefined, baseRev: input.baseRev as string | undefined, reason: input.reason as string | undefined }, actor(request, stores), getStore(stores)))
  }, '转换流水线写法')
  add('POST', '/api/workflows', async ({ stores, request }) => {
    const input = await body(request)
    return createWorkflow(stores, { id: input.id, template: input.template, title: input.title, edits: input.edits }, actor(request, stores), text(input.reason, 'reason'), getStore(stores))
  }, '新建流水线')
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
  }, '修改流水线')
  add('PUT', '/api/workflows/:id/source', async ({ stores, params, request, response }) => {
    const input = await body(request)
    text(input.baseRev, 'baseRev'); text(input.source, 'source')
    if (input.reason !== undefined) text(input.reason, 'reason')
    return result(await guarded(stores, () => getStore(stores).replaceSource(safeId(params.id!), { ...input as unknown as WorkflowSourceRequest, author: actor(request, stores) })), response)
  }, '修改流水线源码')
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
  }, '调整流水线布局')
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
  }, '回滚流水线')
  add('GET', '/api/workflows/:id/stream', async ({ stores, params, response }) => {
    const store = getStore(stores)
    await guarded(stores, () => store.get(safeId(params.id!)))
    liveStream(response, connections, (send, fail) => {
      const unwatch = store.watch((event) => { if (event.workflowId === params.id) send(event) }, fail)
      return () => { void unwatch().catch(fail) }
    })
    return STREAMING
  })
}

export async function convertWorkflow(stores: ProjectStores, id: string, input: { dryRun?: boolean; baseRev?: string; reason?: string }, author: Actor, store = workflowStore(stores)): Promise<WorkflowConvertResult> {
  try { requireRole(stores, author, 'maintainer', 'workflow.convert') }
  catch { throw roleDenied(stores, author, 'maintainer', '转换流水线写法') }
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

export interface WorkflowDraft { id: string; file: string; template: string; base: string; source: string }
/**
 * 新建流水线要写的源码，不落盘：空白（一个阶段、没有节点）或模板主文件改好 id，再套上 edits。
 * 管家提案用它预览，新建时用它生成，两边看到的是同一份源码。
 */
export async function draftWorkflow(stores: ProjectStores, input: { id: unknown; template?: unknown; title?: unknown; edits?: unknown }, store = workflowStore(stores)): Promise<WorkflowDraft> {
  const id = safeId(text(input.id, 'id'))
  const template = input.template ?? 'blank'
  if (template !== 'blank' && !Object.hasOwn(workflowTemplates, template as string)) throw new HttpError(400, `模板不存在：${String(template)}，可选 blank、${Object.keys(workflowTemplates).join('、')}`)
  const title = input.title === undefined ? undefined : text(input.title, 'title').trim()
  if (input.edits !== undefined && !Array.isArray(input.edits)) throw new HttpError(400, 'edits 必须是数组')
  if ((await store.list({ record: false })).some((item) => item.id === id)) throw new HttpError(409, `流水线 ${id} 已存在，换一个 id`)
  const file = join(stores.paths.workflows, `${id}.workflow.ts`)
  let base: string
  if (template === 'blank') {
    // 画布加节点不会补 import：先把各类节点的构造函数都引进来
    base = `import { agent, defineWorkflow, gate, human, judge, loop, planner, review, script, subflow } from '@taktflow/core'\n\nexport default defineWorkflow({\n  id: ${JSON.stringify(id)}, title: ${JSON.stringify(title || id)}, version: '0.1.0',\n  stages: [{ id: 'main', title: '主流程' }],\n  nodes: [],\n})\n`
  } else {
    base = (await readFile(join(templatesDir, 'workflows', `${template as string}.workflow.ts`), 'utf8')).replace(/(defineWorkflow\(\{\s*id:\s*)(['"])[^'"]*\2/, `$1${JSON.stringify(id)}`)
    if (title) base = applyEdits(base, [{ op: 'setMeta', key: 'title', value: title }]).source
  }
  if (parseWorkflowSource(base, file).model.meta.id !== id) throw new Error(`模板 ${String(template)} 的写法无法改 id`)
  let source = base
  if (input.edits?.length) {
    let result: ReturnType<typeof applyEdits>
    try { result = applyEdits(base, input.edits as WorkflowEdit[]) } catch (error) { throw new HttpError(400, `edits 套不上新建的流水线：${error instanceof Error ? error.message : String(error)}`) }
    const errors = result.diagnostics.filter((item) => item.severity === 'error')
    if (errors.length) throw new HttpError(400, `edits 套上后没通过校验：${errors.map((item) => item.message).join('；')}`)
    source = result.source
  }
  return { id, file: relative(stores.projectDir, file), template: String(template), base, source }
}

/**
 * 新建流水线：空白或从模板复制（补齐模板用到的角色和辅助文件，已有的不覆盖），可带 edits 一次建好节点。
 * 写入 workflows/<id>.workflow.ts 并登记到 config.workflows；源码校验不过就撤回，不留半成品。
 */
// 写入已包在 systemWrite 里，store 要用不自带守卫的那份，带守卫的会在同一把锁上等自己。
export async function createWorkflow(stores: ProjectStores, input: { id: unknown; template?: unknown; title?: unknown; edits?: unknown }, author: Actor, reason: string, store: WorkflowStore = workflowSource(stores)): Promise<WorkflowDocument> {
  try { requireRole(stores, author, 'maintainer', 'workflow.create') }
  catch { throw roleDenied(stores, author, 'maintainer', '新建流水线') }
  text(reason, 'reason')
  const draft = await draftWorkflow(stores, input, store)
  const file = join(stores.projectDir, draft.file)
  const paths = [...workflowWritePaths(stores), 'takt.config.json*', `${relative(stores.projectDir, stores.paths.agents)}/**`]
  return systemWrite(stores.projectDir, paths, async () => {
    if (draft.template === 'blank') await workflowModuleScope(stores.paths.workflows)
    else await workflowTemplateSource(stores, draft.template as keyof typeof workflowTemplates)
    try { await writeFile(file, draft.source, { flag: 'wx' }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new HttpError(409, `文件 ${draft.file} 已存在，换一个 id`)
      throw error
    }
    try {
      const document = await store.get(draft.id, { record: true })
      const errors = document.diagnostics.filter((item) => item.severity === 'error')
      if (errors.length) throw new HttpError(400, `新建的流水线没通过校验：${errors.map((item) => item.message).join('；')}`)
      await changeConfig(stores, author, reason, `workflow.create ${draft.id}${draft.template === 'blank' ? '' : ` from ${draft.template}`}`, (config) => {
        if (!config.workflows.includes(draft.file)) config.workflows = [...config.workflows, draft.file]
      })
      return document
    } catch (error) {
      await rm(file, { force: true })
      throw error
    }
  })
}

/** 撤销新建：删掉主文件和布局、取消登记。跑过的流水线留着，模板带进来的角色和辅助文件可能已被别处用到，也留着。 */
export async function discardWorkflow(stores: ProjectStores, id: string, author: Actor, reason: string, store = workflowStore(stores)): Promise<{ removed: string }> {
  try { requireRole(stores, author, 'maintainer', 'workflow.discard') }
  catch { throw roleDenied(stores, author, 'maintainer', '撤销新建流水线') }
  text(reason, 'reason')
  const current = await store.get(safeId(id))
  if ((await stores.runs.list()).some((run) => run.workflowId === current.id)) throw new HttpError(409, `流水线 ${current.id} 已经跑过，不能撤销新建；不再用的话从设置里停用`)
  return systemWrite(stores.projectDir, [...workflowWritePaths(stores), 'takt.config.json*'], async () => {
    await changeConfig(stores, author, reason, `workflow.discard ${current.id}`, (config) => {
      config.workflows = config.workflows.filter((entry) => entry !== current.file)
    })
    await rm(join(stores.projectDir, current.file), { force: true })
    await rm(join(stores.paths.workflows, `${current.id}.layout.json`), { force: true })
    return { removed: current.id }
  })
}
