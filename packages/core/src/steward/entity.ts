import type { GraphNode, StewardContextRef, StewardEntitySnapshot, StewardStageStatus, StewardTone } from '../api.js'
import type { RunState } from '../types.js'
import { buildRunGraph, stageProgress } from '../insights/graph.js'
import { currentNode } from '../insights/current-node.js'
import { deriveRequirementState } from '../insights/requirement.js'
import { nodeActivity } from '../insights/activity.js'
import { loadRunGraph } from '../store/run-graph.js'
import { type StewardDeps, type StewardSpace, StewardError } from './contracts.js'

export const stageStatus = (status: string): StewardStageStatus =>
  status === 'waiting_human' ? 'waiting' : ['done', 'running', 'failed', 'skipped'].includes(status) ? status as StewardStageStatus : 'todo'
export const stateTone = (status: string): StewardTone =>
  ['succeeded', 'delivered'].includes(status) ? 'success' : ['failed', 'blocked', 'cancelled'].includes(status) ? 'failed' : status === 'waiting_human' ? 'waiting' : ['running', 'active'].includes(status) ? 'running' : status === 'stale' ? 'stale' : 'neutral'
const stateWords: Record<string, string> = { pending: '还没开始', ready: '准备运行', running: '在跑', waiting_human: '等你确认', succeeded: '已完成', failed: '失败', blocked: '已阻塞', cancelled: '已取消', skipped: '已跳过', stale: '需要重跑', draft: '还没开始', active: '进行中', delivered: '已交付', archived: '已归档' }
const stateWord = (status: string) => stateWords[status] ?? status

export async function pipelineRuns(space: StewardSpace, requirementId: string): Promise<RunState[]> {
  return (await space.stores.runs.list({ requirementId }))
    .filter(run => run.kind !== 'task' && run.workflowId !== 'lead' && !run.workflowId.startsWith('task:'))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.runId.localeCompare(a.runId))
}

export async function entityRun(space: StewardSpace, id: string) {
  const run = await space.stores.runs.get(id)
  const workflow = await space.stores.runs.getWorkflow(id)
  if (!run || !workflow) throw new StewardError(404, '运行不存在或缺少流程快照，请刷新后重新选择运行')
  const records = await loadRunGraph(space.stores, id)
  return { run, workflow, graph: buildRunGraph(workflow, run, records), stages: stageProgress(workflow, run, records) }
}

/** 旧泳道和实体卡共用状态口径，Lead 临时任务不改变需求的交付阶段。 */
export async function requirementState(space: StewardSpace, id: string) {
  const requirement = await space.stores.workspaces.getRequirement(id)
  if (!requirement) throw new StewardError(404, '需求不存在，请刷新后重新选择需求')
  const runs = await pipelineRuns(space, id)
  const attention = await space.stores.attention.list({ requirementId: id, pending: true })
  const detail = runs[0] ? await entityRun(space, runs[0].runId) : undefined
  const derived = detail && requirement.status !== 'archived' ? deriveRequirementState(detail.workflow, detail.run) : undefined
  return { requirement, runs, attention, detail, status: derived?.status ?? requirement.status, stage: derived?.stage ?? requirement.stage }
}

function runStatus(detail: Awaited<ReturnType<typeof entityRun>>): string {
  const current = currentNode(detail.run, detail.graph)
    ?? detail.graph.nodes.find(node => ['failed', 'blocked', 'cancelled'].includes(node.status))
  return current ? `${current.title}${stateWord(current.status)}` : stateWord(detail.run.status)
}

/** 需求快照：已经取过 requirementState 的调用方（如 picks）直接传进来，不用再推导一遍。 */
export function requirementSnapshot({ requirement, attention, detail, status, stage }: Awaited<ReturnType<typeof requirementState>>, at: string): StewardEntitySnapshot {
  const label = detail?.stages.find(item => item.id === stage)?.title
  const waiting = attention.length > 0 || detail?.graph.nodes.some(node => node.status === 'waiting_human')
  const description = status === 'archived' || status === 'delivered' ? stateWord(status)
    : detail ? [label, attention.length ? '等你确认' : status === 'active' && detail.run.status === 'succeeded' ? '流程已结束，尚未交付' : runStatus(detail)].filter(Boolean).join(' · ') : stateWord(status)
  return { title: requirement.title, status: description, tone: waiting ? 'waiting' : stateTone(status),
    ...(attention.length ? { summary: `${attention.length} 件等你决定` } : {}),
    stages: detail?.stages.map(stage => ({ label: stage.title, status: stageStatus(stage.status) })) ?? [], at }
}

export async function entitySnapshot(space: StewardSpace, ref: StewardContextRef, at = new Date().toISOString()): Promise<StewardEntitySnapshot> {
  if (ref.spaceId && ref.spaceId !== space.id) throw new StewardError(404, '对象不属于该空间，请重新选择引用')
  if (ref.type === 'requirement') return requirementSnapshot(await requirementState(space, ref.id), at)
  if (ref.type === 'run' || ref.type === 'node') {
    if (ref.type === 'node' && !ref.parent) throw new StewardError(400, '节点引用缺少 parent 运行编号，请补齐后重试')
    const detail = await entityRun(space, ref.type === 'run' ? ref.id : ref.parent!)
    if (ref.type === 'run') return { title: `${detail.workflow.title} · ${ref.id}`, status: runStatus(detail), tone: detail.graph.nodes.some(node => node.status === 'waiting_human') ? 'waiting' : stateTone(detail.run.status), stages: detail.stages.map(stage => ({ label: stage.title, status: stageStatus(stage.status) })), at }
    const node = detail.graph.nodes.find(node => node.id === ref.id)
    if (!node) throw new StewardError(404, '节点不在该运行图中，请刷新后重新选择节点')
    return { title: node.title, status: await nodeStatus(space, detail.run, node, at), tone: stateTone(node.status), at }
  }
  if (ref.type === 'space') {
    if (ref.id !== space.id) throw new StewardError(404, '空间引用不匹配，请重新选择空间')
    const states = await Promise.all((await space.stores.workspaces.listRequirements()).map(req => requirementState(space, req.id)))
    const active = states.filter(item => item.status === 'active' || item.status === 'blocked').length
    const waiting = (await space.stores.attention.list({ pending: true })).length
    return { title: space.name, status: `${active} 个进行中 · ${waiting} 件等你`, tone: waiting ? 'waiting' : active ? 'running' : 'neutral', at }
  }
  if (ref.type === 'workflow') {
    const doc = await space.workflows.get(ref.id)
    const title = doc.model.meta.title
    return { title: doc.snapshot?.title ?? (title.kind === 'literal' ? String(title.value) : doc.id), status: doc.diagnostics.some(item => item.severity === 'error') ? '流程需要修正' : '流程可查看', tone: 'neutral', at }
  }
  if (ref.type === 'knowledge') {
    const base = await space.stores.kb?.get(ref.id)
    if (!base) throw new StewardError(404, '知识库不存在，请刷新后重新选择知识库')
    const words = { draft: '尚未构建', building: '构建中', ready: '已就绪', stale: '需要更新', error: '构建失败' }
    return { title: base.name, status: words[base.status], tone: base.status === 'error' ? 'failed' : base.status === 'ready' ? 'success' : base.status === 'building' ? 'running' : base.status === 'stale' ? 'stale' : 'neutral', at }
  }
  throw new StewardError(400, '该对象不支持实体快照，请选择需求、运行、节点、空间、流程或知识库')
}

async function nodeStatus(space: StewardSpace, run: RunState, node: GraphNode, at: string): Promise<string> {
  const activity = node.status === 'running' ? nodeActivity((await space.stores.events.read(run.runId)).filter(event => event.nodeId === node.id), Date.parse(at)) : undefined
  const action = activity ? { thinking: '正在思考', tool: `正在执行 ${activity.tool ?? '工具'}`, compacting: '正在整理上下文', waiting_tool: `等待 ${activity.tool ?? '工具'}` }[activity.state] : undefined
  return [stateWord(node.status), node.harness, action].filter(Boolean).join(' · ')
}

/** 只确认对象在不在（不推导状态）：引用校验对每个块、每行都会跑一次。 */
async function entityExists(space: StewardSpace, ref: StewardContextRef): Promise<boolean> {
  switch (ref.type) {
    case 'space': return ref.id === space.id
    case 'requirement': return Boolean(await space.stores.workspaces.getRequirement(ref.id))
    case 'run': return Boolean(await space.stores.runs.get(ref.id) && await space.stores.runs.getWorkflow(ref.id))
    case 'node': return Boolean(ref.parent) && (await entityRun(space, ref.parent!)).graph.nodes.some(node => node.id === ref.id)
    case 'workflow': return space.workflows.get(ref.id).then(() => true, () => false)
    case 'knowledge': return Boolean(await space.stores.kb?.get(ref.id))
    default: return false
  }
}

export async function resolveEntityRef(deps: StewardDeps, ref: StewardContextRef): Promise<StewardContextRef | undefined> {
  const visible = (await deps.spaces()).filter(space => !space.archived)
  const id = ref.spaceId ?? (ref.type === 'space' ? ref.id : undefined)
  const matches: StewardContextRef[] = []
  for (const summary of visible.filter(space => !id || space.id === id)) {
    const resolved = { ...ref, spaceId: summary.id }
    // 读不到的对象不呈现引用，调用方会返回校验 issue
    if (await entityExists(await deps.open(summary.id), resolved).catch(() => false)) matches.push(resolved)
  }
  return matches.length === 1 ? matches[0] : undefined
}
