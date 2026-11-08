import { join } from 'node:path'
import { reconcileAssumptions, createCommandRegistry, evalCommandSpecs, createLessonStore, routeRequirement, setReviewDisposition, answerOrRead, validateAnswer, type CommandHandlers, type EngineDeps, type ProjectStores } from '@taktflow/core'
import { auditSpace, workflowStore } from './space.js'
import { configuredRouteModel } from './knowledge-runtime.js'
import { serialize } from './stale.js'

export function attachLessons(stores: ProjectStores): void {
  if (stores.config.lessons?.enabled === false || stores.lessons) return
  stores.lessons = createLessonStore({ dir: join(stores.projectDir, 'knowledge/lessons'),
    audit: (entry) => auditSpace(stores, entry.by, entry.reason, JSON.stringify(entry)) })
}

export function projectCommands(stores: ProjectStores, handlers: CommandHandlers = {}, runtime: EngineDeps = { stores, profiles: {}, harnesses: {}, knowledge: [] }) {
  attachLessons(stores)
  return createCommandRegistry({ stores,
    audit: (entry) => auditSpace(stores, entry.actor, entry.reason ?? '查询命令', JSON.stringify(entry)),
    route: async (input, context) => routeRequirement({ stores, ...input, workflows: await routingWorkflows(stores), model: configuredRouteModel(stores), by: context.actor }),
    answerAttention: (input, context) => answerAttention(stores, input, context.actor),
    disposeReview: (input, context) => setReviewDisposition(stores, input.runId, input.nodeId, { ...input, by: context.actor, reason: context.reason! }),
    setLessonStatus: async (input, context) => {
      if (!stores.lessons) throw new Error('经验库未启用')
      return stores.lessons.setStatus(input.id, input.status, context.actor, context.reason!)
    },
    extensions: [{ id: 'lesson.update', title: '编辑经验', kind: 'command', risk: 'write', minRole: 'maintainer',
      input: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' },
        status: { type: 'string', enum: ['tentative', 'active', 'retired'] }, trigger: { type: 'object', properties: Object.fromEntries(['roles', 'paths', 'signatures', 'categories'].map((key) => [key, { type: 'array', items: { type: 'string' } }])) } } },
      handler: async (input, context) => {
        const previous = await stores.lessons?.get(input.id as string)
        if (!previous || !stores.lessons) throw new Error('经验不存在或未启用')
        const patch = Object.fromEntries(['title', 'body', 'trigger', 'status'].filter((key) => input[key] !== undefined).map((key) => [key, input[key]]))
        return stores.lessons.upsert({ ...previous, ...patch }, context.actor, context.reason!)
      },
    }, ...evalCommandSpecs({ ...runtime, stores })],
    ...handlers,
  })
}

export function answerAttention(stores: ProjectStores, input: { requestId: string; decision?: string; answer?: string }, by: import('@taktflow/core').Actor) {
  return serialize(stores.projectDir, async () => {
    const current = (await stores.attention.list()).find((item) => item.requestId === input.requestId)
    if (!current) throw new Error('待办不存在')
    validateAnswer(current, input)
    const answered = await answerOrRead(stores, current, { ...input, by })
    if (answered.kind === 'assumption') await reconcileAssumptions(stores)
    return answered
  })
}

export async function routingWorkflows(stores: ProjectStores) {
  const source = workflowStore(stores)
  const workflows = await Promise.all((await source.list({ record: false })).map(async ({ id }) => ({ id, snapshot: (await source.get(id, { record: false })).snapshot! })))
  return workflows.filter((workflow) => workflow.snapshot)
}
