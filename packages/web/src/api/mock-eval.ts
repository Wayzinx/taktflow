import type { DataSource } from './source'
import { createMockDefects } from './mock-defects'
import { seedRegressionCases } from './mock-defects'
import { mockScorecards, scorecardNodeOf, type ScorecardAdjust } from './mock-eval-scorecards'
import { compare, outputOf, seedCases, seedRuns, startRun, targetKey } from './mock-eval-runs'

export { mockRecipe } from './mock-eval-scorecards'

type EvalApi = Pick<DataSource, 'scorecards' | 'evalCases' | 'collectEvalCases' | 'evalRuns' | 'evalRun' | 'startEvalRun' | 'evalOutput' | 'defects' | 'reportDefect' | 'attributeDefect' | 'confirmDefect'>

/**
 * 评测与归因的演示数据（docs/dev/m3-eval.md「m3-web-eval」）。
 * 成绩单见 mock-eval-scorecards.ts，用例与运行见 mock-eval-runs.ts，缺陷见 mock-defects.ts。
 * seeded 为 false（空空间）时全部为空。
 */
export function createMockEval(seeded: boolean, latestRunOf: (reqId: string) => string | undefined): EvalApi {
  const clone = <T,>(v: T): T => structuredClone(v)
  const delay = <T,>(v: T, ms = 110): Promise<T> => new Promise((r) => setTimeout(() => r(clone(v)), ms))
  const fail = (msg: string) => Promise.reject(new Error(msg))
  const cases = seeded ? [...seedCases(), ...seedRegressionCases()] : []
  const runs = seeded ? seedRuns(cases) : []
  const defects = createMockDefects(seeded)
  const adj: ScorecardAdjust = { escapes: new Map(), missed: new Map() }
  const bump = (m: Map<string, number>, node?: string) => {
    const k = node && scorecardNodeOf(node)
    if (k) m.set(k, (m.get(k) ?? 0) + 1)
  }

  return {
    scorecards: (by, workflowId) => delay(seeded && (!workflowId || workflowId === 'sdlc') ? mockScorecards(by, adj) : [], 140),
    evalCases: (target) => delay(target ? cases.filter((c) => targetKey(c.target) === target) : cases, 90),
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
      if (r.status === 'done' && !r.comparison) r.comparison = compare(r, cases)
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
  }
}
