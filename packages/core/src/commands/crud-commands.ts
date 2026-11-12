import { join } from 'node:path'
import type { RequirementCreateRequest, RequirementCreateResponse, RequirementUpdateRequest, WorkflowEdit } from '../api.js'
import type { ProjectStores } from '../interfaces.js'
import type { Requirement, RouteDecision } from '../types.js'
import type { CommandContext, CommandDeps, CommandSpec } from './contracts.js'
import { commandSchemas, objectSchema } from './schema.js'
import { validateSchema } from '../engine/schema.js'
import { deriveRequirementState } from '../insights/requirement.js'
import { assertArtifactPath } from '../store/paths.js'
import { assertNoSymlinks, readFileIfExists, writeFileAtomic } from '../store/fs-utils.js'
import { withFileLock } from '../store/file-lock.js'
import { sha256 } from '../util/hash.js'

export interface WorkflowCreateInput { workflowId: string; title?: string; template?: string; edits?: WorkflowEdit[] }
export interface CrudServices {
  workflowEdit(id: string, baseRev: string, edits: WorkflowEdit[], context: CommandContext): Promise<unknown>
  workflowConvert(id: string, context: CommandContext): Promise<unknown>
  configPatch(patch: Record<string, unknown>, context: CommandContext): Promise<unknown>
  /** 新建流水线，可带 edits 一次建好节点；draft 只算出要写的源码（管家预览用），discard 是新建的撤销。 */
  workflowCreate?(input: WorkflowCreateInput, context: CommandContext): Promise<unknown>
  workflowDraft?(input: WorkflowCreateInput): Promise<{ file: string; template: string; base: string; source: string }>
  workflowDiscard?(id: string, context: CommandContext): Promise<unknown>
}
const services = new WeakMap<ProjectStores, CrudServices>()
export function bindCrudServices(stores: ProjectStores, value: CrudServices): void { services.set(stores, value) }
export const crudServices = (stores: ProjectStores): CrudServices | undefined => services.get(stores)
/** 新建流水线可选的起点，和服务端模板表一致。 */
export const workflowCreateTemplates = ['blank', 'taktflow-standard', 'quick-fix'] as const
export class RequirementConflictError extends Error { readonly status = 409 }

export function requirementCreateReason(input: Pick<RequirementCreateRequest, 'title' | 'reason'>, reason?: string): string {
  return reason?.trim() ? reason : input.reason?.trim() ? input.reason : `新建需求 ${input.title}`
}

export async function createRequirementFull(deps: CommandDeps, input: RequirementCreateRequest, context: CommandContext): Promise<RequirementCreateResponse> {
  validateSchema(input, commandSchemas['requirement.create'])
  context = { ...context, reason: requirementCreateReason(input, context.reason) }
  if (!input.title.trim()) throw new Error('标题不能为空')
  validateDue(input.dueAt)
  const names = new Set(['prd.md'])
  let total = 0
  const attachments = (input.attachments ?? []).map((attachment) => {
    const name = attachment.name.replace(/[^\w.\-一-龥]/g, '')
    if (!name || name === '.' || name === '..' || names.has(name.toLowerCase())) throw new Error(`附件文件名为空或重复：${attachment.name}`)
    names.add(name.toLowerCase())
    if (attachment.encoding === 'base64' && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(attachment.content)) throw new Error('附件 base64 格式不合法')
    const content = Buffer.from(attachment.content, attachment.encoding ?? 'utf8')
    total += content.length
    if (content.length > 5 * 1024 * 1024 || total > 20 * 1024 * 1024) throw new Error('附件单个不能超过 5MB，总量不能超过 20MB')
    return { name, content }
  })
  const { stores } = deps
  const created = await stores.workspaces.createRequirement(input)
  const requirement = await stores.workspaces.updateRequirement(created.id, {
    description: input.description, owner: input.owner, members: input.members, links: input.links ?? [], dueAt: input.dueAt,
  })
  await stores.workspaces.writeArtifact({ ref: { workspace: created.id, path: 'inputs/prd.md' }, content: input.description ?? input.title,
    kind: 'input', author: context.actor, reason: context.reason })
  for (const { name, content } of attachments) await stores.workspaces.writeArtifact({ ref: { workspace: created.id, path: `inputs/${name}` }, content, kind: 'input', author: context.actor, reason: context.reason })
  if (input.members?.length) await stores.chat.addMembers(created.id, input.members.map((id) => ({ id, kind: 'human', name: id })))
  const result: RequirementCreateResponse = { requirement: { ...requirement, stages: [], pendingAttention: 0, usage: { inputTokens: 0, outputTokens: 0 } } }
  try {
    if (!input.workflowId) {
      if (!deps.route) throw new Error('路由尚未接入，请指定流程')
      result.route = await deps.route({ requirementId: created.id, hint: input.description, repos: input.repos }, context) as RouteDecision
    }
    if (input.start !== false) {
      if (!deps.startRun) throw new Error('启动运行尚未接入，请手动启动')
      const started = await deps.startRun({ requirementId: created.id, workflowId: input.workflowId ?? result.route!.workflowId,
        route: result.route, budget: input.budget, args: { repos: input.repos } }, context) as { runId?: string; refs?: { runId?: string } } | string
      result.runId = typeof started === 'string' ? started : started.runId ?? started.refs?.runId
      if (!result.runId) throw new Error('启动未返回运行 ID，请检查运行记录')
    }
  } catch (error) { if (input.start !== false) result.startError = error instanceof Error ? error.message : String(error) }
  Object.assign(result.requirement, await stores.workspaces.getRequirement(created.id), { latestRunId: result.runId, tier: result.route?.tier })
  await stores.chat.post(created.id, { author: { type: 'system', id: 'lead' }, kind: 'text', text: result.runId ? `需求已创建，已启动运行 ${result.runId}。` : result.startError ? `需求已保存。${result.startError}` : '需求已保存，准备好后可以启动流程。' })
  return result
}
function validateDue(value: unknown): void {
  if (value !== undefined && value !== null && (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))) throw new Error('截止时间不合法，请填写 ISO 日期')
}
export async function updateRequirement(stores: ProjectStores, id: string, input: RequirementUpdateRequest): Promise<Requirement> {
  validateDue(input.dueAt)
  if (input.title !== undefined && !input.title.trim()) throw new Error('标题不能为空')
  const patch = Object.fromEntries(['title', 'description', 'owner', 'members', 'links', 'dueAt'].filter((key) => Object.hasOwn(input, key)).map((key) => [key, input[key as keyof RequirementUpdateRequest] ?? undefined]))
  return stores.workspaces.updateRequirement(id, patch)
}
export async function archiveRequirement(stores: ProjectStores, id: string): Promise<Requirement> {
  if ((await stores.runs.list({ requirementId: id })).some((run) => ['running', 'waiting_human'].includes(run.status))) throw new RequirementConflictError('需求仍有运行，请先取消运行')
  return stores.workspaces.updateRequirement(id, { status: 'archived', archivedAt: new Date().toISOString() })
}
export async function restoreRequirement(stores: ProjectStores, id: string): Promise<Requirement> {
  const latest = (await stores.runs.list({ requirementId: id })).filter((run) => run.workflowId !== 'lead' && !run.workflowId.startsWith('task:'))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.runId.localeCompare(b.runId)).at(-1)
  const snapshot = latest && await stores.runs.getWorkflow(latest.runId)
  const state = latest && snapshot ? deriveRequirementState(snapshot, latest) : { status: 'draft' as const, stage: undefined }
  return stores.workspaces.updateRequirement(id, { ...state, archivedAt: undefined })
}
export async function writeSpaceFile(stores: ProjectStores, input: { path: string; content: string; baseHash?: string }): Promise<{ path: string; hash: string }> {
  const path = assertArtifactPath(input.path)
  if (!writableProjectFile(path)) throw new Error('文件不在允许写入的范围内')
  const file = join(stores.projectDir, path)
  await assertNoSymlinks(stores.projectDir, file)
  return withFileLock(file, async () => {
    await assertNoSymlinks(stores.projectDir, file)
    const previous = await readFileIfExists(file)
    if (input.baseHash !== undefined && input.baseHash !== sha256(previous ?? '')) throw new RequirementConflictError('文件已变化，请读取最新内容后重试')
    await writeFileAtomic(file, input.content)
    return { path, hash: sha256(input.content) }
  })
}
export function crudCommandSpecs(deps: CommandDeps): CommandSpec[] {
  const text = { type: 'string' }, strings = { type: 'array', items: text }
  const define = (id: string, title: string, input: Record<string, unknown>, handler: CommandSpec['handler'], maintainer = false): CommandSpec =>
    ({ id, title, input, handler, kind: 'command', risk: 'write', minRole: maintainer ? 'maintainer' : 'member' })
  const service = () => { const value = services.get(deps.stores); if (!value) throw new Error('空间编辑服务未接入'); return value }
  return [
    define('requirement.update', '编辑需求', objectSchema({ requirementId: text, title: text, description: text, owner: text, members: strings, links: commandSchemas['requirement.create'].properties.links, dueAt: {} }, ['requirementId']), (input, context) => updateRequirement(deps.stores, input.requirementId as string, { ...input, reason: context.reason! } as RequirementUpdateRequest)),
    define('requirement.archive', '归档需求', objectSchema({ requirementId: text }, ['requirementId']), (input) => archiveRequirement(deps.stores, input.requirementId as string)),
    define('requirement.restore', '恢复需求', objectSchema({ requirementId: text }, ['requirementId']), (input) => restoreRequirement(deps.stores, input.requirementId as string)),
    define('workflow.edit', '编辑流程', objectSchema({ workflowId: text, baseRev: text, edits: { type: 'array' } }, ['workflowId', 'baseRev', 'edits']), (input, context) => service().workflowEdit(input.workflowId as string, input.baseRev as string, input.edits as WorkflowEdit[], context), true),
    define('workflow.create', '新建流程', objectSchema({ workflowId: text, title: text, template: { type: 'string', enum: [...workflowCreateTemplates] }, edits: { type: 'array' } }, ['workflowId']), (input, context) => { const create = service().workflowCreate; if (!create) throw new Error('新建流程尚未接入'); return create(input as unknown as WorkflowCreateInput, context) }, true),
    define('workflow.convert', '转换流程', objectSchema({ workflowId: text }, ['workflowId']), (input, context) => service().workflowConvert(input.workflowId as string, context), true),
    define('file.write', '写入文件', objectSchema({ path: text, content: text, baseHash: text }, ['path', 'content']), (input) => writeSpaceFile(deps.stores, input as { path: string; content: string; baseHash?: string }), true),
    define('config.patch', '修改配置', objectSchema({ patch: { type: 'object' } }, ['patch']), (input, context) => service().configPatch(input.patch as Record<string, unknown>, context), true),
  ]
}

export function writableProjectFile(path: string): boolean {
  if (/^knowledge\/[^/]+\/kb\.json$/i.test(path)) return false
  return /^(?:agents|skills)\/.+/.test(path)
    || /^knowledge\/(?:.*\/)?[^/]+\.(?:md|json)$/.test(path)
    || /^workflows\/[^/]+\.layout\.json$/.test(path)
}
