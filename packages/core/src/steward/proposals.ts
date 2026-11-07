import { proposalDiff as diff } from './diff.js'
import { randomUUID } from 'node:crypto'
import type { Actor } from '../types.js'
import type { EditableValue, Proposal, ProposalDecisionRequest, ProposalStep, WorkflowEdit } from '../api.js'
import type { CommandRegistry } from '../commands/contracts.js'
import { validateSchema } from '../engine/schema.js'
import { canonicalJson, sha256 } from '../util/hash.js'
import { StewardError, stewardActor, stewardId, timestamp, type StewardDeps, type StewardSpace } from './contracts.js'
import { StewardStore } from './store.js'
import { readStewardFile, stewardFile } from './files.js'
import type { NodeKind } from '../types.js'

interface UndoRecord {
  step: ProposalStep
  before: unknown
  after: string
  result?: unknown
  reversible: boolean
}
const hash = (value: unknown) => sha256(canonicalJson(value ?? null))
const commandId = (step: ProposalStep) =>
  step.kind === 'command' ? step.commandId : step.kind === 'file' ? 'file.write' : 'workflow.edit'
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
const nodeKinds: NodeKind[] = ['script', 'agent', 'gate', 'human', 'judge', 'loop', 'planner', 'review', 'subflow']
export function proposalHash(steps: ProposalStep[]): string {
  return hash(steps)
}
function closest(value: string, candidates: string[]): string[] {
  const q = value.toLowerCase()
  return candidates
    .map((candidate) => {
      const text = candidate.toLowerCase()
      let score = text === q ? 100 : text.includes(q) || q.includes(text) ? 60 : 0
      for (let i = 0; i < Math.min(text.length, q.length); i++) if (text[i] === q[i]) score += 2
      return { candidate, score }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.candidate.localeCompare(b.candidate))
    .slice(0, 5)
    .map((item) => item.candidate)
}
function literal(value: unknown): EditableValue {
  return { kind: 'literal', value }
}
function example(kind: ProposalStep['kind']): string {
  if (kind === 'command') return JSON.stringify({ kind: 'command', spaceId: 'standard-delivery', commandId: 'requirement.create', input: { title: '新需求', start: false } })
  if (kind === 'file') return JSON.stringify({ kind: 'file', spaceId: 'standard-delivery', path: 'agents/steward.md', content: '...' })
  return JSON.stringify({ kind: 'workflow', spaceId: 'standard-delivery', workflowId: 'taktflow-standard', baseRev: '<workflow_get.rev>', edits: [{ op: 'addNode', kind: 'human', after: 'review-code', props: { id: literal('prelaunch-confirm'), title: literal('上线前人工确认'), needs: literal(['review-code']) } }, { op: 'setNeeds', id: 'acceptance', needs: ['prelaunch-confirm'] }] })
}
function fieldError(index: number, field: string, expected: string, got: unknown, kind?: ProposalStep['kind']): StewardError {
  const received = got === undefined ? 'undefined' : JSON.stringify(got)
  return new StewardError(400, `steps[${index}].${field}：期望 ${expected}，收到 ${received}。正确示例：${example(kind ?? 'workflow')}`)
}
function assertString(index: number, step: Record<string, unknown>, key: string, kind: ProposalStep['kind']): void {
  if (typeof step[key] !== 'string') throw fieldError(index, key, 'string', step[key], kind)
}
function assertOptionalString(index: number, step: Record<string, unknown>, key: string, kind: ProposalStep['kind']): void {
  if (step[key] !== undefined && typeof step[key] !== 'string') throw fieldError(index, key, 'string 或省略', step[key], kind)
}
function assertEditableValue(index: number, field: string, value: unknown): void {
  const item = record(value)
  if (item.kind === 'literal' && Object.hasOwn(item, 'value')) return
  if (item.kind === 'code' && typeof item.code === 'string') return
  throw fieldError(index, field, '{kind:"literal",value:...} 或 {kind:"code",code:"..."}', value, 'workflow')
}
function validateWorkflowEdit(index: number, edit: unknown, editIndex: number): void {
  const item = record(edit),
    prefix = `edits[${editIndex}]`
  if (!edit || typeof edit !== 'object' || Array.isArray(edit)) throw fieldError(index, prefix, 'WorkflowEdit object', edit, 'workflow')
  if (typeof item.op !== 'string') throw fieldError(index, `${prefix}.op`, 'addNode/removeNode/setProp/setNeeds/moveNode/setStages/setMeta/setMetaValue', item.op, 'workflow')
  switch (item.op) {
    case 'addNode':
      if (!nodeKinds.includes(item.kind as NodeKind)) throw fieldError(index, `${prefix}.kind`, `NodeKind(${nodeKinds.join('|')})`, item.kind, 'workflow')
      if (!item.props || typeof item.props !== 'object' || Array.isArray(item.props)) throw fieldError(index, `${prefix}.props`, 'Record<string, EditableValue>', item.props, 'workflow')
      for (const [key, value] of Object.entries(record(item.props))) assertEditableValue(index, `${prefix}.props.${key}`, value)
      if (item.after !== undefined && item.after !== null && typeof item.after !== 'string') throw fieldError(index, `${prefix}.after`, 'string/null/省略', item.after, 'workflow')
      if (item.parent !== undefined && typeof item.parent !== 'string') throw fieldError(index, `${prefix}.parent`, 'string/省略', item.parent, 'workflow')
      break
    case 'removeNode':
      if (typeof item.id !== 'string') throw fieldError(index, `${prefix}.id`, 'string', item.id, 'workflow')
      break
    case 'setProp':
      if (typeof item.id !== 'string') throw fieldError(index, `${prefix}.id`, 'string', item.id, 'workflow')
      if (typeof item.key !== 'string') throw fieldError(index, `${prefix}.key`, 'string', item.key, 'workflow')
      if (item.value !== null) assertEditableValue(index, `${prefix}.value`, item.value)
      break
    case 'setNeeds':
      if (typeof item.id !== 'string') throw fieldError(index, `${prefix}.id`, 'string', item.id, 'workflow')
      if (!Array.isArray(item.needs) || item.needs.some((id) => typeof id !== 'string')) throw fieldError(index, `${prefix}.needs`, 'string[]', item.needs, 'workflow')
      break
    case 'moveNode':
      if (typeof item.id !== 'string') throw fieldError(index, `${prefix}.id`, 'string', item.id, 'workflow')
      if (item.after !== null && typeof item.after !== 'string') throw fieldError(index, `${prefix}.after`, 'string/null', item.after, 'workflow')
      if (item.parent !== undefined && item.parent !== null && typeof item.parent !== 'string') throw fieldError(index, `${prefix}.parent`, 'string/null/省略', item.parent, 'workflow')
      break
    case 'setStages':
      if (!Array.isArray(item.stages) || item.stages.some((stage) => typeof record(stage).id !== 'string' || typeof record(stage).title !== 'string')) throw fieldError(index, `${prefix}.stages`, 'Array<{id:string,title:string}>', item.stages, 'workflow')
      break
    case 'setMeta':
      if (!['title', 'description', 'version'].includes(String(item.key))) throw fieldError(index, `${prefix}.key`, 'title/description/version', item.key, 'workflow')
      if (typeof item.value !== 'string') throw fieldError(index, `${prefix}.value`, 'string', item.value, 'workflow')
      break
    case 'setMetaValue':
      if (!['useWhen', 'tiers', 'leadInstructions', 'dynamicRules', 'budget'].includes(String(item.key))) throw fieldError(index, `${prefix}.key`, 'useWhen/tiers/leadInstructions/dynamicRules/budget', item.key, 'workflow')
      if (item.value !== null) assertEditableValue(index, `${prefix}.value`, item.value)
      break
    default:
      throw fieldError(index, `${prefix}.op`, 'addNode/removeNode/setProp/setNeeds/moveNode/setStages/setMeta/setMetaValue', item.op, 'workflow')
  }
}
function validateStepShapes(steps: unknown): ProposalStep[] {
  if (!Array.isArray(steps) || !steps.length || steps.length > 30)
    throw new StewardError(400, '提案需要 1–30 个步骤，请拆分改动')
  for (const [index, raw] of steps.entries()) {
    const step = record(raw)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fieldError(index, 'kind', 'command/workflow/file', raw)
    if (step.kind === undefined && step.type !== undefined)
      throw new StewardError(400, `steps[${index}].kind：期望 command/workflow/file，收到 undefined；字段名必须是 kind，不要使用 type。正确示例：${example('workflow')}`)
    if (!['command', 'workflow', 'file'].includes(String(step.kind))) throw fieldError(index, 'kind', 'command/workflow/file', step.kind)
    const kind = step.kind as ProposalStep['kind']
    assertOptionalString(index, step, 'spaceId', kind)
    assertOptionalString(index, step, 'title', kind)
    if (kind === 'command') {
      assertString(index, step, 'commandId', kind)
      if (!step.input || typeof step.input !== 'object' || Array.isArray(step.input)) throw fieldError(index, 'input', 'object', step.input, kind)
    } else if (kind === 'workflow') {
      assertString(index, step, 'workflowId', kind)
      assertString(index, step, 'baseRev', kind)
      if (!Array.isArray(step.edits) || !step.edits.length) throw fieldError(index, 'edits', '非空 WorkflowEdit[]', step.edits, kind)
      step.edits.forEach((edit, editIndex) => validateWorkflowEdit(index, edit, editIndex))
    } else {
      assertString(index, step, 'path', kind)
      assertString(index, step, 'content', kind)
      assertOptionalString(index, step, 'baseHash', kind)
    }
  }
  return steps as ProposalStep[]
}
function inversePatch(previous: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return previous ?? null
  const before = record(previous)
  return Object.fromEntries(
    Object.entries(record(patch)).map(([key, value]) => [
      key,
      Object.hasOwn(before, key)
        ? value && typeof value === 'object' && !Array.isArray(value)
          ? inversePatch(before[key], value)
          : before[key]
        : null,
    ]),
  )
}
export class StewardProposals {
  constructor(
    readonly deps: StewardDeps,
    readonly store: StewardStore,
    readonly userId: string,
  ) {}
  /**
   * 空间管理命令（space.*）作用于空间本身，由服务端注册表执行；模型常把目标空间填进 spaceId，
   * 归档空间又不在活跃列表里，按 spaceId 打开会误报"空间不存在"——这类步骤一律忽略 spaceId。
   */
  private serverLevel(step: ProposalStep): boolean {
    return step.kind === 'command' && typeof step.commandId === 'string' && step.commandId.startsWith('space.')
  }
  private async registry(step: ProposalStep): Promise<CommandRegistry> {
    if (step.spaceId && !this.serverLevel(step)) return (await this.deps.open(stewardId(step.spaceId))).commands
    if (!this.deps.serverCommands)
      throw new StewardError(400, '服务端命令尚未接入，请选择空间或联系管理员接入空间管理命令')
    return this.deps.serverCommands
  }
  private profile(step: ProposalStep): boolean {
    return step.kind === 'file' && !step.spaceId && step.path === 'profile.md'
  }
  private input(step: ProposalStep): Record<string, unknown> {
    if (step.kind === 'command') return step.input
    if (step.kind === 'workflow')
      return { workflowId: step.workflowId, baseRev: step.baseRev, edits: step.edits }
    return {
      path: step.path,
      content: step.content,
      ...(step.baseHash === undefined ? {} : { baseHash: step.baseHash }),
    }
  }
  async validate(steps: ProposalStep[]): Promise<Pick<Proposal, 'risk' | 'previews'>> {
    steps = validateStepShapes(steps)
    let risk: Proposal['risk'] = 'low'
    const previews: NonNullable<Proposal['previews']> = []
    for (const [index, step] of steps.entries()) {
      if (this.profile(step)) {
        if (step.kind !== 'file' || typeof step.content !== 'string')
          throw new StewardError(400, '记忆内容必须是文本')
        previews.push({
          kind: 'diff',
          title: '管家记忆',
          body: await diff('profile.md', await this.store.text('profile.md'), step.content),
        })
        continue
      }
      if (step.kind === 'command' && step.commandId.startsWith('steward.'))
        throw new StewardError(400, '内部撤销命令不能作为提案步骤，请使用普通写命令')
      const registry = await this.registry(step),
        commands = registry.list(),
        id = commandId(step),
        info = commands.find((c) => c.id === id)
      if (!info)
        throw new StewardError(
          400,
          `steps[${index}].${step.kind === 'command' ? 'commandId' : 'kind'}：命令 ${id} 尚未接入。相近命令：${closest(id, commands.map((c) => c.id)).join('、') || '无'}。正确示例：${example(step.kind)}`,
        )
      try {
        validateSchema(this.input(step), info.input)
      } catch (error) {
        throw new StewardError(400, `steps[${index}].input：命令 ${info.id} 参数不符合格式：${String(error)}。正确示例：${example(step.kind)}`)
      }
      let level: Proposal['risk'] =
        info.risk === 'dangerous'
          ? 'high'
          : [
                'requirement.create',
                'requirement.update',
                'knowledge.create',
                'knowledge.update',
              ].includes(info.id)
            ? 'low'
            : 'medium'
      if (await this.sensitive(step)) level = 'high'
      if (level === 'high' || (level === 'medium' && risk === 'low')) risk = level
      if (step.kind === 'workflow') {
        if (!step.spaceId || !this.deps.applyWorkflowEdits)
          throw new StewardError(400, 'workflow 预览尚未接入，请指定空间并接入源码编辑器')
        const doc = await (
          await this.deps.open(step.spaceId)
        ).workflows.get(stewardId(step.workflowId))
        this.validateWorkflowTargets(index, step, doc)
        let result: ReturnType<NonNullable<StewardDeps['applyWorkflowEdits']>>
        try {
          result = this.deps.applyWorkflowEdits(doc.source, step.edits)
        } catch (error) {
          throw new StewardError(400, `steps[${index}].edits：workflow 编辑无法预览：${String(error)}。可用节点 id：${this.workflowNodeIds(doc).join('、') || '无'}。正确示例：${example('workflow')}`)
        }
        if (result.diagnostics?.some((d) => d.severity === 'error'))
          throw new StewardError(400, `steps[${index}].edits：workflow 编辑无法通过校验，请修正提案。可用节点 id：${this.workflowNodeIds(doc).join('、') || '无'}`)
        previews.push({
          kind: 'diff',
          title: step.workflowId,
          body: await diff(doc.file, doc.source, result.source),
        })
      } else if (step.kind === 'file') {
        if (!step.spaceId) throw new StewardError(400, '请先指定文件所属空间')
        const space = await this.deps.open(step.spaceId)
        await stewardFile(space.dir, step.path, true)
        previews.push({
          kind: 'diff',
          title: step.path,
          body: await diff(
            step.path,
            (await readStewardFile(space.dir, step.path)) ?? '',
            step.content,
          ),
        })
      } else {
        if (step.commandId === 'file.write') {
          if (!step.spaceId) throw new StewardError(400, '请指定文件所属空间')
          await stewardFile((await this.deps.open(step.spaceId)).dir, String(step.input.path), true)
        }
        if (step.commandId === 'workflow.edit')
          throw new StewardError(400, 'workflow 编辑请使用 workflow 步骤，以便校验基线和预览')
        previews.push({
          kind: 'form',
          title: info.title,
          body: Object.entries(step.input)
            .map(
              ([key, value]) =>
                `${key}：${typeof value === 'string' ? value : JSON.stringify(value)}`,
            )
            .join('\n'),
        })
      }
    }
    return { risk, previews }
  }
  async create(
    threadId: string,
    title: string,
    summary: string,
    steps: ProposalStep[],
  ): Promise<Proposal> {
    return this.store.serial(async () => {
      await this.store.thread(threadId)
      if (!title.trim() || !summary.trim()) throw new StewardError(400, '请填写提案标题和原因')
      steps = validateStepShapes(steps)
      steps = await this.baselines(steps)
      const proposal: Proposal = {
        id: randomUUID(),
        threadId,
        title,
        summary,
        steps: structuredClone(steps),
        hash: proposalHash(steps),
        status: 'pending',
        createdAt: timestamp(this.deps),
        createdBy: stewardActor,
        ...(await this.validate(steps)),
      }
      await this.store.saveProposal(proposal)
      this.store.emit(threadId, { type: 'proposal', proposal })
      if (
        (await this.store.prefs()).trust === 'auto-low' &&
        proposal.risk === 'low' &&
        (await Promise.all(steps.map((step) => this.canUndo(step)))).every(Boolean)
      ) {
        proposal.auto = true
        await this.store.saveProposal(proposal)
        return this.approve(
          proposal.id,
          { hash: proposal.hash },
          { type: 'human', id: this.userId },
        )
      }
      return proposal
    })
  }
  private async baselines(steps: ProposalStep[]): Promise<ProposalStep[]> {
    const result = structuredClone(steps)
    const expected = new Map<string, string>()
    for (const step of result) {
      if (commandId(step) !== 'file.write') continue
      const key = `${step.spaceId ?? ''}:${this.input(step).path}`
      const current = expected.get(key) ?? sha256(String((await this.snapshot(step)) ?? ''))
      expected.set(key, sha256(String(this.input(step).content)))
      if (step.kind === 'file') step.baseHash ??= current
      else if (step.kind === 'command') step.input.baseHash ??= current
    }
    return result
  }
  private workflowNodeIds(doc: Awaited<ReturnType<StewardSpace['workflows']['get']>>): string[] {
    const ids: string[] = []
    const visit = (nodes: Array<{ id: string; body?: Array<{ id: string; body?: unknown }> }>) => {
      for (const node of nodes) {
        ids.push(node.id)
        if (Array.isArray(node.body)) visit(node.body as Array<{ id: string; body?: Array<{ id: string; body?: unknown }> }>)
      }
    }
    if (doc.snapshot) visit(doc.snapshot.nodes)
    else visit(doc.model.nodes)
    return ids
  }
  private validateWorkflowTargets(index: number, step: Extract<ProposalStep, { kind: 'workflow' }>, doc: Awaited<ReturnType<StewardSpace['workflows']['get']>>): void {
    const existingIds = new Set(this.workflowNodeIds(doc)),
      ids = new Set(existingIds),
      available = [...existingIds].join('、') || '无'
    for (const [editIndex, edit] of step.edits.entries()) {
      if (edit.op !== 'addNode') continue
      const rawId = edit.props.id as EditableValue | undefined,
        newId = rawId?.kind === 'literal' ? rawId.value : undefined
      if (typeof newId !== 'string') continue
      if (ids.has(newId))
        throw new StewardError(400, `steps[${index}].edits[${editIndex}].props.id：节点 ${newId} 已存在。当前 workflow 节点 id：${available}`)
      ids.add(newId)
    }
    for (const [editIndex, edit] of step.edits.entries()) {
      const item = edit as WorkflowEdit
      const check = (field: string, id: string | null | undefined, existing: boolean) => {
        if (!id || (existing ? ids.has(id) : true)) return
        throw new StewardError(400, `steps[${index}].edits[${editIndex}].${field}：节点 ${id} 不存在。当前 workflow 节点 id：${available}。正确示例：${example('workflow')}`)
      }
      if ('id' in item) check('id', item.id, true)
      if ('after' in item) check('after', item.after, true)
      if ('parent' in item) check('parent', item.parent, true)
      if (item.op === 'setNeeds') for (const [needIndex, id] of item.needs.entries()) check(`needs[${needIndex}]`, id, true)
    }
  }
  private async sensitive(step: ProposalStep): Promise<boolean> {
    if (!step.spaceId || this.serverLevel(step)) return false
    const space = await this.deps.open(step.spaceId)
    if (step.kind === 'workflow') {
      return (await space.stores.runs.list()).some(
        (run) =>
          run.workflowId === step.workflowId && ['running', 'waiting_human'].includes(run.status),
      )
    }
    if (
      step.kind !== 'command' ||
      !['knowledge.create', 'knowledge.update'].includes(step.commandId)
    )
      return false
    const input = step.commandId === 'knowledge.update' ? record(step.input.patch) : step.input
    const before = step.commandId === 'knowledge.update' ? record(await this.snapshot(step)) : {}
    const config = record(input.config)
    const oldConfig = record(before.config)
    const kind = String(input.kind ?? before.kind ?? '')
    const schema = space.stores.kb?.kinds().find((item) => item.kind === kind)?.configSchema ?? {}
    const changedSecret = (
      next: unknown,
      previous: unknown,
      spec: Record<string, unknown>,
    ): boolean => {
      if (hash(next) === hash(previous)) return false
      if (spec.format === 'secret') return true
      const properties = record(spec.properties)
      return Object.entries(record(next)).some(
        ([key, value]) =>
          (/^(driver|connection|headers|baseURL)$/i.test(key) &&
            hash(value) !== hash(record(previous)[key])) ||
          changedSecret(
            value,
            record(previous)[key],
            record(properties[key] ?? spec.additionalProperties),
          ),
      )
    }
    return changedSecret(config, oldConfig, schema)
  }
  private async canUndo(step: ProposalStep): Promise<boolean> {
    if (this.profile(step) || step.kind === 'workflow') return true
    const id = commandId(step),
      registry = await this.registry(step)
    const inverse: Record<string, string> = {
      'requirement.create': 'requirement.archive',
      'space.create': 'space.archive',
      'requirement.update': 'requirement.update',
      'knowledge.update': 'knowledge.update',
      'config.patch': 'config.patch',
      'knowledge.create': 'steward.knowledge.remove',
    }
    if (id === 'requirement.create' && this.input(step).start !== false) return false
    if (id === 'requirement.update' || id === 'knowledge.update') {
      const before = record(await this.snapshot(step)),
        input = this.input(step)
      const keys = Object.keys(id === 'knowledge.update' ? record(input.patch) : input).filter(
        (key) => !['id', 'requirementId', 'reason'].includes(key),
      )
      if (
        keys.some(
          (key) => before[key] === undefined && !(id === 'requirement.update' && key === 'dueAt'),
        )
      )
        return false
    }
    if (id === 'file.write')
      return (
        registry.list().some((c) => c.id === 'steward.file.restore') ||
        (await this.snapshot(step)) !== null
      )
    return !!inverse[id] && registry.list().some((c) => c.id === inverse[id])
  }
  private async snapshot(step: ProposalStep, result?: unknown): Promise<unknown> {
    if (this.profile(step)) return this.store.text('profile.md')
    const space = step.spaceId && !this.serverLevel(step) ? await this.deps.open(step.spaceId) : undefined
    if (step.kind === 'workflow') return (await space!.workflows.get(step.workflowId)).rev
    const id = commandId(step),
      input = this.input(step),
      out = record(result)
    if (id === 'file.write') return (await readStewardFile(space!.dir, String(input.path))) ?? null
    if (id === 'config.patch') return structuredClone(space!.stores.config)
    if (id.startsWith('requirement.')) {
      const reqId = input.requirementId ?? input.id ?? record(out.requirement).id ?? out.id
      if (!reqId) return null
      const req = await space!.stores.workspaces.getRequirement(String(reqId))
      if (!req) return null
      return id === 'requirement.create'
        ? {
            ...req,
            artifacts: await space!.stores.workspaces.listArtifacts(req.id),
            runs: await space!.stores.runs.list({ requirementId: req.id }),
          }
        : req
    }
    if (id.startsWith('knowledge.')) {
      const kbId = input.id ?? input.baseId ?? out.id ?? record(out.base).id
      return kbId ? ((await space!.stores.kb?.get(String(kbId))) ?? null) : null
    }
    if (id.startsWith('space.')) {
      const spaceId = input.id ?? out.id ?? record(out.space).id
      return (await this.deps.spaces()).find((s) => s.id === spaceId) ?? null
    }
    return null
  }
  private async checkBaseline(step: ProposalStep): Promise<void> {
    if (step.kind === 'workflow' && (await this.snapshot(step)) !== step.baseRev)
      throw new StewardError(409, 'workflow 已有新修订，请重新生成提案')
    const input = this.input(step)
    if (
      commandId(step) === 'file.write' &&
      typeof input.baseHash === 'string' &&
      sha256(String((await this.snapshot(step)) ?? '')) !== input.baseHash
    )
      throw new StewardError(409, '文件已被修改，请重新生成提案')
  }
  private async execute(step: ProposalStep, by: Actor, reason: string): Promise<unknown> {
    if (this.profile(step) && step.kind === 'file') {
      await this.store.writeText('profile.md', step.content)
      await this.store.append('audit.jsonl', {
        at: timestamp(this.deps),
        actor: by,
        onBehalfOf: 'steward',
        reason,
        action: 'profile.write',
      })
      return { path: 'profile.md' }
    }
    const context = { actor: by, reason, onBehalfOf: 'steward' }
    const result = await (await this.registry(step)).run(commandId(step), this.input(step), context)
    if (!result.ok) throw new Error(result.message)
    return result.result
  }
  private async reverse(item: UndoRecord, by: Actor, reason: string): Promise<void> {
    if (!item.reversible)
      throw new Error(`步骤 ${commandId(item.step)} 没有可用撤销命令，请人工处理`)
    const step = item.step,
      input = this.input(step),
      id = commandId(step),
      out = record(item.result)
    if (step.kind === 'workflow') {
      await (
        await this.deps.open(step.spaceId!)
      ).workflows.rollback(step.workflowId, String(item.before), by, reason)
      return
    }
    if (this.profile(step) && step.kind === 'file') {
      await this.execute({ ...step, content: String(item.before) }, by, reason)
      return
    }
    let undoId: string = id,
      undoInput: Record<string, unknown>
    if (id === 'file.write') {
      if ((await this.registry(step)).list().some((c) => c.id === 'steward.file.restore'))
        undoId = 'steward.file.restore'
      undoInput = {
        path: input.path,
        content: item.before,
        baseHash: sha256(String((await this.snapshot(step)) ?? '')),
      }
    } else if (id === 'config.patch') undoInput = { patch: inversePatch(item.before, input.patch) }
    else if (id === 'requirement.create') {
      undoId = 'requirement.archive'
      undoInput = { requirementId: record(out.requirement).id ?? out.id ?? input.id }
    } else if (id === 'space.create') {
      undoId = 'space.archive'
      undoInput = { id: out.id ?? record(out.space).id ?? input.id }
    } else if (id === 'knowledge.create') {
      undoId = 'steward.knowledge.remove'
      undoInput = { id: out.id ?? record(out.base).id ?? input.id }
    } else if (id === 'knowledge.update')
      undoInput = {
        id: input.id,
        patch: Object.fromEntries(
          Object.keys(record(input.patch)).map((key) => [key, record(item.before)[key]]),
        ),
      }
    else if (id === 'requirement.update') {
      undoInput = {
        ...input,
        ...Object.fromEntries(
          Object.keys(input)
            .filter((key) => !['id', 'baseId', 'requirementId'].includes(key))
            .map((key) => [key, record(item.before)[key] ?? null]),
        ),
      }
    } else throw new Error(`无法撤销 ${id}，请人工处理`)
    await this.execute(
      { kind: 'command', spaceId: step.spaceId, commandId: undoId, input: undoInput },
      by,
      reason,
    )
  }
  async approve(
    id: string,
    decision: ProposalDecisionRequest,
    by: Actor,
  ): Promise<Proposal> {
    return this.store.serial(async () => {
      const proposal = await this.store.proposal(id)
      if (proposal.status !== 'pending') throw new StewardError(409, '提案已处理，请刷新列表')
      if (proposal.hash !== decision.hash)
        throw new StewardError(409, '提案 hash 不一致，请重新预览后批准')
      if (proposalHash(proposal.steps) !== proposal.hash)
        throw new StewardError(409, '提案内容与 hash 不一致，请重新生成提案')
      if (decision.steps) {
        decision.steps = await this.baselines(validateStepShapes(decision.steps))
        Object.assign(proposal, await this.validate(decision.steps), {
          steps: structuredClone(decision.steps),
          edited: true,
          hash: proposalHash(decision.steps),
        })
      }
      for (const step of proposal.steps) {
        if (step.kind !== 'command' || !/(?:^|\.)(?:delete|remove|rm)$/.test(step.commandId))
          continue
        const target = record(await this.snapshot(step))
        const expected = target.name ?? target.title ?? target.id ?? step.input.id
        if (by.type !== 'human' || typeof expected !== 'string' || decision.confirm !== expected) {
          throw new StewardError(400, '删除操作需要在批准请求 confirm 中手动输入目标名称')
        }
      }
      Object.assign(proposal, await this.validate(proposal.steps))
      try {
        const checked = new Set<string>()
        for (const step of proposal.steps) {
          const key =
            commandId(step) === 'file.write'
              ? `${step.spaceId ?? ''}:${this.input(step).path}`
              : undefined
          if (key && checked.has(key)) continue
          await this.checkBaseline(step)
          if (key) checked.add(key)
        }
      } catch (error) {
        proposal.status = 'stale'
        proposal.error = String(error)
        await this.store.saveProposal(proposal)
        throw error
      }
      for (const step of proposal.steps.slice(0, -1))
        if (!(await this.canUndo(step)))
          throw new StewardError(400, '多步提案的前置步骤不可撤销，请拆分提案以避免失败后无法回滚')
      Object.assign(proposal, {
        decidedBy: by,
        decidedAt: timestamp(this.deps),
        reason: decision.reason,
        results: [],
      })
      const reason = `管家提案 ${proposal.id}：${proposal.title} /steward?thread=${proposal.threadId}`
      const done: UndoRecord[] = []
      // 批准先落盘，避免进程中断后再次执行同一提案。
      proposal.status = 'failed'
      proposal.error = '执行中断，请核对执行记录后处理'
      await this.store.saveProposal(proposal)
      try {
        for (const step of proposal.steps) {
          await this.checkBaseline(step)
          const before = structuredClone(await this.snapshot(step)),
            reversible = await this.canUndo(step)
          const result = structuredClone(await this.execute(step, by, reason))
          const item: UndoRecord = { step, before, reversible, result, after: '' }
          done.push(item)
          item.after = hash(await this.snapshot(step, result))
          proposal.results!.push({ ok: true, message: `${commandId(step)} 已执行`, result })
          await this.store.write(`undo/${id}.json`, done)
          await this.store.saveProposal(proposal)
        }
        proposal.status = 'applied'
        delete proposal.error
        if (done.every((item) => item.reversible))
          proposal.undoUntil = new Date(Date.parse(timestamp(this.deps)) + 86400000).toISOString()
      } catch (error) {
        proposal.status = 'failed'
        proposal.error = error instanceof Error ? error.message : String(error)
        proposal.results!.push({ ok: false, message: proposal.error })
        for (const item of [...done].reverse()) {
          try {
            await this.reverse(item, by, `${reason}（失败回滚）`)
          } catch (rollback) {
            proposal.error += `；回滚失败：${String(rollback)}`
          }
        }
      }
      await this.finish(proposal, proposal.status)
      return proposal
    })
  }
  async reject(id: string, by: Actor, reason?: string): Promise<Proposal> {
    return this.store.serial(async () => {
      const proposal = await this.store.proposal(id)
      if (proposal.status !== 'pending')
        throw new StewardError(409, '只有待批准提案可拒绝，请刷新列表')
      Object.assign(proposal, {
        status: 'rejected',
        decidedBy: by,
        decidedAt: timestamp(this.deps),
        reason: reason ?? '用户拒绝提案',
      })
      await this.finish(proposal, 'rejected')
      return proposal
    })
  }
  async undo(id: string, by: Actor, reason?: string): Promise<Proposal> {
    return this.store.serial(async () => {
      const proposal = await this.store.proposal(id)
      if (
        proposal.status !== 'applied' ||
        !proposal.undoUntil ||
        Date.parse(timestamp(this.deps)) >= Date.parse(proposal.undoUntil)
      )
        throw new StewardError(409, '提案不可撤销或已超过 24 小时，请生成新提案')
      const items = await this.store.read<UndoRecord[]>(`undo/${id}.json`)
      if (!items?.length) throw new StewardError(409, '撤销记录缺失，请人工核对')
      const checked = new Set<string>()
      for (const item of [...items].reverse()) {
        const input = this.input(item.step),
          out = record(item.result)
        const target = `${item.step.spaceId ?? ''}/${commandId(item.step).split('.')[0]}/${input.path ?? input.workflowId ?? input.requirementId ?? input.id ?? record(out.requirement).id ?? out.id ?? ''}`
        if (checked.has(target)) continue
        if (hash(await this.snapshot(item.step, item.result)) !== item.after)
          throw new StewardError(409, '目标已被修改，无法撤销，请生成新提案')
        checked.add(target)
      }
      try {
        for (const item of [...items].reverse())
          await this.reverse(item, by, `撤销管家提案 ${id}：${reason ?? proposal.title}`)
        proposal.status = 'reverted'
      } catch (error) {
        proposal.status = 'failed'
        proposal.error = `撤销未全部完成：${String(error)}`
      }
      await this.finish(proposal, proposal.status)
      return proposal
    })
  }
  private async finish(proposal: Proposal, outcome: string): Promise<void> {
    await this.store.saveProposal(proposal)
    this.store.emit(proposal.threadId, { type: 'proposal', proposal })
    await this.store.append('metrics.jsonl', {
      at: timestamp(this.deps),
      feature: 'steward.proposal',
      type: outcome,
      proposalId: proposal.id,
      edited: proposal.edited ?? false,
      commands: proposal.steps.map(commandId),
      ms: Date.parse(timestamp(this.deps)) - Date.parse(proposal.createdAt),
    })
    await this.store.feed({ type: 'proposal', at: timestamp(this.deps), proposal })
  }
}
