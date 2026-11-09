import type { AttentionItem } from '../../interfaces.js'
import type { AgentNodeDef, ArtifactRef, NodeContext, ReviewNodeDef, ReviewRecord, ReviewResponse, ReviewRound, ReviewIssueEntry, Checkpoint, ReviewerSpec, EventPayloads, SnapshotManifest } from '../../types.js'
import type { Entry } from '../graph.js'
import type { Runtime } from '../runtime.js'
import { safeNodeName, saveWorktreeDiff } from '../execution.js'
import { callHarness } from '../harness.js'
import { collectOutputs, resolveInputs } from '../artifacts.js'
import { addUsage } from '../../insights/usage.js'
import { sha256 } from '../../util/hash.js'
import { system } from '../actor.js'
import { assertResponses, normalizeResponses, REVIEW_SCHEMA, RESPONSES_SCHEMA, reviewPassed } from './review-schema.js'
import { reviewTargets, targetFingerprint } from './review-target.js'
import { noReviewProgress, reviewContinuity } from './review-continuity.js'
import { normalizeRounds } from '../../review/records.js'
import { scheduleCheckpoint, finishCheckpoint, type CaptureContext } from '../checkpoints.js'
import { createSnapshot, artifactMaterials, codeMaterials, snapshotPrompt, snapshotMaterials, type SnapshotMaterial } from '../snapshots.js'
import { replayIssues, recordIssues, recordResponses, issuePrompt } from '../issues.js'

export interface ReviewProgress {
  issues?: ReviewIssueEntry[]
  pending?: ReviewRound
  pendingTargets?: ArtifactRef[]
  pendingSnapshot?: SnapshotManifest
  references?: ArtifactRef[]
  history?: ReviewRound[]
  humanFeedback?: string
  restartAfterRevision?: boolean
  rounds: ReviewRound[]
  phase: 'review' | 'revise' | 'signoff' | 'exhausted' | 'decision' | 'done'
}

async function saveArtifact(host: Runtime, node: ReviewNodeDef, path: string, content: string, inputs: ArtifactRef[], actor = system): Promise<void> {
  const ref = await host.guard.system(host.workspacePaths([path]), () => host.deps.stores.workspaces.writeArtifact({
    ref: { workspace: host.state.requirementId, path }, content, kind: 'review', author: actor,
    reason: node.title, derivedFrom: inputs, producedBy: Object.assign({ runId: host.state.runId, nodeId: node.id }, actor.type === 'agent' ? { invocationId: actor.invocationId } : {}),
  }))
  const ns = host.state.nodes[node.id]!
  ns.outputs = [...ns.outputs.filter((output) => output.path !== path), ref]
  await host.emit('artifact.written', { ref, kind: 'review', sha256: sha256(content) }, node.id, actor)
}

async function persist(host: Runtime, node: ReviewNodeDef, progress: ReviewProgress): Promise<void> {
  const ns = host.state.nodes[node.id]!
  const round = progress.rounds.at(-1)
  ns.result = { passed: progress.phase === 'done', rounds: progress.rounds.length }
  if (round) await saveArtifact(host, node, `reviews/${node.id}/r${round.revision ?? 1}-round-${round.round}.json`, JSON.stringify(round, null, 2), round.records.flatMap((record) => record.artifacts))
  const lines = [`# ${node.title}`, '', `状态：${progress.phase === 'done' ? '通过' : progress.phase === 'revise' ? '作者修改中' : '评审中 / 未通过'}`, '']
  for (const item of [...(progress.history ?? []), ...progress.rounds]) {
    lines.push(`## 修订 ${item.revision ?? 1} · 第 ${item.round} 轮（序号 ${item.seq ?? item.round}）：${item.passed ? '通过' : '未通过'}`)
    for (const record of item.records) {
      lines.push(`### ${record.reviewer}：${record.verdict}`, record.summary,
        `产物：${record.artifacts.map((ref) => `${ref.path} v${ref.version}`).join('、')}`)
      for (const issue of record.issues) {
        const response = item.responses.find((response) => response.reviewer === record.reviewer && response.issueId === issue.id)
        lines.push(`- ${issue.id} [${issue.severity}] ${issue.location ?? ''} ${issue.description}；建议：${issue.suggestion ?? '无'}`,
          `  作者回应：${response ? `${response.action}：${response.note}` : '未回应'}`)
      }
    }
    if (item.revised.length) lines.push(`修改后版本：${item.revised.map((ref) => `${ref.path} v${ref.version}`).join('、')}`)
  }
  await saveArtifact(host, node, `reviews/${node.id}/summary.md`, lines.join('\n'), ns.inputs ?? [])
  await host.persistGraph()
}

async function invoke(host: Runtime, node: ReviewNodeDef, ctx: NodeContext, role: string, harness: AgentNodeDef['harness'], prompt: string, schema: Record<string, unknown>, writeScope?: string[], capture?: CaptureContext): ReturnType<typeof callHarness> {
  const ns = host.state.nodes[node.id]!
  // 每个角色使用独立临时状态，绝不把上一位评审者的 sessionRef 传给下一位。
  const sources = !Array.isArray(node.target) ? Object.values(host.state.nodes).filter((state) => state.worktree?.repo === (node.target as { code: { repo: string } }).code.repo
    && (!ctx.item || host.graph.get(state.id)?.item?.key === ctx.item.key)) : []
  const session = { ...ns, worktree: undefined, sessionRef: undefined, usage: undefined }
  if (sources[0]?.worktree) ctx = { ...ctx, projectDir: sources[0].worktree.path }
  if (sources.length > 1) prompt += `\n工作树：${JSON.stringify(sources.map((state) => ({ nodeId: state.id, ...state.worktree })))}`
  const result = await callHarness(host, { ...node, kind: 'agent', role, harness, prompt, resultSchema: schema, session: 'fresh', writeScope }, ctx, session, true, sources.map((state) => state.worktree!.path), capture)
  if (writeScope === undefined) for (const source of sources) await saveWorktreeDiff(host, source.id, source, undefined, result.actor)
  if (session.usage) ns.usage = addUsage(ns.usage ?? { inputTokens: 0, outputTokens: 0 }, session.usage)
  return result
}

export async function run(host: Runtime, entry: Entry, ctx: NodeContext): Promise<void> {
  const node = entry.def
  if (node.kind !== 'review') throw new Error('内部错误：不是 review')
  const ns = host.state.nodes[node.id]!
  const progress = host.reviews[node.id] ??= { rounds: [], phase: 'review' }
  progress.issues = replayIssues(await host.deps.stores.events.read(ctx.runId, { nodeId: node.id }))
  const normalized = normalizeRounds([...(progress.history ?? []), ...progress.rounds])
  const historyCount = progress.history?.length ?? 0
  progress.history = normalized.slice(0, historyCount)
  progress.rounds = normalized.slice(historyCount)
  ns.revision = progress.rounds.at(-1)?.revision ?? (progress.history.at(-1)?.revision ?? 0) + 1
  for (;;) {
    host.signal.throwIfAborted()
    if (ns.status === 'stale') return
    if (progress.phase === 'done') { await persist(host, node, progress); return }
    if (progress.phase === 'review') {
      let artifacts: ArtifactRef[]
      try {
        artifacts = progress.pendingTargets ?? await reviewTargets(host, node, ctx)
        if (!progress.pending) progress.references = await host.guard.system(host.workspacePaths(node.references ?? []), () => resolveInputs(host.deps.stores, host.state, { ...node, inputs: (node.references ?? []).map(path => ({ path })) }, host.emit))
      } catch (error) {
        for (const [index, reviewer] of node.reviewers.entries()) {
          const point = await scheduleCheckpoint(host, node.id, 'reviewer', reviewer.role, reviewer.checklist, ns.revision, progress.rounds.length + 1)
          await finishCheckpoint(host, point, index === 0 ? 'error' : 'skipped', error)
        }
        throw error
      }
      ns.inputs = [...new Map([...(ns.inputs ?? []), ...artifacts, ...(progress.references ?? [])].map((ref) => [ref.path, ref])).values()]
      const prior = progress.rounds.at(-1) ?? progress.history?.at(-1)
      const round: ReviewRound = progress.pending ?? { round: progress.rounds.length + 1, revision: ns.revision, seq: (prior?.seq ?? 0) + 1,
        targetFingerprint: await targetFingerprint(host.deps.stores.workspaces, artifacts, !Array.isArray(node.target)),
        passed: false, records: [], responses: [], revised: [] }
      ns.round = round.round
      progress.pending = round
      progress.pendingTargets = artifacts
      await host.persistGraph()
      const recovered = await host.deps.stores.events.read(ctx.runId, { nodeId: node.id, types: ['review.result'] })
      for (const event of recovered) {
        const result = event.data as EventPayloads['review.result']
        if (result.revision !== round.revision || result.round !== round.round) continue
        if (!round.records.some(record => record.reviewer === result.record.reviewer && record.arbiter === result.record.arbiter)) round.records.push(result.record)
        const record = result.record
        const path = `reviews/${node.id}/r${round.revision ?? 1}-round-${round.round}/${safeNodeName(record.reviewer)}${record.arbiter ? '-arbiter' : ''}.json`
        if (!await host.deps.stores.workspaces.readArtifact({ workspace: ctx.requirementId, path })) await saveArtifact(host, node, path, JSON.stringify(record, null, 2), record.artifacts, event.actor)
        const finished = await host.deps.stores.events.read(ctx.runId, { nodeId: node.id, types: ['checkpoint.finished'] })
        if (!finished.some(event => (event.data as EventPayloads['checkpoint.finished']).id === result.checkpointId)) {
          await host.emit('checkpoint.finished', { id: result.checkpointId, status: 'done' }, node.id)
        }
      }
      const scheduled: Array<{ reviewer: ReviewerSpec; point: Checkpoint }> = []
      for (const reviewer of node.reviewers) {
        if (round.records.some(record => !record.arbiter && record.reviewer === reviewer.role)) continue
        scheduled.push({ reviewer, point: await scheduleCheckpoint(host, node.id, 'reviewer', reviewer.role, reviewer.checklist, round.revision, round.round) })
      }
      let materials: SnapshotMaterial[]
      try {
        materials = progress.pendingSnapshot ? await snapshotMaterials(host.deps.stores.taktDir, progress.pendingSnapshot) : [...await artifactMaterials(host, artifacts, 'target'), ...await artifactMaterials(host, progress.references ?? [], 'reference')]
        if (!progress.pendingSnapshot && !Array.isArray(node.target)) {
          const target = node.target.code
          for (const source of Object.values(host.state.nodes).filter(state => state.worktree?.repo === target.repo && (!ctx.item || host.graph.get(state.id)?.item?.key === ctx.item.key))) {
            materials.push(...await codeMaterials(source.worktree!.path, target.repo, target.base ?? source.worktree!.base))
          }
        }
      } catch (error) {
        for (const [index, item] of scheduled.entries()) await finishCheckpoint(host, item.point, index === 0 ? 'error' : 'skipped', error)
        throw error
      }
      const reviewOne = async (reviewer: ReviewerSpec, point: Checkpoint, arbiter = false) => {
        try {
          const snapshot = await createSnapshot(host, point, materials)
          progress.pendingSnapshot ??= snapshot
          await host.persistGraph()
          const prompt = [`${arbiter ? '裁决' : '评审'}第 ${round.round} 轮。只读产物，不修改文件。`,
            snapshotPrompt(host.deps.stores.taktDir, snapshot), !Array.isArray(node.target) ? `代码范围：${JSON.stringify(node.target.code)}` : '', `版本清单：${JSON.stringify(snapshot.files)}`,
            `focus：${reviewer.focus ?? ''}`, `checklist：${JSON.stringify(reviewer.checklist ?? [])}`, `rubric：${node.rubric ?? ''}`,
            issuePrompt(progress.issues ?? []), arbiter ? `全部评审记录：${JSON.stringify(round.records)}` : '',
            prior ? `上一轮作者回应：${JSON.stringify(prior.responses)}` : '',
          ].filter(Boolean).join('\n')
          const result = await invoke(host, node, ctx, reviewer.role, reviewer.harness, prompt, REVIEW_SCHEMA, [], { role: arbiter ? 'arbiter' : 'reviewer', checkpointId: point.id, snapshot })
          const value = structuredClone(result.data) as ReviewRecord
          if (value.score !== undefined && !Number.isFinite(value.score)) throw new Error('评审分数必须是有限数值')
          if (value.issues.some(issue => !issue.id.trim()) || new Set(value.issues.map(issue => issue.id)).size !== value.issues.length) throw new Error('评审问题 ID 必须非空且唯一')
          const record: ReviewRecord = { ...value, round: round.round, reviewer: reviewer.role, artifacts, at: host.timestamp(),
            arbiter: arbiter || undefined, checkpointId: point.id, invocationId: result.actor.type === 'agent' ? result.actor.invocationId : undefined }
          await recordIssues(host, node.id, progress.issues ??= [], record, round.revision ?? 1)
          await host.emit('review.result', { checkpointId: point.id, revision: round.revision ?? 1, round: round.round, record }, node.id, result.actor)
          round.records.push(record)
          await saveArtifact(host, node, `reviews/${node.id}/r${round.revision ?? 1}-round-${round.round}/${safeNodeName(reviewer.role)}${arbiter ? '-arbiter' : ''}.json`, JSON.stringify(record, null, 2), artifacts, result.actor)
          await host.persistGraph()
          await finishCheckpoint(host, point, 'done')
          return record
        } catch (error) { await finishCheckpoint(host, point, 'error', error); throw error }
      }
      for (const [index, item] of scheduled.entries()) {
        try { await reviewOne(item.reviewer, item.point) }
        catch (error) {
          for (const rest of scheduled.slice(index + 1)) await finishCheckpoint(host, rest.point, 'skipped', '前一评审者出错；等待重试')
          await saveArtifact(host, node, `reviews/${node.id}/r${round.revision ?? 1}-round-${round.round}.json`, JSON.stringify(round, null, 2), artifacts)
          await host.persistGraph()
          throw error
        }
      }
      round.passed = reviewPassed(round.records.filter(record => !record.arbiter), node.pass)
      const conflict = round.records.some(record => !record.arbiter && record.verdict === 'approve')
        && round.records.some(record => !record.arbiter && record.verdict !== 'approve' && record.issues.some(issue => issue.severity === 'blocker'))
      if (node.arbiter && conflict) {
        const arbiter = node.arbiter
        let record = round.records.find(record => record.arbiter && record.reviewer === arbiter.role)
        if (!record) record = await reviewOne(arbiter, await scheduleCheckpoint(host, node.id, 'arbiter', `arbiter:${arbiter.role}`, arbiter.checklist, round.revision, round.round), true)
        round.passed = record.verdict === 'approve'
        await host.emit('review.arbitrated', { round: round.round, arbiter: arbiter.role, verdict: record.verdict, conflict: '评审者通过与含 blocker 的修改 / 拒绝意见冲突' }, node.id)
      }
      delete progress.pending
      delete progress.pendingTargets
      delete progress.pendingSnapshot
      round.continuity = reviewContinuity(round, prior)
      progress.rounds.push(round)
      if (noReviewProgress(progress.rounds, node.stopAfterNoProgress)) round.stopReason = 'no_progress'
      progress.phase = round.passed ? node.humanSignoff ? 'signoff' : 'done' : !round.stopReason && round.round < node.maxRounds ? 'revise' : 'exhausted'
      await persist(host, node, progress)
      await host.emit('review.round', { round: round.round, passed: round.passed, verdicts: round.records.map((record) => ({ reviewer: record.reviewer, verdict: record.verdict, score: record.score, issues: record.issues.length })) }, node.id)
    } else if (progress.phase === 'revise') {
      const round = progress.rounds.at(-1)!
      const extra = typeof node.author.prompt === 'function' ? await node.author.prompt(ctx) : node.author.prompt
      const prompt = `按第 ${round.round} 轮意见修改产物，每个问题恰好一条 responses：reviewer 填评审人，issueId 填该问题的 id 字段（不是 key），round 填 ${round.round}。\n${JSON.stringify(round.records)}\n${extra ?? ''}\n人工意见：${progress.humanFeedback ?? ''}`
      const point = await scheduleCheckpoint(host, node.id, 'author', `author:${node.author.role}`, ['按评审意见逐条回应并修改产物'], round.revision, round.round)
      let result: Awaited<ReturnType<typeof invoke>>
      try {
        result = await invoke(host, node, ctx, node.author.role, node.author.harness, prompt, RESPONSES_SCHEMA, undefined, { role: 'author', checkpointId: point.id })
        const responses = normalizeResponses(round.records, (result.data as { responses: ReviewResponse[] }).responses, round.round)
        assertResponses(round.records, responses, round.round)
        round.responses = responses
        await recordResponses(host, node.id, progress.issues ??= [], round.records, round.responses, round.revision ?? 1, point.id)
        const targets = [...new Map(round.records.flatMap((record) => record.artifacts).map((ref) => [ref.path, ref])).values()]
        const records = await host.deps.stores.workspaces.listArtifacts(ctx.requirementId)
        const outputs = targets.map((ref) => ({ path: ref.path, kind: records.find((record) => record.path === ref.path)!.kind }))
        const revisedState = { ...ns, outputs: [] }
        await host.guard.system(host.workspacePaths(targets.map((ref) => ref.path)), () => collectOutputs(host.deps.stores, host.state, { ...node, outputs }, revisedState,
          result.actor, host.emit))
        round.revised = revisedState.outputs
        progress.phase = 'review'
        await persist(host, node, progress)
        await host.emit('review.response', { round: round.round, responses: round.responses, revised: round.revised }, node.id)
        await finishCheckpoint(host, point, 'done')
      } catch (error) { await finishCheckpoint(host, point, 'error', error); throw error }
      if (progress.restartAfterRevision) {
        progress.history = [...(progress.history ?? []), ...progress.rounds]
        progress.rounds = []; ns.revision = (ns.revision ?? 1) + 1; ns.round = 0; delete progress.restartAfterRevision
        await host.persistGraph()
      }
    } else if (progress.phase === 'signoff') {
      await host.request(entry, `评审 ${node.title} 第 ${ns.round} 轮已通过，请人工确认。`, 'approve', undefined, true, progress.rounds.at(-1)!.records[0]!.artifacts)
      return
    } else if (progress.phase === 'exhausted') {
      const action = typeof node.onExhausted === 'object' ? 'rework' : node.onExhausted
      await host.emit('review.exhausted', { rounds: progress.rounds.length, action, reason: progress.rounds.at(-1)?.stopReason }, node.id)
      if (action === 'fail') throw new Error(progress.rounds.at(-1)?.stopReason === 'no_progress'
        ? `评审 ${node.id} 连续无进展，提前结束` : `评审 ${node.id} 已用完 ${node.maxRounds} 轮`)
      if (typeof node.onExhausted === 'object') {
        const target = host.state.nodes[node.onExhausted.rework]!
        if ((target.reworks ?? 0) < (node.onExhausted.maxReworks ?? 1)) {
          await rework(host, entry, node.onExhausted.rework, progress); return
        }
      }
      progress.phase = 'decision'
      await host.persistGraph()
      await host.request(entry, `评审 ${node.title} 轮次或打回次数已用完，请裁决。`, 'choice', ['放行', '打回', '终止'])
      return
    } else return
  }
}

function feedback(progress: ReviewProgress): string {
  const round = progress.rounds.at(-1)
  return JSON.stringify({ round: round?.round, records: round?.records.map(({ reviewer, summary, issues }) => ({ reviewer, summary, issues })), responses: round?.responses })
}

export async function answerReview(host: Runtime, entry: Entry, item: AttentionItem): Promise<void> {
  const node = entry.def
  if (node.kind !== 'review') throw new Error('内部错误：不是 review')
  const progress = host.reviews[node.id]
  if (!progress) throw new Error(`缺少评审恢复记录：${node.id}`)
  const ns = host.state.nodes[node.id]!
  if (item.decision === 'cancelled') { ns.status = 'cancelled'; return }
  if (progress.phase === 'signoff') {
    if (item.decision === 'approve') progress.phase = 'done'
    else if (item.decision === 'reject') {
      progress.humanFeedback = item.answer ?? '人工拒绝本轮评审'
      progress.phase = progress.rounds.length < node.maxRounds ? 'revise' : 'exhausted'
    } else throw new Error('评审确认需要 approve / reject')
  } else if (progress.phase === 'decision') {
    if (item.decision !== 'choice') throw new Error('评审裁决需要 choice')
    if (item.answer === '放行') progress.phase = 'done'
    else if (item.answer === '终止') throw new Error('人工终止评审')
    else if (item.answer === '打回') {
      // 没有显式 rework 策略时，重启本评审的作者修改轮次，不猜测上游作者节点。
      if (typeof node.onExhausted === 'object') { await rework(host, entry, node.onExhausted.rework, progress); return }
      progress.restartAfterRevision = true
      progress.phase = 'revise'
    } else throw new Error('未知评审裁决选项')
  } else throw new Error(`评审阶段不能消费人工回答：${progress.phase}`)
  ns.status = 'pending'
  await persist(host, node, progress)
}

async function rework(host: Runtime, entry: Entry, target: string, progress: ReviewProgress): Promise<void> {
  await host.rework(entry, target, feedback(progress))
  for (const [id, current] of Object.entries(host.reviews)) {
    if (host.state.nodes[id] && !current.rounds.length && current.history?.length) {
      host.state.nodes[id]!.revision = (normalizeRounds(current.history).at(-1)?.revision ?? 1) + 1
    }
  }
  await host.save()
}
