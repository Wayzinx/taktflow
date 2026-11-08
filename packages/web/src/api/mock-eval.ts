import type { EvalCase } from '@taktflow/core'
import type { DataSource } from './source'
import { RevisionConflictError } from './source-m5'
import { createMockDefects } from './mock-defects'
import { seedRegressionCases } from './mock-defects'
import { mockScorecards, scorecardNodeOf, type ScorecardAdjust } from './mock-eval-scorecards'
import { compare, outputOf, seedCases, seedRuns, startRun, targetKey } from './mock-eval-runs'
import { seedReportRuns, seedSamples } from './mock-eval-samples'

export { mockRecipe } from './mock-eval-scorecards'

type EvalApi = Pick<
  DataSource,
  | 'scorecards' | 'evalCases' | 'collectEvalCases' | 'evalRuns' | 'evalRun' | 'startEvalRun' | 'evalOutput' | 'defects' | 'reportDefect' | 'attributeDefect' | 'confirmDefect'
  | 'observations' | 'updateDefect' | 'mergeSuggestions' | 'decideMerge' | 'decideMiss' | 'createEvalSample' | 'retireEvalSample'
>

/**
 * 评测与归因的演示数据（docs/dev/m3-eval.md「m3-web-eval」）。
 * 成绩单见 mock-eval-scorecards.ts，用例与运行见 mock-eval-runs.ts，缺陷见 mock-defects.ts。
 * seeded 为 false（空空间）时全部为空。
 */
export function createMockEval(seeded: boolean, latestRunOf: (reqId: string) => string | undefined): EvalApi {
  const clone = <T,>(v: T): T => structuredClone(v)
  const delay = <T,>(v: T, ms = 110): Promise<T> => new Promise((r) => setTimeout(() => r(clone(v)), ms))
  const fail = (msg: string) => Promise.reject(new Error(msg))
  const later = (e: Error) => new Promise<never>((_, rej) => setTimeout(() => rej(e), 260))
  const cases = seeded ? [...seedCases(), ...seedRegressionCases(), ...seedSamples()] : []
  const runs = seeded ? [...seedReportRuns(cases.filter((c) => c.sample), (r) => compare(r, cases)), ...seedRuns(cases)] : []
  const defects = createMockDefects(seeded)
  const adj: ScorecardAdjust = { escapes: new Map(), missed: new Map() }
  const bump = (m: Map<string, number>, node?: string) => {
    const k = node && scorecardNodeOf(node)
    if (k) m.set(k, (m.get(k) ?? 0) + 1)
  }

  return {
    scorecards: (by, workflowId) => delay(seeded && (!workflowId || workflowId === 'sdlc') ? mockScorecards(by, adj) : [], 140),
    // 与后端同口径：默认不含已退役样本
    evalCases: (target, opts) => delay(cases.filter((c) => (!target || targetKey(c.target) === target) && (opts?.retired || !c.sample?.retiredAt)), 90),
    collectEvalCases(body) {
      // 演示：已确认缺陷的回归用例在确认时就已生成，这里只补一条历史用例
      // 不给目标时真实接口收集全部目标；演示只补到第一个已有用例的目标上
      const t = body.target ?? cases[0]?.target
      if (!t) return delay({ added: [] as string[] }, 300)
      const id = `EC-col-${String(cases.length + 1).padStart(3, '0')}`
      cases.push({ ...clone(cases.find((c) => targetKey(c.target) === targetKey(t)) ?? cases[0]!), id, target: t, title: '收集：评审打回后通过的版本', source: { kind: 'history' }, createdAt: new Date().toISOString() })
      return delay({ added: [id] }, 300)
    },
    evalRuns: () => delay(runs.map((r) => ({ ...r, results: [] })), 100),
    evalRun(id) {
      const r = runs.find((x) => x.id === id)
      if (!r) return fail(`评测运行 ${id} 不存在`)
      if (r.status === 'done' && !r.comparison && !r.report) r.comparison = compare(r, cases)
      return delay(r, 90)
    },
    startEvalRun(body) {
      const r = startRun(runs, cases, body)
      return typeof r === 'string' ? fail(r) : delay(r, 200)
    },
    evalOutput(runId, caseId, variant) {
      const r = runs.find((x) => x.id === runId)
      return r ? delay(outputOf(r, caseId, variant), 120) : fail(`评测运行 ${runId} 不存在`)
    },
    defects: (reqId) => delay(defects.list(reqId), 100),
    reportDefect(reqId, body) {
      const d = defects.report(reqId, body)
      return typeof d === 'string' ? fail(d) : delay(d, 180)
    },
    attributeDefect(reqId, id) {
      const d = defects.attribute(reqId, id, latestRunOf(reqId))
      return typeof d === 'string' ? fail(d) : delay(d, 160)
    },
    confirmDefect(reqId, id, body) {
      const r = defects.confirm(reqId, id, body)
      if (typeof r === 'string') return fail(r)
      const a = r.defect.attribution!
      bump(adj.escapes, a.introducedAt.nodeId)
      for (const m of a.missedBy) bump(adj.missed, m.nodeId)
      for (const c of r.cases) if (!cases.some((x) => x.id === c.id)) cases.push(c)
      return delay(r.defect, 220)
    },
    // M5 缺陷两层、合并建议、逐检查点改判与样本（docs/design/21 §4、§6）
    observations: (reqId, opts) => delay(defects.observations(reqId, opts), 90),
    updateDefect(reqId, id, body) {
      const r = defects.update(reqId, id, body)
      return typeof r === 'string' ? fail(r) : 'conflict' in r ? later(new RevisionConflictError(r.conflict)) : delay(r, 180)
    },
    mergeSuggestions: (reqId) => delay(defects.mergeSuggestions(reqId), 90),
    decideMerge(reqId, sid, body) {
      const r = defects.decideMerge(reqId, sid, body)
      return typeof r === 'string' ? fail(r) : delay(r, 180)
    },
    decideMiss(reqId, id, checkpointId, body) {
      const r = defects.decideMiss(reqId, id, checkpointId, body)
      return typeof r === 'string' ? fail(r) : 'conflict' in r ? later(new RevisionConflictError(r.conflict)) : delay(r, 180)
    },
    createEvalSample(body) {
      if (!body.reason.trim()) return fail('需要写原因')
      const [runId, nodeId] = body.checkpointId.split(':')
      if (!runId || !nodeId) return fail(`检查点 ${body.checkpointId} 不存在`)
      if (body.kind === 'must_catch') {
        const d = body.defectId ? defects.find(body.defectId) : undefined
        const a = d?.attribution?.checkpoints?.find((x) => x.checkpointId === body.checkpointId)
        if (!d || !a) return fail('must_catch 样本要从缺陷的检查点结论生成')
        const all5 = (['existed', 'materialProvided', 'inDuty', 'executed', 'notRaised'] as const).every((k) => a.conditions[k] === true)
        if (d.validity !== 'valid' || a.verdict !== 'should_have_caught' || a.by !== 'human' || !a.confirmed || !all5) return fail('缺少人确认的漏检五条件；请先确认归因')
        if (body.baseRevision !== undefined && body.baseRevision !== (d.revision ?? 1)) return later(new RevisionConflictError(`${d.id} 刚被别人改过，请载入最新后再生成`))
      }
      if (cases.some((c) => c.sample?.checkpointId === body.checkpointId && c.sample.kind === body.kind && !c.sample.retiredAt)) return fail('这个检查点已经有同类样本了')
      const subject = body.checkpointId.split(':').at(-1) ?? 'reviewer'
      const c: EvalCase = {
        id: `S-${String(cases.filter((x) => x.sample).length + 1).padStart(3, '0')}`,
        // 与后端同口径：目标是检查点所在节点，标题取缺陷标题或"无缺陷评审"
        target: { kind: 'node', workflowId: 'sdlc', nodeId },
        title: body.kind === 'must_catch' ? (body.defectId && defects.find(body.defectId)?.title) || body.expectIssue || nodeId : `无缺陷评审：${subject}`,
        source: { kind: body.kind === 'must_catch' ? 'defect' : 'manual', runId, nodeId, defectId: body.defectId },
        node: { id: nodeId, kind: 'review', title: nodeId, needs: [] },
        inputs: [],
        grading: body.kind === 'must_catch' ? { mustFind: [body.expectIssue ?? ''] } : { checks: ['不提出 blocker / major'] },
        createdAt: new Date().toISOString(),
        sample: { kind: body.kind, checkpointId: body.checkpointId, snapshot: `snapshots/${runId}/${nodeId.replace(/\//g, '-')}-${subject}`, expectIssue: body.expectIssue },
      }
      cases.push(c)
      return delay(c, 220)
    },
    retireEvalSample(caseId, reason) {
      const c = cases.find((x) => x.id === caseId)
      if (!c?.sample) return fail(`样本 ${caseId} 不存在`)
      if (!reason.trim()) return fail('退役需要写原因')
      if (c.sample.retiredAt) return fail('已经退役了')
      c.sample.retiredAt = new Date().toISOString()
      return delay(c, 160)
    },
  }
}
