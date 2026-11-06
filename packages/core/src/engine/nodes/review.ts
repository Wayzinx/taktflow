import type { AttentionItem } from '../../interfaces.js'
import type { AgentNodeDef, ArtifactRef, NodeContext, ReviewNodeDef, ReviewRecord, ReviewResponse, ReviewRound } from '../../types.js'
import type { Entry } from '../graph.js'
import type { Runtime } from '../runtime.js'
import { saveWorktreeDiff } from '../execution.js'
import { callHarness } from '../harness.js'
import { resolveInputs } from '../artifacts.js'
import { addUsage } from '../../insights/usage.js'
import { sha256 } from '../../util/hash.js'
import { system } from '../actor.js'
import { assertResponses, REVIEW_SCHEMA, RESPONSES_SCHEMA, reviewPassed } from './review-schema.js'
import type { CaptureContext } from '../capture-types.js'
import { inlineAsset } from '../capture-assets.js'
import { canonicalJson } from '../../util/hash.js'
import { materializeCheckpoint, scheduleCheckpoint } from '../checkpoint.js'
import { AUTHOR_TEMPLATE, REVIEWER_TEMPLATE, renderTemplate } from '../prompt-renderer.js'
import { assignIssues, existingIssues } from './review-issues.js'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { reviewTargets } from './review-target.js'

export interface ReviewProgress {
  history?: ReviewRound[]
  active?: { round: ReviewRound; artifacts: ArtifactRef[]; references: ArtifactRef[]; checkpointIds?: string[] }
  humanFeedback?: string
  restartAfterRevision?: boolean
  rounds: ReviewRound[]
  phase: 'review' | 'revise' | 'signoff' | 'exhausted' | 'decision' | 'done'
}

async function saveArtifact(host: Runtime, node: ReviewNodeDef, path: string, content: string, inputs: ArtifactRef[]): Promise<void> {
  const ref = await host.guard.system(host.workspacePaths([path]), () => host.deps.stores.workspaces.writeArtifact({
    ref: { workspace: host.state.requirementId, path }, content, kind: 'review', author: system,
    reason: node.title, derivedFrom: inputs, producedBy: { runId: host.state.runId, nodeId: node.id },
  }))
  const ns = host.state.nodes[node.id]!
  ns.outputs = [...ns.outputs.filter((output) => output.path !== path), ref]
  await host.emit('artifact.written', { ref, kind: 'review', sha256: sha256(content) }, node.id)
}

async function persist(host: Runtime, node: ReviewNodeDef, progress: ReviewProgress): Promise<void> {
  const ns = host.state.nodes[node.id]!
  const round = progress.rounds.at(-1)
  ns.result = { passed: progress.phase === 'done', rounds: progress.rounds.length }
  if (round) await saveArtifact(host, node, `reviews/${node.id}/round-${round.round}.json`, JSON.stringify(round, null, 2), round.records.flatMap((record) => record.artifacts))
  const lines = [`# ${node.title}`, '', `状态：${progress.phase === 'done' ? '通过' : progress.phase === 'revise' ? '作者修改中' : '评审中 / 未通过'}`, '']
  for (const item of [...(progress.history ?? []), ...progress.rounds]) {
    lines.push(`## 第 ${item.round} 轮：${item.passed ? '通过' : '未通过'}`)
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

async function invoke(host: Runtime, node: ReviewNodeDef, ctx: NodeContext, role: string, harness: AgentNodeDef['harness'], prompt: string, schema: Record<string, unknown>, writeScope?: string[], capture: CaptureContext = {}, outputs = node.outputs): Promise<Awaited<ReturnType<typeof callHarness>> & { outputs: ArtifactRef[] }> {
  const ns = host.state.nodes[node.id]!
  // 每个角色使用独立临时状态，绝不把上一位评审者的 sessionRef 传给下一位。
  const sources = !Array.isArray(node.target) ? Object.values(host.state.nodes).filter((state) => state.worktree?.repo === (node.target as { code: { repo: string } }).code.repo
    && (!ctx.item || host.graph.get(state.id)?.item?.key === ctx.item.key)) : []
  const session = { ...ns, inputs: capture.materials?.map((item) => item.ref) ?? ns.inputs, worktree: undefined, sessionRef: undefined, usage: undefined }
  if (capture.snapshotDir) ctx = { ...ctx, readArtifact: async (path) => {
    if (!capture.materials?.some((item) => item.ref.path === path)) throw new Error(`不在评审快照中：${path}`)
    return readFile(join(capture.snapshotDir!, path), 'utf8')
  } }
  if (sources[0]?.worktree) ctx = { ...ctx, projectDir: sources[0].worktree.path }
  if (sources.length > 1) {
    const trees = canonicalJson(sources.map((state) => ({ nodeId: state.id, ...state.worktree })))
    prompt += `\n工作树：${trees}`
    if (capture.render) capture = { ...capture, render: { ...capture.render, params: { ...capture.render.params, worktrees: trees }, suffix: '\n工作树：{{worktrees}}' } }
  }
  const result = await callHarness(host, { ...node, kind: 'agent', role, harness, prompt, outputs, resultSchema: schema, session: 'fresh', writeScope }, ctx, session, true, sources.map((state) => state.worktree!.path), capture)
  if (writeScope === undefined) for (const source of sources) await saveWorktreeDiff(host, source.id, source)
  if (session.usage) ns.usage = addUsage(ns.usage ?? { inputTokens: 0, outputTokens: 0 }, session.usage)
  return { ...result, outputs: session.outputs }
}

export async function run(host: Runtime, entry: Entry, ctx: NodeContext): Promise<void> {
  const node = entry.def
  if (node.kind !== 'review') throw new Error('内部错误：不是 review')
  const ns = host.state.nodes[node.id]!
  const progress = host.reviews[node.id] ??= { rounds: [], phase: 'review' }
  for (;;) {
    host.signal.throwIfAborted()
    if (ns.status === 'stale') return
    if (progress.phase === 'done') { await persist(host, node, progress); return }
    if (progress.phase === 'review') {
      if (!progress.active) {
        const artifacts = await reviewTargets(host, node, ctx)
        const references = await host.guard.system(host.workspacePaths(node.references), () => resolveInputs(host.deps.stores, host.state,
          { ...node, inputs: (node.references ?? []).map((path) => ({ path })) }, host.emit))
        progress.active = { round: { round: progress.rounds.length + 1, passed: false, records: [], responses: [], revised: [] }, artifacts, references }
      }
      const { round, artifacts, references } = progress.active
      const sourceEvents = await host.deps.stores.events.read(host.state.runId, { nodeId: node.id, types: ['review.result'] })
      for (const event of sourceEvents) {
        const { record, checkpointId } = event.data as import('../../types.js').EventPayloads['review.result']
        if (progress.active.checkpointIds?.includes(checkpointId) && !round.records.some((item) => item.reviewer === record.reviewer)) round.records.push(record)
      }
      ns.inputs = [...new Map([...(ns.inputs ?? []), ...artifacts, ...references].map((ref) => [ref.path, ref])).values()]
      const prior = progress.rounds.at(-1)
      ns.round = round.round
      await host.persistGraph()
      await host.save()
      const materials = [...artifacts.map((ref) => ({ ref, role: 'target' as const })), ...references.map((ref) => ({ ref, role: 'reference' as const }))]
      const scheduled = []
      // 先登记整轮检查点，后续某一位失败时，尚未执行者仍有可追溯身份。
      for (const reviewer of node.reviewers) {
        if (round.records.some((record) => record.reviewer === reviewer.role)) continue
        const duty = inlineAsset(`review-duty:${node.id}:${reviewer.role}`, canonicalJson({ template: REVIEWER_TEMPLATE, focus: reviewer.focus ?? '', checklist: reviewer.checklist ?? [], rubric: node.rubric ?? '' }))
        const checkpoint = await scheduleCheckpoint(host, node.id, materials, duty, { round: round.round, reviewer: reviewer.role })
        scheduled.push({ reviewer, duty, checkpoint })
        progress.active.checkpointIds ??= []
        progress.active.checkpointIds.push(checkpoint.checkpointId)
      }
      await host.persistGraph()
      const keys = sourceEvents.flatMap((event) => (event.data as import('../../types.js').EventPayloads['review.result']).record.issues.map((issue) => Number(issue.key?.slice(4)) || 0))
      let nextKey = Math.max(0, ...keys)
      for (const { reviewer, duty, checkpoint } of scheduled) {
        const snapshotDir = await materializeCheckpoint(host, checkpoint)
        const existing = existingIssues([...(progress.history ?? []), ...progress.rounds, round])
        const params = { round: round.round, target: node.target,
          materials: checkpoint.materials.filter((item) => item.role === 'target').map((item) => ({ ...item.ref, sha256: item.sha256, snapshotPath: join(snapshotDir, item.ref.path) })),
          references: checkpoint.materials.filter((item) => item.role === 'reference').map((item) => ({ ...item.ref, sha256: item.sha256, snapshotPath: join(snapshotDir, item.ref.path) })),
          focus: reviewer.focus ?? '', checklist: reviewer.checklist ?? [], rubric: node.rubric ?? '',
          existing: existing.filter((issue) => issue.reviewer === reviewer.role),
          prior: { issues: prior?.records.find((record) => record.reviewer === reviewer.role)?.issues ?? [], responses: prior?.responses.filter((response) => response.reviewer === reviewer.role) ?? [] },
        }
        const result = await invoke(host, node, { ...ctx, workspaceDir: snapshotDir }, reviewer.role, reviewer.harness, renderTemplate(REVIEWER_TEMPLATE, params), REVIEW_SCHEMA, [], {
          review: { round: round.round, part: 'reviewer', reviewer: reviewer.role }, checkpoint, materials, snapshotDir,
          render: { kind: 'review-reviewer', template: REVIEWER_TEMPLATE, params, duty },
          replayNotes: Array.isArray(node.target) ? [] : ['代码评审依赖工作树，文档调用回放不支持'],
        })
        const value = result.data as Pick<ReviewRecord, 'verdict' | 'score' | 'summary' | 'issues' | 'previous'>
        if (value.score !== undefined && !Number.isFinite(value.score)) throw new Error('评审分数必须是有限数值')
        if (value.issues.some((issue) => !issue.id.trim()) || new Set(value.issues.map((issue) => issue.id)).size !== value.issues.length) throw new Error('评审问题 ID 必须非空且唯一')
        assignIssues(value, existing, reviewer.role, () => `ISS-${++nextKey}`)
        const record: ReviewRecord = { ...value, round: round.round, reviewer: reviewer.role, artifacts, checkpointId: checkpoint.checkpointId, invocationId: result.invocationId, at: host.timestamp() }
        await host.emit('review.result', { checkpointId: checkpoint.checkpointId, invocationId: result.invocationId, record, references }, node.id, result.actor)
        round.records.push(record)
        await host.persistGraph()
      }
      round.passed = reviewPassed(round.records, node.pass)
      progress.rounds.push(round)
      delete progress.active
      progress.phase = round.passed ? node.humanSignoff ? 'signoff' : 'done' : round.round < node.maxRounds ? 'revise' : 'exhausted'
      await persist(host, node, progress)
      await host.emit('review.round', { round: round.round, passed: round.passed, verdicts: round.records.map((record) => ({ reviewer: record.reviewer, verdict: record.verdict, score: record.score, issues: record.issues.length })) }, node.id)
    } else if (progress.phase === 'revise') {
      const round = progress.rounds.at(-1)!
      const extra = typeof node.author.prompt === 'function' ? await node.author.prompt(ctx) : node.author.prompt
      const targets = [...new Map(round.records.flatMap((record) => record.artifacts).map((ref) => [ref.path, ref])).values()]
      const records = await host.deps.stores.workspaces.listArtifacts(ctx.requirementId)
      const outputs = targets.map((ref) => ({ path: ref.path, kind: records.find((record) => record.path === ref.path)!.kind }))
      const params = { round: round.round, records: round.records, extra: extra ?? '', feedback: progress.humanFeedback ?? '' }
      const result = await invoke(host, node, ctx, node.author.role, node.author.harness, renderTemplate(AUTHOR_TEMPLATE, params), RESPONSES_SCHEMA, undefined, {
        review: { round: round.round, part: 'author' }, render: { kind: 'review-author', template: AUTHOR_TEMPLATE, params, staticPrompt: typeof node.author.prompt === 'function' ? node.author.prompt.toString() : node.author.prompt ?? '' },
        replayNotes: typeof node.author.prompt === 'function' ? ['动态作者 prompt 只冻结本次求值结果'] : [],
      }, outputs)
      const value = result.data as { responses: ReviewResponse[] }
      assertResponses(round.records, value.responses, round.round)
      round.responses = value.responses
      round.revised = result.outputs
      progress.phase = 'review'
      await persist(host, node, progress)
      await host.emit('review.response', { round: round.round, responses: round.responses, revised: round.revised }, node.id)
      if (progress.restartAfterRevision) {
        progress.history = [...(progress.history ?? []), ...progress.rounds]
        progress.rounds = []; delete progress.restartAfterRevision
        await host.persistGraph()
      }
    } else if (progress.phase === 'signoff') {
      await host.request(entry, `评审 ${node.title} 第 ${ns.round} 轮已通过，请人工确认。`, 'approve', undefined, true)
      return
    } else if (progress.phase === 'exhausted') {
      const action = typeof node.onExhausted === 'object' ? 'rework' : node.onExhausted
      await host.emit('review.exhausted', { rounds: progress.rounds.length, action }, node.id)
      if (action === 'fail') throw new Error(`评审 ${node.id} 已用完 ${node.maxRounds} 轮`)
      if (typeof node.onExhausted === 'object') {
        const target = host.state.nodes[node.onExhausted.rework]!
        if ((target.reworks ?? 0) < (node.onExhausted.maxReworks ?? 1)) {
          await host.rework(entry, node.onExhausted.rework, feedback(progress)); return
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
      progress.rounds.at(-1)!.passed = false
      progress.phase = progress.rounds.length < node.maxRounds ? 'revise' : 'exhausted'
    } else throw new Error('评审确认需要 approve / reject')
  } else if (progress.phase === 'decision') {
    if (item.decision !== 'choice') throw new Error('评审裁决需要 choice')
    if (item.answer === '放行') progress.phase = 'done'
    else if (item.answer === '终止') throw new Error('人工终止评审')
    else if (item.answer === '打回') {
      // 没有显式 rework 策略时，重启本评审的作者修改轮次，不猜测上游作者节点。
      if (typeof node.onExhausted === 'object') { await host.rework(entry, node.onExhausted.rework, feedback(progress)); return }
      progress.restartAfterRevision = true
      progress.phase = 'revise'
    } else throw new Error('未知评审裁决选项')
  } else throw new Error(`评审阶段不能消费人工回答：${progress.phase}`)
  ns.status = 'pending'
  await persist(host, node, progress)
}
