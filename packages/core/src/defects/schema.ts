const string = { type: 'string' }
const strings = { type: 'array', items: string }
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required })
export const attributionSchema = object({
  introducedAt: object({ origin: { type: 'string', enum: ['requirement', 'design', 'implementation', 'test_design', 'automation', 'environment', 'external', 'unknown'] },
    runId: string, nodeId: string, artifact: object({ workspace: string, path: string, version: { type: 'integer' } }, ['workspace', 'path', 'version']), evidence: strings }, ['origin', 'evidence']),
  missedBy: { type: 'array', items: object({ runId: string, nodeId: string, reason: { type: 'string', enum: ['not_covered', 'wrong_assertion', 'reviewed_but_missed', 'gate_absent', 'judge_misclassified', 'evidence_stale', 'other'] }, evidence: strings }, ['nodeId', 'reason', 'evidence']) },
  confidence: { type: 'number' }, suggestions: { type: 'array', items: object({ target: object({ kind: { type: 'string', enum: ['skill', 'prompt', 'completion', 'review_focus', 'gate_check', 'lesson', 'knowledge'] }, ref: string }), change: string }) },
})
