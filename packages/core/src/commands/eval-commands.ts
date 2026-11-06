import type { EngineDeps } from '../interfaces.js'
import type { DefectConfirmRequest, DefectReportRequest, EvalCollectRequest, EvalRunRequest } from '../api.js'
import type { CommandSpec } from './contracts.js'
import { scorecards, type ScorecardOptions } from '../eval/scorecards.js'
import { collectCases } from '../eval/cases.js'
import { runEval } from '../eval/runner.js'
import { confirmDefect, reportDefect, startDefectAttribution } from '../defects/index.js'
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
    define('defect.report', '录入逃逸缺陷', objectSchema({ requirementId: text, title: text, description: text, severity: { type: 'string', enum: ['critical', 'major', 'minor'] }, acs: strings, evidence: strings, links: { type: 'array' } }, ['requirementId', 'title', 'description', 'severity']),
      async (input, context) => reportDefect(deps.stores, input.requirementId as string, input as unknown as DefectReportRequest, context.actor)),
    define('defect.attribute', '生成候选归因', objectSchema({ requirementId: text, defectId: text }, ['requirementId', 'defectId']),
      async (input) => startDefectAttribution(deps, input.requirementId as string, input.defectId as string)),
    define('defect.confirm', '人工确认归因', objectSchema({ requirementId: text, defectId: text, attribution: { type: 'object' }, note: text }, ['requirementId', 'defectId']),
      async (input, context) => confirmDefect(deps.stores, input.requirementId as string, input.defectId as string, { ...input as DefectConfirmRequest, note: input.note as string | undefined ?? context.reason }, context.actor)),
    define('eval.collect', '收集评测用例', objectSchema({ target, runIds: strings, includeDefects: { type: 'boolean' } }),
      async (input) => collectCases(deps.stores, input as EvalCollectRequest)),
    define('eval.run', '启动回放评测', objectSchema({ target, caseIds: strings, judge: selector, variants: { type: 'array', items: objectSchema({ id: text, label: text, skillsDir: text, promptFile: text, profileFile: text, harness: selector }, ['id', 'label']) } }, ['target', 'variants']),
      async (input, context) => runEval(deps, input as unknown as EvalRunRequest, context.actor)),
  ]
}
