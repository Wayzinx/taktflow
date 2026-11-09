import { AutomationRecords, systemWrite, type ProjectStores } from '@taktflow/core'
import { actor, authorize, body, HttpError, text } from './http.js'
import { auditSpace, changeConfig } from './space.js'
import { STREAMING, type Handler } from './routes.js'
import { automationId, automationsView, channelView, readAutomation, readChannel, referenceProblems, workflowIds } from './automation-config.js'
import { sendToChannel } from './channel-delivery.js'
import type { AutomationRuntime } from './automation-runtime.js'

export interface AutomationCallbacks {
  automationRuntime?(stores: ProjectStores): Promise<AutomationRuntime>
  automationFetch?: typeof fetch
}
export function automationRoutes(add: (method: string, path: string, handler: Handler) => void, options: AutomationCallbacks) {
  add('GET', '/api/space/automations', ({ stores }) => automationsView(stores))
  add('GET', '/api/space/automations/:id/runs', ({ stores, params }) => new AutomationRecords(stores).list(automationId(params.id!), 20))
  for (const kind of ['automations', 'channels'] as const) for (const method of ['PUT', 'DELETE']) add(method, `/api/space/${kind}/:id`, async ({ stores, request, params, response }) => {
    authorize(request, stores, 'owner')
    const id = automationId(params.id!), input = await body(request), reason = text(input.reason, 'reason（修改原因）')
    const workflows = await workflowIds(stores)
    await systemWrite(stores.projectDir, ['takt.config.json*', '.takt/space-events.jsonl*'], () => changeConfig(stores, actor(request, stores), reason, `${method} ${kind}/${id}`, config => {
      if (kind === 'automations') {
        const entries = config.automations ?? []
        if (method === 'DELETE') { config.automations = entries.filter(a => a.id !== id); return }
        const value = readAutomation(input.automation, id), problems = referenceProblems(value, config, workflows)
        if (problems.length) throw new HttpError(400, problems.join('；'))
        config.automations = [...entries.filter(a => a.id !== id), value]
      } else {
        const entries = config.channels ?? []
        if (method === 'DELETE') {
          const usedBy = (config.automations ?? []).filter(a => a.notify?.channels.includes(id)).map(a => a.id)
          if (usedBy.length) throw new HttpError(409, `渠道仍被 ${usedBy.join('、')} 使用，请先修改自动化`)
          config.channels = entries.filter(c => c.id !== id); return
        }
        config.channels = [...entries.filter(c => c.id !== id), readChannel(input.channel, id)]
      }
    }))
    if (method === 'DELETE') { response.writeHead(204); response.end(); return STREAMING }
    if (kind === 'channels') return channelView(stores.config.channels!.find(c => c.id === id)!, stores.config)
    return (await automationsView(stores)).automations.find(a => a.id === id)
  })
  const trigger: Handler = async ({ stores, request, params }) => {
    authorize(request, stores, 'owner')
    const id = automationId(params.id!), reason = text((await body(request)).reason, 'reason（修改原因）')
    if (!options.automationRuntime) throw new HttpError(503, '自动化调度器未接入，请重新启动 serve')
    const runtime = await options.automationRuntime(stores)
    await systemWrite(stores.projectDir, ['.takt/space-events.jsonl*'], () => auditSpace(stores, actor(request, stores), reason, `${params.recordId ? 'retry' : 'trigger'} automation/${id}`))
    return runtime.execute(id, params.recordId ? 'retry' : 'manual', undefined, params.recordId)
  }
  add('POST', '/api/space/automations/:id/trigger', trigger)
  add('POST', '/api/space/automations/:id/runs/:recordId/retry', trigger)
  add('POST', '/api/space/channels/:id/test', async ({ stores, request, params }) => {
    authorize(request, stores, 'owner')
    const id = automationId(params.id!), reason = text((await body(request)).reason, 'reason（修改原因）')
    const channel = stores.config.channels?.find(c => c.id === id)
    if (!channel) throw new HttpError(404, '渠道不存在，请刷新渠道列表')
    await systemWrite(stores.projectDir, ['.takt/space-events.jsonl*'], () => auditSpace(stores, actor(request, stores), reason, `test channel/${id}`))
    return sendToChannel(channel, { automation: { id: 'test', title: '渠道测试' }, text: `takt 渠道测试：${stores.config.project.name}`, links: [] }, options.automationFetch)
  })
}
