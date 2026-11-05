import { withCliLease, type WriteLeaseHook } from './lease.js'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createLeadRuntime, type AttentionItem, type RoomMessage } from '@taktflow/core'
import { workflowStore } from '@taktflow/server'
import { createRunEngine, loadRuntime, resolveWorkflow, templatesDir, type ProjectContext } from './project.js'

export async function createProjectLead(context: ProjectContext, withWriteLease?: WriteLeaseHook) {
  const source = workflowStore(context.stores)
  const instructions = context.profiles.lead?.instructions ?? await readFile(join(templatesDir, 'agents', 'lead.md'), 'utf8')
  const runtime = createLeadRuntime({
    withWriteLease: withWriteLease ?? ((stores, fn) => withCliLease(stores.taktDir, fn, { onRenewError: () => runtime.cancelAll() })), stores: context.stores, harnesses: context.harnesses, profiles: context.profiles, instructions,
    engineFactory: (deps) => createRunEngine({ ...context, ...deps }),
    workflows: {
      load: async (id) => resolveWorkflow(await loadRuntime(context.stores.projectDir), id),
      get: source.get,
      replaceSource: (id, request) => source.replaceSource(id, { ...request, reason: `${request.reason ?? 'Lead 提案'}；onBehalfOf ${JSON.stringify(request.onBehalfOf)}` }),
    },
  })
  return runtime
}
export type ProjectLead = Awaited<ReturnType<typeof createProjectLead>>

export async function postToLead(context: ProjectContext, requirementId: string, message: RoomMessage): Promise<void> {
  const lead = await createProjectLead(context)
  await lead.onMessage(requirementId, message)
  await lead.drain()
}

export async function answerLead(context: ProjectContext, item: AttentionItem): Promise<boolean> {
  const run = await context.stores.runs.get(item.runId)
  if (run?.workflowId !== 'lead' && !run?.workflowId.startsWith('task:')) return false
  const lead = await createProjectLead(context)
  const handled = await lead.onAttention(item)
  await lead.drain()
  return handled
}

/** serve 也观察其他 CLI 进程写入的事件；串行扫描，停止时等待正在投影的消息落盘。 */
export async function watchLeadEvents(context: ProjectContext, lead: ProjectLead): Promise<() => Promise<void>> {
  const cursors = new Map<string, number>()
  for (const run of await context.stores.runs.list()) cursors.set(run.runId, (await context.stores.events.read(run.runId)).at(-1)?.seq ?? 0)
  let pending: Promise<void> | undefined
  const poll = async () => {
    for (const run of await context.stores.runs.list()) {
      const events = await context.stores.events.read(run.runId, { afterSeq: cursors.get(run.runId) ?? 0 })
      for (const event of events) {
        await lead.onRunEvent(run.runId, event)
        cursors.set(run.runId, event.seq)
      }
    }
  }
  const timer = setInterval(() => {
    if (pending) return
    pending = poll().catch((error: unknown) => { process.stderr.write(`Lead 进度消息失败：${error instanceof Error ? error.message : String(error)}\n`) }).finally(() => { pending = undefined })
  }, 250)
  timer.unref()
  return async () => { clearInterval(timer); await pending; await lead.drain() }
}

export function leadEvents(context: ProjectContext, lead: ProjectLead): ProjectContext {
  const events = context.stores.events
  const runs = Object.create(context.stores.runs) as typeof context.stores.runs
  runs.list = async (filter) => (await context.stores.runs.list(filter)).filter((run) => (run as { kind?: string }).kind !== 'task' && run.workflowId !== 'lead' && !run.workflowId.startsWith('task:'))
  return { ...context, stores: { ...context.stores, runs, events: {
    append: async (runId, input) => { const event = await events.append(runId, input); await lead.onRunEvent(runId, event); return event },
    read: events.read.bind(events), subscribe: events.subscribe.bind(events), verify: events.verify.bind(events),
  } } }
}
