import type { ProjectStores } from '../interfaces.js'
import type { NodeScorecard } from '../api.js'
import type { ArtifactRecord, EventEnvelope, EventPayloads, NodeRecipe, Observation, RunState, VerdictCategory } from '../types.js'
import { canonicalJson } from '../util/hash.js'
import { addUsage, summarizeUsage } from '../insights/usage.js'
import { readReviewRounds } from '../insights/review-rounds.js'
import { snapshotNodes } from '../engine/recipe.js'
import { listDefects } from '../defects/index.js'

export interface ScorecardOptions { by: 'node' | 'recipe' | 'skill'; workflowId?: string }
interface Sample {
  kind?: import('../types.js').NodeKind; run: RunState; nodeId: string; recipe?: NodeRecipe; firstAt: string; events: EventEnvelope[]; pass: boolean
  artifacts: ArtifactRecord[]; rounds: number; reworks: number; issues: NodeScorecard['review']['issues']; edits: NodeScorecard['humanEdits']; editedPaths: Set<string>;
  downstream: NodeScorecard['downstream']; escapes: Set<string>; missed: Set<string>; caught: Set<string>; detector: boolean
}
const emptyIssues = () => ({ blocker: 0, major: 0, minor: 0, nit: 0 })
function producer(artifacts: ArtifactRecord[], path: string, version?: number, excluded = new Set<string>()) {
  const artifact = artifacts.find((item) => item.path === path)
  return artifact?.versions.filter((item) => version === undefined || item.version <= version).filter((item) => item.producedBy && !excluded.has(`${item.producedBy.runId}:${item.producedBy.nodeId}`)).at(-1)?.producedBy
}
export async function scorecards(stores: ProjectStores, options: ScorecardOptions): Promise<NodeScorecard[]> {
  if (!['node', 'recipe', 'skill'].includes(options.by)) throw new Error('by 必须为 node、recipe 或 skill')
  const runs = (await stores.runs.list()).filter((run) => !options.workflowId || run.workflowId === options.workflowId)
  const samples: Sample[] = []
  for (const run of runs) {
    const events = await stores.events.read(run.runId), artifacts = await stores.workspaces.listArtifacts(run.requirementId)
    const snapshot = await stores.runs.getWorkflow(run.runId)
    const definitions = snapshotNodes([...(snapshot?.nodes ?? []), ...run.expansions.flatMap((entry) => entry.nodes ?? [])])
    for (const [nodeId, state] of Object.entries(run.nodes)) {
      const nodeEvents = events.filter((e) => e.nodeId === nodeId)
      if (!nodeEvents.some((e) => e.type === 'node.started')) continue
      const recipes = nodeEvents.filter((e) => e.type === 'node.recipe')
      // 一个 run/node 只作为一次成绩；review 多角色配方在配方/技能视角分别展开。
      const identities = recipes.length ? [...new Map(recipes.map(event => [(event.data as NodeRecipe).recipeKey, event])).values()] : [undefined]
      const firstFinish = nodeEvents.find((e) => e.type === 'node.finished')?.data as EventPayloads['node.finished'] | undefined
      const firstFailure = nodeEvents.find((e) => e.type === 'node.failed')
      const firstChecks = nodeEvents.find((e) => e.type === 'node.checks')?.data as EventPayloads['node.checks'] | undefined
      const definition = definitions.find((node) => node.id === nodeId)
      for (const event of identities) samples.push({ kind: definition?.kind, run, nodeId, recipe: event?.data as NodeRecipe | undefined, firstAt: event?.ts ?? state.startedAt ?? run.startedAt,
        events: nodeEvents, pass: firstFinish?.status === 'succeeded' && !firstFailure && state.attempts === 1 && !(state.reworks ?? 0)
          && (!definition?.completion?.length || !!firstChecks && !firstChecks.unmet.length && firstChecks.checks.length === definition.completion.length),
        artifacts, rounds: 0, reworks: 0, issues: emptyIssues(), edits: { cosmetic: 0, semantic: 0 }, editedPaths: new Set(), downstream: {}, escapes: new Set(), missed: new Set(), caught: new Set(),
        detector: definition?.kind === 'review' || definition?.kind === 'gate',
      })
    }
  }
  const reviewProducers = new Set(samples.filter((sample) => sample.kind === 'review').map((sample) => `${sample.run.runId}:${sample.nodeId}`))
  const affected = (runId: string, nodeId: string) => samples.filter((sample) => sample.run.runId === runId && sample.nodeId === nodeId)
  for (const req of [...new Set(runs.map((run) => run.requirementId))]) {
    const rounds = await readReviewRounds({ store: stores.workspaces, requirementId: req }, new Set(runs.filter((run) => run.requirementId === req).map((run) => run.runId)))
    const artifacts = await stores.workspaces.listArtifacts(req)
    for (const entry of rounds) {
      const producers = new Map<string, { runId: string; nodeId: string }>()
      for (const record of entry.round.records) for (const ref of record.artifacts) {
        const source = producer(artifacts, ref.path, ref.version, reviewProducers)
        if (source) producers.set(`${source.runId}:${source.nodeId}`, source)
      }
      for (const source of producers.values()) for (const sample of affected(source.runId, source.nodeId)) {
        sample.rounds++; if (!entry.round.passed) sample.reworks++
        for (const record of entry.round.records) for (const issue of record.issues) sample.issues[issue.severity]++
      }
    }
    const defects = stores.quality ? await stores.quality.defects(req) : await listDefects(stores, req)
    const observations: Observation[] = stores.quality ? await stores.quality.observations({ requirementId: req }) : []
    const checkpointSamples = (runId: string, nodeId: string, checkpointId: string) => affected(runId, nodeId).filter(sample => {
      if (options.by === 'node' || !sample.recipe) return true
      // 多评审者节点按实际调用配方归属，不能把甲的检出计到乙的技能上。
      return sample.events.some(event => event.type === 'invocation.started'
        && (event.data as EventPayloads['invocation.started']).checkpointId === checkpointId
        && (event.data as EventPayloads['invocation.started']).recipeKey === sample.recipe!.recipeKey)
    })
    for (const defect of defects) {
      const attr = defect.attribution, identity = `${req}/${defect.id}`
      const valid = defect.validity === 'valid'
      if (valid) for (const observation of observations) {
        if (observation.kind !== 'finding' || !observation.checkpointId || !observation.runId || !observation.nodeId
          || !defect.observations?.includes(observation.id)) continue
        for (const sample of checkpointSamples(observation.runId, observation.nodeId, observation.checkpointId)) {
          sample.caught.add(`${observation.runId}/${observation.checkpointId}`); sample.detector = true
        }
      }
      if (!attr) continue
      for (const point of attr.checkpoints ?? []) {
        if (!valid || point.verdict !== 'should_have_caught' || point.confirmed?.by.type !== 'human') continue
        if (![point.conditions.existed, point.conditions.materialProvided, point.conditions.inDuty, point.conditions.executed, point.conditions.notRaised].every(value => value === true)) continue
        for (const sample of checkpointSamples(point.runId, point.nodeId, point.checkpointId)) {
          sample.missed.add(`${point.runId}/${point.checkpointId}`); sample.detector = true
        }
      }
      // M3 引入归因仍可展示和统计逃逸；旧 missedBy 不再充当五条件漏检证据。
      if (defect.status !== 'confirmed' || !attr.confirmed || (defect.validity !== undefined && !valid)) continue
      const source = attr.introducedAt
      if (source.nodeId) for (const sample of samples.filter(sample => sample.run.requirementId === req && sample.nodeId === source.nodeId
        && (!source.runId || sample.run.runId === source.runId))) sample.escapes.add(identity)
    }
    const seenEdits = new Set<string>()
    for (const run of runs.filter((item) => item.requirementId === req)) for (const event of await stores.events.read(run.runId)) {
      if (event.type === 'artifact.edited' && event.actor.type === 'human') {
        const edit = event.data as EventPayloads['artifact.edited'], identity = canonicalJson(edit.ref)
        if (seenEdits.has(identity)) continue
        seenEdits.add(identity)
        const source = producer(artifacts, edit.ref.path, (edit.ref.version ?? Infinity) - 1, reviewProducers)
        if (source) for (const sample of affected(source.runId, source.nodeId)) { sample.edits[edit.impact ?? 'semantic']++; sample.editedPaths.add(edit.ref.path) }
      }
      if (event.type !== 'judge.verdict') continue
      for (const verdict of (event.data as EventPayloads['judge.verdict']).verdicts) {
        const kind: Partial<Record<VerdictCategory, string>> = { case_defect: 'case', script_defect: 'script', product_bug: 'code-change', requirement_gap: 'spec' }
        const wanted = kind[verdict.category]
        if (!wanted) continue
        const linked = artifacts.filter((artifact) => artifact.traceIds.includes(verdict.subject) || verdict.evidence.some((path) => path.includes(artifact.path)))
        const seen = new Set<string>(), sources = new Map<string, { runId: string; nodeId: string }>()
        const visit = (artifact: ArtifactRecord) => {
          if (seen.has(artifact.path)) return
          seen.add(artifact.path)
          if (artifact.kind === wanted) {
            const source = producer(artifacts, artifact.path, undefined, reviewProducers)
            if (source) sources.set(`${source.runId}:${source.nodeId}`, source)
          }
          for (const child of artifacts) {
            const related = child.versions.at(-1)?.derivedFrom.some((ref) => ref.workspace === req && ref.path === artifact.path)
            const sharedAc = artifact.traceIds.some((id) => /^AC-/.test(id) && child.traceIds.includes(id))
            if (related || sharedAc) visit(child)
          }
          for (const ref of artifact.versions.at(-1)?.derivedFrom ?? []) {
            const parent = artifacts.find((item) => ref.workspace === req && item.path === ref.path)
            if (parent) visit(parent)
          }
        }
        linked.forEach(visit)
        for (const source of sources.values()) for (const sample of affected(source.runId, source.nodeId)) sample.downstream[verdict.category] = (sample.downstream[verdict.category] ?? 0) + 1
      }
    }
  }
  const groups = new Map<string, { key: NodeScorecard['key']; samples: Sample[] }>()
  for (const sample of samples) {
    const keys: NodeScorecard['key'][] = options.by === 'node' ? [{ by: 'node', workflowId: sample.run.workflowId, nodeId: sample.nodeId }]
      : options.by === 'recipe' ? sample.recipe ? [{ by: 'recipe', workflowId: sample.run.workflowId, nodeId: sample.nodeId, recipeKey: sample.recipe.recipeKey }] : []
        : (sample.recipe?.skills ?? []).map((skill) => ({ by: 'skill', skill }))
    for (const key of keys) {
      const identity = canonicalJson(key), group = groups.get(identity) ?? { key, samples: [] }
      const existing = group.samples.find(item => item.run.runId === sample.run.runId && item.nodeId === sample.nodeId)
      if (!existing) group.samples.push({ ...sample, caught: new Set(sample.caught), missed: new Set(sample.missed) })
      else {
        for (const point of sample.caught) existing.caught.add(point)
        for (const point of sample.missed) existing.missed.add(point)
        existing.detector ||= sample.detector
      }
      groups.set(identity, group)
    }
  }
  const cards: NodeScorecard[] = []
  for (const { key, samples: rows } of groups.values()) {
    const card: NodeScorecard = { key, label: key.skill ? `${key.skill.name}@${key.skill.hash?.slice(0, 8)}` : `${key.workflowId}/${key.nodeId}${key.recipeKey ? `@${key.recipeKey}` : ''}`,
      role: rows[0]?.recipe?.role, executions: rows.length, firstPassRate: rows.filter((row) => row.pass).length / rows.length,
      review: { roundsAvg: rows.reduce((sum, row) => sum + row.rounds, 0) / rows.length, reworks: 0, issues: emptyIssues() }, humanEdits: { cosmetic: 0, semantic: 0, rate: undefined },
      completionUnmet: 0, suppressed: 0, downstream: {}, escapes: new Set(rows.flatMap((row) => [...row.escapes])).size, usage: { inputTokens: 0, outputTokens: 0 }, trend: [],
    }
    const producedPaths = new Set(rows.flatMap((row) => row.artifacts.filter((artifact) => artifact.versions.some((version) => version.producedBy?.runId === row.run.runId && version.producedBy.nodeId === row.nodeId)).map((artifact) => `${row.run.requirementId}:${artifact.path}`)))
    const editedPaths = new Set(rows.flatMap((row) => [...row.editedPaths].map((path) => `${row.run.requirementId}:${path}`)))
    card.humanEdits.rate = producedPaths.size ? editedPaths.size / producedPaths.size : undefined
    const trends = new Map<string, Sample[]>()
    for (const row of rows) {
      card.review.reworks += row.reworks
      for (const severity of Object.keys(row.issues) as Array<keyof typeof row.issues>) card.review.issues[severity] += row.issues[severity]
      card.humanEdits.cosmetic += row.edits.cosmetic; card.humanEdits.semantic += row.edits.semantic
      card.completionUnmet += row.events.filter((event) => event.type === 'node.checks' && (event.data as EventPayloads['node.checks']).unmet.length).length
      card.suppressed += row.events.filter((event) => event.type === 'retry.suppressed').length
      for (const [category, count] of Object.entries(row.downstream)) card.downstream[category as VerdictCategory] = (card.downstream[category as VerdictCategory] ?? 0) + count!
      card.usage = addUsage(card.usage, summarizeUsage(row.events))
      if (row.recipe) trends.set(row.recipe.recipeKey, [...(trends.get(row.recipe.recipeKey) ?? []), row])
    }
    card.durationMsAvg = rows.reduce((sum, row) => { const state = row.run.nodes[row.nodeId]!; return sum + (state.startedAt && state.endedAt ? Math.max(0, Date.parse(state.endedAt) - Date.parse(state.startedAt)) : 0) }, 0) / rows.length
    if (rows.some((row) => row.detector)) {
      const caught = new Set(rows.flatMap(row => [...row.caught])).size, missed = new Set(rows.flatMap(row => [...row.missed])).size
      card.detection = { caught, missed, rate: caught + missed ? caught / (caught + missed) : undefined }
    }
    card.trend = [...trends].map(([recipeKey, group]) => ({ recipeKey, firstAt: group.map((row) => row.firstAt).sort()[0]!, executions: group.length, firstPassRate: group.filter((row) => row.pass).length / group.length })).sort((a, b) => a.firstAt.localeCompare(b.firstAt))
    const latest = card.trend.at(-1), previous = card.trend.at(-2)
    if (latest && previous) {
      const escaped = (recipe: string) => new Set(trends.get(recipe)!.flatMap((row) => [...row.escapes])).size
      const worse = latest.executions >= 3 && (previous.firstPassRate ?? 0) - (latest.firstPassRate ?? 0) > 0.2
      const escapeGrowth = escaped(latest.recipeKey) > escaped(previous.recipeKey)
      card.regression = { suspected: worse || escapeGrowth, reason: worse ? '最近配方的一次通过率下降超过 20 个百分点' : escapeGrowth ? '最近配方确认的逃逸缺陷增加' : undefined }
    }
    cards.push(card)
  }
  // 技能按内容版本分行，退化比较需要跨相邻版本。
  if (options.by === 'skill') for (const name of new Set(cards.map((card) => card.key.skill!.name))) {
    const versions = cards.filter((card) => card.key.skill!.name === name).sort((a, b) => (a.trend?.[0]?.firstAt ?? '').localeCompare(b.trend?.[0]?.firstAt ?? ''))
    for (let i = 1; i < versions.length; i++) {
      const current = versions[i]!, previous = versions[i - 1]!
      const suspected = current.executions >= 3 && (previous.firstPassRate ?? 0) - (current.firstPassRate ?? 0) > 0.2 || current.escapes > previous.escapes
      current.regression = { suspected, reason: suspected ? '技能新版本的一次通过率下降或逃逸缺陷增加' : undefined }
    }
  }
  if (options.by === 'recipe') for (const node of new Set(cards.map((card) => `${card.key.workflowId}/${card.key.nodeId}`))) {
    const versions = cards.filter((card) => `${card.key.workflowId}/${card.key.nodeId}` === node).sort((a, b) => (a.trend?.[0]?.firstAt ?? '').localeCompare(b.trend?.[0]?.firstAt ?? ''))
    for (let i = 1; i < versions.length; i++) {
      const current = versions[i]!, previous = versions[i - 1]!
      const suspected = current.executions >= 3 && (previous.firstPassRate ?? 0) - (current.firstPassRate ?? 0) > 0.2 || current.escapes > previous.escapes
      current.regression = { suspected, reason: suspected ? '新配方的一次通过率下降或逃逸缺陷增加' : undefined }
    }
  }
  return cards.sort((a, b) => a.label.localeCompare(b.label))
}
