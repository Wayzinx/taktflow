import { join } from 'node:path'
import type { ProjectStores } from '../interfaces.js'
import type { EvalSampleRequest, CheckpointDetail } from '../api.js'
import type { Actor, Defect, DefectAttribution, EvalCase, EventPayloads, Invocation, RunState, SnapshotManifest } from '../types.js'
import { nodeQuality } from '../insights/node-quality.js'
import { snapshotMaterials } from '../engine/snapshots.js'
import { assertArtifactPath, assertNodeId, assertRunId } from '../store/paths.js'
import { sha256 } from '../util/hash.js'
import { assertReplayRole } from './isolation.js'
import { appendEvalObject, evalRevision, evalView, qualityStore } from './quality-access.js'

export interface ReplaySource { run: RunState; checkpoint: CheckpointDetail; invocation: Invocation; snapshot: SnapshotManifest; prompt: string }
export async function replaySource(stores: ProjectStores, checkpointId: string, runId?: string, nodeId?: string): Promise<ReplaySource> {
  if (runId) assertRunId(runId)
  if (nodeId) assertNodeId(nodeId)
  if (!checkpointId?.trim()) throw new Error('请提供检查点 id')
  const runs = runId ? [await stores.runs.get(runId)] : await stores.runs.list()
  for (const run of runs) {
    if (!run) continue
    for (const node of nodeId ? [nodeId] : Object.keys(run.nodes)) {
      const view = await nodeQuality(stores, run.runId, node)
      const point = view.checkpoints.find(c => c.id === checkpointId)
      if (!point) continue
      assertReplayRole(point.role)
      if (point.status !== 'done') throw new Error('检查点未执行完成；请选择完成的只读检查点')
      const snapshot = point.snapshot
      if (!snapshot || snapshot.checkpointId !== checkpointId) throw new Error('检查点没有冻结快照；请重新采集后添加样本')
      assertArtifactPath(snapshot.dir)
      if (!snapshot.dir.startsWith(`snapshots/${run.runId}/`)) throw new Error('快照不属于原运行；请检查清单')
      await snapshotMaterials(stores.taktDir, snapshot)
      const invocation = view.invocations.filter(i => i.checkpointId === checkpointId && i.outcome === 'ok').at(-1)
      if (!invocation) throw new Error('检查点缺少成功调用身份；请重新采集后添加样本')
      const events = await stores.events.read(run.runId, { nodeId: node })
      const prompt = events.find(e => e.type === 'harness.message' && e.actor.type === 'agent' && e.actor.invocationId === invocation.id
        && (e.data as EventPayloads['harness.message']).role === 'user')?.data as EventPayloads['harness.message'] | undefined
      if (!prompt?.text.trim()) throw new Error('检查点缺少实际调用 prompt；请补齐采集后重试')
      return { run, checkpoint: point, invocation, snapshot, prompt: prompt.text }
    }
  }
  throw new Error('找不到检查点；请核对运行与检查点 id')
}

export function confirmedMiss(defect: Defect, attribution: DefectAttribution | undefined, checkpointId: string): boolean {
  const item = attribution?.checkpoints?.find(c => c.checkpointId === checkpointId)
  return defect.validity === 'valid' && !!item && item.verdict === 'should_have_caught' && item.confirmed?.by.type === 'human'
    && ['existed', 'materialProvided', 'inDuty', 'executed', 'notRaised'].every(key => item.conditions[key as keyof typeof item.conditions] === true)
}

export async function checkpointCase(stores: ProjectStores, source: ReplaySource, kind: 'must_catch' | 'clean', defect?: Defect, expectIssue?: string): Promise<EvalCase> {
  const { run, checkpoint, snapshot, invocation } = source
  const materials = await snapshotMaterials(stores.taktDir, snapshot)
  return { id: `sample-${sha256(`${checkpoint.id}:${kind}:${defect?.id ?? ''}`).slice(0, 32)}`,
    target: { kind: 'node', workflowId: run.workflowId, nodeId: checkpoint.nodeId }, title: defect?.title ?? `无缺陷评审：${checkpoint.subject}`,
    source: { kind: defect ? 'defect' : 'manual', runId: run.runId, nodeId: checkpoint.nodeId, defectId: defect?.id },
    node: { id: checkpoint.nodeId, kind: 'agent', title: checkpoint.subject, role: invocation.agentRole ?? checkpoint.subject, needs: [],
      harness: invocation.harness, completion: checkpoint.duties },
    prompt: source.prompt, inputs: materials.map(m => ({ path: m.path, content: m.content.toString() })),
    grading: kind === 'must_catch' ? { mustFind: [expectIssue ?? defect!.title] } : {}, createdAt: new Date().toISOString(),
    sample: { kind, checkpointId: checkpoint.id, snapshot: snapshot.dir, expectIssue: kind === 'must_catch' ? expectIssue ?? defect!.title : undefined } }
}

export async function addEvalSample(stores: ProjectStores, request: EvalSampleRequest, by: Actor): Promise<EvalCase> {
  const baseRevision = request.baseRevision
  if (by.type !== 'human') throw new Error('评测样本必须由人确认；请以人工身份提交')
  if (!request.reason.trim()) throw new Error('添加样本必须填写 reason；请说明确认依据')
  if (request.expectIssue !== undefined && !request.expectIssue.trim()) throw new Error('期望问题不能为空；请填写 expectIssue 或使用缺陷标题')
  const source = await replaySource(stores, request.checkpointId)
  let defect: Defect | undefined
  if (request.kind === 'must_catch') {
    if (!request.defectId) throw new Error('必须拦住样本需要缺陷 id；请先确认漏检归因')
    const found = (await qualityStore(stores).defects(source.run.requirementId)).find(d => d.id === request.defectId)
    if (!found || !confirmedMiss(found, found.attribution, request.checkpointId)) throw new Error('缺少人确认的漏检五条件；请先确认归因')
    if (baseRevision === undefined) throw new Error('必须拦住样本需要 baseRevision；请读取当前缺陷版本后提交')
    defect = found
  } else if (request.kind === 'clean') {
    if (source.checkpoint.role !== 'reviewer' || !source.checkpoint.record) throw new Error('无缺陷样本必须来自已完成的评审调用；请选择评审者检查点')
    if (source.checkpoint.record.issues.some(i => i.severity === 'blocker' || i.severity === 'major')) throw new Error('原评审仍有 blocker / major；请核实无缺陷证据后选择其他检查点')
  } else throw new Error('样本分类无效；请选择 must_catch 或 clean')
  const value = await checkpointCase(stores, source, request.kind, defect, request.expectIssue)
  const existing = (await evalView<EvalCase>(stores, 'samples')).find(row => row.id === value.id)
  if (existing && !existing.sample?.retiredAt) return existing
  if (existing) throw new Error('样本已退役；请重新采集检查点，不要覆盖退役记录')
  await appendEvalObject(stores, 'sample.added', value, { by, reason: request.reason, baseRevision: evalRevision(undefined),
    requirementId: source.run.requirementId, defectRevision: defect ? { defectId: defect.id, revision: baseRevision! } : undefined })
  return value
}

export async function retireEvalSample(stores: ProjectStores, id: string, by: Actor, reason: string, baseRevision: string): Promise<void> {
  if (by.type !== 'human') throw new Error('退役样本必须由人确认；请以人工身份提交')
  const sample = (await evalView<EvalCase>(stores, 'samples')).find(value => value.id === id)
  if (!sample?.sample) throw new Error('检查点样本不存在；请重新读取样本列表')
  await appendEvalObject(stores, 'sample.retired', { id, retiredAt: new Date().toISOString() }, { by, reason, baseRevision })
}

export function remapReplayPrompt(stores: ProjectStores, source: ReplaySource, prompt: string, cwd: string): string {
  // 先替换最具体的快照路径，绝不把旧工作区当成本轮输入。
  return prompt.split(join(stores.taktDir, source.snapshot.dir, 'files')).join(join(cwd, 'materials'))
    .split(stores.workspaces.dir(source.run.requirementId)).join(join(cwd, 'materials'))
    .split(stores.projectDir).join(cwd)
}
