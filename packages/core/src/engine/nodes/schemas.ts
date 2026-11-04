import type { JudgeVerdict } from '../../types.js'

const objectSchema = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required })
export const RUBRIC_SCHEMA = objectSchema({ score: { type: 'number' }, pass: { type: 'boolean' }, message: { type: 'string' } })
export const PLANNER_SCHEMA = objectSchema({ items: { type: 'array', items: objectSchema({
            key: { type: 'string' }, title: { type: 'string' }, role: { type: 'string' },
            dependsOn: { type: 'array', items: { type: 'string' } }, params: { type: 'object' },
          }, ['key', 'title']) } })
export const JUDGE_SCHEMA = objectSchema({ verdicts: {
        type: 'array', items: objectSchema({ subject: { type: 'string' }, category: { type: 'string', enum: ['product_bug', 'case_defect', 'script_defect', 'env_issue', 'flaky', 'requirement_gap', 'unknown'] },
          confidence: { type: 'number' }, rationale: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } },
          fixScope: { type: 'string', enum: ['mechanical', 'semantic'] }, fixHint: { type: 'string' },
        }, ['subject', 'category', 'confidence', 'rationale', 'evidence']),
      } })

export function assertVerdictsCover(failures: Array<{ subject: string }>, verdicts: JudgeVerdict[]): void {
  const subjects = new Set(failures.map((failure) => failure.subject))
  if (subjects.size !== failures.length || verdicts.length !== failures.length || new Set(verdicts.map((v) => v.subject)).size !== failures.length || verdicts.some((v) => !subjects.has(v.subject))) {
    throw new Error('judge 判决没有逐项覆盖失败 subject')
  }
}
