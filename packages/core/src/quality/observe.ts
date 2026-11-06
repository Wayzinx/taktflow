import type { ProjectStores } from '../interfaces.js'
import type { ArtifactRef, EventEnvelope, EventPayloads, ReviewIssue, ReviewRecord, SnapshotNode } from '../types.js'
import type { CheckpointRef, Invocation, Observation } from '../quality.js'

export const OBSERVATION_PROCESSOR = 'document-review-observations'
export const OBSERVATION_PROCESSOR_VERSION = '1'

interface IssueState {
  issue: ReviewIssue
  record: ReviewRecord
  checkpoint: CheckpointRef
  seq: number
  resolved: boolean
}

function documents(nodes: SnapshotNode[], result: Set<string>, prefix = ''): void {
  for (const node of nodes) {
    const id = prefix + node.id
    if (node.kind === 'review' && Array.isArray(node.review?.target)) result.add(id)
    documents(node.body ?? [], result, `${id}/`)
  }
}

export async function isDocumentReview(stores: ProjectStores, runId: string, nodeId: string): Promise<boolean> {
  const [run, snapshot] = await Promise.all([stores.runs.get(runId), stores.runs.getWorkflow(runId)])
  if (!run || !snapshot) return false
  const nodes = new Set<string>()
  documents(snapshot.nodes, nodes)
  for (const expansion of run.expansions) documents(expansion.nodes ?? [], nodes)
  return nodes.has(nodeId)
}

function subject(issue: ReviewIssue, artifacts: ArtifactRef[]): Observation['subject'] {
  const matched = artifacts.filter((ref) => issue.location === ref.path || issue.location?.startsWith(`${ref.path}:`) || issue.location?.startsWith(`${ref.path}#`))
  // 多个被评审文件且未指出位置时，不猜测问题属于哪个文件；检查点仍保留完整材料。
  return { artifact: matched.length === 1 ? matched[0] : artifacts.length === 1 ? artifacts[0] : undefined, location: issue.location }
}

function projector(requirementId: string, reviewNodes: Set<string>) {
  const checkpoints = new Map<string, CheckpointRef>()
  const invocations = new Map<string, Invocation>()
  const authors = new Map<string, { invocation: Invocation; seq: number }>()
  const issues = new Map<string, IssueState>()
  const records: Array<{ nodeId: string; record: ReviewRecord; checkpoint: CheckpointRef; seq: number }> = []
  const requests = new Map<string, string>()
  const exhausted = new Set<string>()
  const keyOf = (node: string, reviewer: string, key: string) => JSON.stringify([node, reviewer, key])

  return (event: EventEnvelope): Observation[] => {
    const nodeId = event.nodeId
    if (event.type === 'dag.expanded') documents((event.data as EventPayloads['dag.expanded']).nodes ?? [], reviewNodes)
    if (!nodeId || !reviewNodes.has(nodeId)) return []
    const observations: Observation[] = []
    const emit = (kind: Observation['kind'], itemIndex: number, state: IssueState, text: string, source: Observation['source'] = 'review', invocationId: string | null | undefined = state.record.invocationId) => {
      const checkpoint = state.checkpoint
      observations.push({
        id: `${source}:${event.runId}:${event.seq}:${itemIndex}`, source, kind, requirementId,
        runId: event.runId, nodeId, attempt: checkpoint.attempt, round: state.record.round,
        checkpointId: checkpoint.checkpointId, invocationId: invocationId ?? undefined, issueKey: state.issue.key,
        subject: subject(state.issue, state.record.artifacts), severity: state.issue.severity, text,
        evidence: [...new Set([`run:${event.runId}:${event.seq}`, `run:${event.runId}:${state.seq}`,
          `checkpoint:${checkpoint.checkpointId}`, ...(invocationId ? [`invocation:${invocationId}`] : [])])], at: event.ts,
      })
    }
    switch (event.type) {
      case 'checkpoint.scheduled': {
        const checkpoint = event.data as EventPayloads['checkpoint.scheduled']
        checkpoints.set(checkpoint.checkpointId, checkpoint)
        break
      }
      case 'invocation.started': {
        const { invocation } = event.data as EventPayloads['invocation.started']
        invocations.set(invocation.invocationId, invocation)
        break
      }
      case 'invocation.finished': {
        const data = event.data as EventPayloads['invocation.finished']
        const invocation = invocations.get(data.invocationId)
        if (invocation?.review?.part === 'author' && data.outcome.status === 'ok') authors.set(nodeId, { invocation, seq: event.seq })
        break
      }
      case 'review.result': {
        const data = event.data as EventPayloads['review.result']
        const checkpoint = checkpoints.get(data.checkpointId)
        if (!checkpoint || checkpoint.nodeId !== nodeId || checkpoint.runId !== event.runId) throw new Error(`评审结果缺少对应检查点：${data.checkpointId}`)
        const record = { ...data.record, invocationId: data.invocationId ?? data.record.invocationId }
        records.push({ nodeId, record, checkpoint, seq: event.seq })
        const seen = new Set<string>()
        for (const [index, issue] of record.issues.entries()) {
          const key = keyOf(nodeId, record.reviewer, issue.key ?? `legacy:${event.seq}:${issue.id}`)
          if (seen.has(key)) continue
          seen.add(key)
          const state = { issue, record, checkpoint, seq: event.seq, resolved: false }
          issues.set(key, state)
          // 每次调用的提出都是独立观察；相同 key 关联历史，不按相似文本合并。
          emit('found', index, state, issue.description)
        }
        const checked = new Set<string>()
        for (const [index, previous] of (record.previous ?? []).entries()) {
          const key = keyOf(nodeId, record.reviewer, previous.key)
          const old = issues.get(key)
          if (!old || checked.has(key)) continue
          checked.add(key)
          if (previous.status === 'not_checked') continue
          if (previous.status === 'resolved' && seen.has(key)) throw new Error(`同一问题同时提出和 resolved：${previous.key}`)
          const state = { ...old, record, checkpoint, resolved: previous.status === 'resolved' }
          issues.set(key, state)
          emit(state.resolved ? 'verified_fixed' : 'still_open', record.issues.length + index, state, previous.note ?? old.issue.description)
        }
        break
      }
      case 'review.response': {
        const data = event.data as EventPayloads['review.response']
        const seen = new Set<string>()
        for (const [index, response] of data.responses.entries()) {
          const result = [...records].reverse().find((item) => item.nodeId === nodeId && item.record.round === data.round && item.record.reviewer === response.reviewer)
          const issue = result?.record.issues.find((item) => item.id === response.issueId)
          if (!result || !issue) throw new Error(`作者回应缺少原评审问题：${nodeId}/${data.round}/${response.reviewer}/${response.issueId}`)
          const key = keyOf(nodeId, response.reviewer, issue.key ?? `legacy:${result.seq}:${issue.id}`)
          if (seen.has(key)) continue
          seen.add(key)
          const state = issues.get(key)!
          const author = authors.get(nodeId)
          emit(response.action === 'fixed' ? 'claimed_fixed' : response.action === 'declined' ? 'declined' : 'still_open', index,
            state, response.note, 'review', author && author.seq > result.seq && author.invocation.review?.round === data.round ? author.invocation.invocationId : null)
        }
        break
      }
      case 'review.exhausted':
        if ((event.data as EventPayloads['review.exhausted']).action !== 'fail') exhausted.add(nodeId)
        break
      case 'human.requested':
        requests.set((event.data as EventPayloads['human.requested']).requestId, nodeId)
        break
      case 'human.answered': {
        const data = event.data as EventPayloads['human.answered']
        if (event.actor.type !== 'human' || requests.get(data.requestId) !== nodeId) break
        if (data.decision !== 'approve' && !(data.decision === 'choice' && data.answer === '放行' && exhausted.has(nodeId))) break
        let index = 0
        for (const state of issues.values()) if (state.checkpoint.nodeId === nodeId && !state.resolved) {
          emit('overridden', index++, state, data.answer ?? '人工批准放行', 'human')
        }
        requests.delete(data.requestId)
        exhausted.delete(nodeId)
        break
      }
    }
    return observations
  }
}

/** 调用方持有空间租约。重建历史上下文，但仅把游标后的事件入账。 */
export async function syncObservations(stores: ProjectStores, runId: string): Promise<{ runId: string; seq: number; observations: number }> {
  const quality = stores.quality
  if (!quality) throw new Error('当前存储未接入质量日志')
  const [run, snapshot] = await Promise.all([stores.runs.get(runId), stores.runs.getWorkflow(runId)])
  if (!run || !snapshot) throw new Error(`运行或工作流快照不存在：${runId}`)
  const verification = await stores.events.verify(runId)
  if (!verification.ok) throw new Error(`源运行日志校验失败：${runId}，${verification.reason}，seq=${verification.brokenAt}`)
  const reviewNodes = new Set<string>()
  documents(snapshot.nodes, reviewNodes)
  for (const expansion of run.expansions) documents(expansion.nodes ?? [], reviewNodes)
  const project = projector(run.requirementId, reviewNodes)
  const key = { runId, processor: OBSERVATION_PROCESSOR, processorVersion: OBSERVATION_PROCESSOR_VERSION }
  let seq = await quality.getCursor(key)
  let observations = 0
  for (const event of await stores.events.read(runId)) {
    const produced = project(event)
    if (event.seq <= seq) continue
    const commit = await quality.advanceCursor({ ...key, seq: event.seq }, {
      events: produced.map((data) => ({ type: 'observation.recorded', actor: { type: 'system', id: OBSERVATION_PROCESSOR }, data })),
      idempotencyKeys: produced.map((item) => item.id),
    })
    observations += Math.max(0, commit.appended - 1)
    seq = event.seq
  }
  return { runId, seq, observations: Math.max(0, observations) }
}
