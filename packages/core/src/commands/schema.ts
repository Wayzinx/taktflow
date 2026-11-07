const text = { type: 'string' }
export const budgetSchema = { type: 'object', properties: {
  tokens: { type: 'number' }, costUsd: { type: 'number' }, minutes: { type: 'number' }, concurrency: { type: 'integer' },
} }
export const taskSchema = { type: 'object', required: ['role', 'title', 'instructions'], properties: {
  role: text, title: text, instructions: text, repo: text,
  inputs: { type: 'array', items: text }, writeScope: { type: 'array', items: text }, completion: { type: 'array', items: text },
  impact: { type: 'string', enum: ['cosmetic', 'semantic'] },
  outputs: { type: 'array', items: { type: 'object', required: ['path', 'kind'], properties: { path: text, kind: text } } },
} }
export const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required })
export const commandSchemas = {
  'requirement.status': objectSchema({ requirementId: text }, ['requirementId']),
  'run.status': objectSchema({ runId: text }, ['runId']),
  'attention.list': objectSchema({ requirementId: text, pending: { type: 'boolean' } }),
  'lessons.list': objectSchema({ status: { type: 'string', enum: ['tentative', 'active', 'retired'] } }),
  'requirement.create': objectSchema({ id: text, title: text, description: text, owner: text, members: { type: 'array', items: text }, dueAt: text, workflowId: text, start: { type: 'boolean' }, repos: { type: 'array', items: text }, budget: budgetSchema, reason: text, attachments: { type: 'array', items: objectSchema({ name: text, content: text, encoding: { type: 'string', enum: ['utf8', 'base64'] } }, ['name', 'content']) }, links: { type: 'array', items: objectSchema({ type: text, url: text, title: text }, ['type', 'url']) } }, ['title']),
  'route.preview': objectSchema({ requirementId: text, draft: objectSchema({ title: text, description: text }, ['title']), hint: text, repos: { type: 'array', items: text }, override: objectSchema({ tier: { type: 'string', enum: ['T0', 'T1', 'T2', 'T3'] }, reason: text }, ['tier', 'reason']) }),
  'run.start': objectSchema({ requirementId: text, workflowId: text, args: { type: 'object' }, budget: budgetSchema, route: { type: 'object' } }, ['requirementId', 'workflowId']),
  'run.resume': objectSchema({ runId: text }, ['runId']),
  'run.cancel': objectSchema({ runId: text }, ['runId']),
  'attention.answer': objectSchema({ requestId: text, decision: { type: 'string', enum: ['approve', 'reject', 'answer', 'choice'] }, answer: text }, ['requestId']),
  'task.dispatch': objectSchema({ requirementId: text, task: taskSchema }, ['requirementId', 'task']),
  'review.dispose': objectSchema({ runId: text, nodeId: text, groupKey: text, state: { type: 'string', enum: ['open', 'resolved', 'dismissed'] } }, ['runId', 'nodeId', 'groupKey', 'state']),
  'lesson.status': objectSchema({ id: text, status: { type: 'string', enum: ['tentative', 'active', 'retired'] } }, ['id', 'status']),
}
