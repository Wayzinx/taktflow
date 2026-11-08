import type { EngineDeps } from '../interfaces.js'
import type { DefectConfirmRequest, DefectReportRequest, DefectUpdateRequest, MissDecisionRequest, EvalSampleRequest, EvalCollectRequest, EvalRunRequest } from '../api.js'
import type { CommandSpec } from './contracts.js'
import { scorecards, type ScorecardOptions } from '../eval/scorecards.js'
import { collectCases } from '../eval/cases.js'
import { runEval } from '../eval/runner.js'
import { confirmDefect, startDefectAttribution } from '../defects/index.js'
import { createQualityDefect, readQualityDefect, updateQualityDefect, suggestDefectMerges, decideDefectMerge, decideCheckpointMiss } from '../defects/attribution.js'
import { addEvalSample, retireEvalSample } from '../eval/samples.js'
import { evalRevision } from '../eval/quality-access.js'
import { syncQuality, qualityStatus, repairQuality } from '../quality/index.js'
import { tickAttention } from '../attention/timebox.js'
import { objectSchema } from './schema.js'

const text = { type: 'string' }, strings = { type: 'array', items: text }
const target = objectSchema({ kind: { type: 'string', enum: ['node', 'skill'] }, name: text, workflowId: text, nodeId: text }, ['kind'])
const selector = objectSchema({ harness: text, model: text, effort: text }, ['harness'])
export function evalCommandSpecs(deps: EngineDeps): CommandSpec[] {
  const define = (id: string, title: string, input: Record<string, unknown>, handler: CommandSpec['handler'], read = false): CommandSpec =>
    ({ id, title, kind: read ? 'query' : 'command', risk: read ? 'read' : 'write', minRole: read ? 'viewer' : 'member', input, handler })
  return [
    define('eval.scorecards', '查询评测成绩单', objectSchema({ by: { type: 'string', enum: ['node', 'recipe', 'skill'] }, workflowId: text }),
      async (input) => scorecards(deps.stores, { by: (input.by as ScorecardOptions['by']) ?? 'node', workflowId: input.workflowId as string | undefined }), true),
    define('defect.report', '录入逃逸缺陷', objectSchema({ requirementId: text, title: text, description: text, severity: { type: 'string', enum: ['critical', 'major', 'minor'] }, observations: strings, acs: strings, evidence: strings, links: { type: 'array' } }, ['requirementId', 'title', 'description', 'severity']),
      async (input, context) => {
        const result = await createQualityDefect(deps.stores, input.requirementId as string, { ...input as unknown as DefectReportRequest, reason: context.reason }, context.actor)
        await suggestDefectMerges(deps.stores, result.requirementId, context.actor, context.reason!)
        return result
      }),
    define('defect.attribute', '生成候选归因', objectSchema({ requirementId: text, defectId: text, baseRevision: { type: 'integer', minimum: 1 } }, ['requirementId', 'defectId']),
      async (input, context) => {
        const current = await readQualityDefect(deps.stores, input.requirementId as string, input.defectId as string)
        return startDefectAttribution(deps, current.requirementId, current.id, { baseRevision: input.baseRevision as number ?? current.revision!, reason: context.reason! })
      }),
    define('defect.confirm', '人工确认归因', objectSchema({ requirementId: text, defectId: text, attribution: { type: 'object' }, note: text }, ['requirementId', 'defectId']),
      async (input, context) => confirmDefect(deps.stores, input.requirementId as string, input.defectId as string, { ...input as DefectConfirmRequest, note: input.note as string | undefined ?? context.reason }, context.actor)),
    define('defect.observations', '查询观察', objectSchema({ requirementId: text, source: text, runId: text }, ['requirementId']),
      async input => deps.stores.quality!.observations(input as { requirementId: string }), true),
    define('defect.update', '更新缺陷', objectSchema({ requirementId: text, defectId: text, baseRevision: { type: 'integer', minimum: 1 }, validity: text, resolution: text, duplicateOf: text }, ['requirementId', 'defectId', 'baseRevision']),
      async (input, ctx) => updateQualityDefect(deps.stores, input.requirementId as string, input.defectId as string, { ...input, reason: ctx.reason } as unknown as DefectUpdateRequest, ctx.actor)),
    define('defect.suggest-merges', '生成合并建议', objectSchema({ requirementId: text }, ['requirementId']),
      async (input, ctx) => suggestDefectMerges(deps.stores, input.requirementId as string, ctx.actor, ctx.reason!)),
    define('defect.merge', '决定合并建议', objectSchema({ requirementId: text, suggestionId: text, decision: { type: 'string', enum: ['accept', 'reject', 'undo'] }, baseRevision: { type: 'integer', minimum: 1 } }, ['requirementId', 'suggestionId', 'decision']),
      async (input, ctx) => {
        const req = input.requirementId as string, sid = input.suggestionId as string
        const suggestion = (await deps.stores.quality!.mergeSuggestions(req)).find(s => s.id === sid)
        if (!suggestion) throw new Error('合并建议不存在；请刷新后重试')
        const current = await readQualityDefect(deps.stores, req, suggestion.defects[0]!)
        return decideDefectMerge(deps.stores, req, sid, { action: input.decision as 'accept' | 'reject' | 'undo', baseRevision: input.baseRevision as number ?? current.revision!, reason: ctx.reason! }, ctx.actor)
      }),
    define('defect.miss', '人工改判检查点', objectSchema({ requirementId: text, defectId: text, checkpointId: text, verdict: text, conditions: { type: 'object' }, note: text, baseRevision: { type: 'integer', minimum: 1 } }, ['requirementId', 'defectId', 'checkpointId', 'verdict']),
      async (input, ctx) => {
        const current = await readQualityDefect(deps.stores, input.requirementId as string, input.defectId as string)
        return decideCheckpointMiss(deps.stores, current.requirementId, current.id, input.checkpointId as string, input as unknown as MissDecisionRequest, ctx.actor,
          { baseRevision: input.baseRevision as number ?? current.revision!, reason: ctx.reason! })
      }),
    define('eval.sample', '人工确认评测样本', objectSchema({ kind: { type: 'string', enum: ['clean', 'must_catch'] }, checkpointId: text, defectId: text, expectIssue: text, baseRevision: { type: 'integer', minimum: 1 } }, ['kind', 'checkpointId']),
      async (input, ctx) => addEvalSample(deps.stores, { ...input, reason: ctx.reason } as unknown as EvalSampleRequest, ctx.actor)),
    define('eval.retire', '退役评测样本', objectSchema({ caseId: text, baseRevision: text }, ['caseId']),
      async (input, ctx) => {
        const sample = (await deps.stores.quality!.samples()).find(s => s.id === input.caseId)
        if (!sample) throw new Error('样本不存在；请刷新后重试')
        await retireEvalSample(deps.stores, sample.id, ctx.actor, ctx.reason!, input.baseRevision as string ?? evalRevision(sample))
        return (await deps.stores.quality!.samples()).find(s => s.id === sample.id)!
      }),
    define('quality.sync', '补算质量日志', objectSchema({ runId: text }), async (input) => { await syncQuality(deps.stores, input.runId as string | undefined); return qualityStatus(deps.stores) }),
    define('quality.verify', '验证质量日志', objectSchema({}), async () => qualityStatus(deps.stores), true),
    define('quality.repair', '修复质量锚点', objectSchema({}), async (_, ctx) => repairQuality(deps.stores, ctx.actor, ctx.reason!)),
    define('attention.tick', '检查待办时限', objectSchema({}), async () => tickAttention(deps.stores)),
    define('eval.collect', '收集评测用例', objectSchema({ target, runIds: strings, includeDefects: { type: 'boolean' } }),
      async (input) => collectCases(deps.stores, input as EvalCollectRequest)),
    define('eval.run', '启动回放评测', objectSchema({ target, caseIds: strings, repeats: { type: 'integer', minimum: 1 }, judge: selector, variants: { type: 'array', items: objectSchema({ id: text, label: text, skillsDir: text, promptFile: text, profileFile: text, harness: selector }, ['id', 'label']) } }, ['target', 'variants']),
      async (input, context) => runEval(deps, { ...input, reason: context.reason } as unknown as EvalRunRequest, context.actor)),
  ]
}
