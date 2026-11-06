import type { LeadAction } from '../types.js'
import { budgetSchema, taskSchema } from '../commands/schema.js'
import { validateSchema } from '../engine/schema.js'

const text = { type: 'string' }
const strings = { type: 'array', items: text }
export const actionSchemas: Record<LeadAction['type'], Record<string, unknown>> = {
  reply: { required: ['text'], properties: { text, mentions: strings } },
  dispatch_task: { required: ['task'], properties: { task: taskSchema } },
  start_run: { required: ['workflowId'], properties: { workflowId: text, args: { type: 'object' }, budget: budgetSchema } },
  resume_run: { required: ['runId'], properties: { runId: text } },
  cancel_run: { required: ['runId', 'reason'], properties: { runId: text, reason: text } },
  request_human: { required: ['to', 'ask', 'form'], properties: { to: text, ask: text, form: { type: 'string', enum: ['approve', 'answer', 'choice'] }, choices: strings } },
  propose_workflow_change: { required: ['workflowId', 'description'], properties: { workflowId: text, description: text, source: text } },
  update_notes: { required: ['content'], properties: { content: text } },
  command: { required: ['id'], properties: { id: text, input: { type: 'object' } } },
}
export const LEAD_TURN_SCHEMA: Record<string, unknown> = {
  title: 'LeadTurn', type: 'object', required: ['reply', 'actions'],
  properties: { reply: text, actions: { type: 'array', items: { type: 'object', required: ['type'], properties: { type: text } } } },
}

export function validateAction(value: unknown): asserts value is LeadAction {
  if (!value || typeof value !== 'object' || !('type' in value) || typeof value.type !== 'string' || !Object.hasOwn(actionSchemas, value.type)) throw new Error('禁止的动作：Lead 只能执行白名单动作，不能替人审批或直接改代码')
  validateSchema(value, { type: 'object', ...actionSchemas[value.type as LeadAction['type']] })
  if (value.type === 'dispatch_task') {
    const review = (value as Extract<LeadAction, { type: 'dispatch_task' }>).task.review
    if (review !== undefined && review !== false) validateSchema(review, { type: 'object', required: ['reviewers', 'maxRounds'], properties: { reviewers: strings, maxRounds: { type: 'integer' } } })
  }
}
