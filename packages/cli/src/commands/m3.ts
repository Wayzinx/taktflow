import { cliActor } from '../actor.js'
import { waitEvalRun, waitDefectAttribution, type DefectDetail, type EvalRun } from '@taktflow/core'
import { projectCommands, attachLessons } from '@taktflow/server'
import { expectPositionals, UsageError, type ParsedCli } from '../args.js'
import { loadRuntime, openStores } from '../project.js'
import { createProjectLead } from '../lead.js'
import { createPrinter } from '../output.js'

export async function runM3Command(cli: ParsedCli): Promise<number> {
  const { command, positionals: args, options } = cli
  const stores = await openStores(options.project)
  attachLessons(stores)
  const actor = cliActor(stores)
  let id = ''; let input: Record<string, unknown> = {}; let reason = options.reason
  if (command === 'route') {
    expectPositionals('route', args, 1)
    id = 'route.preview'; input = { requirementId: args[0], ...(options.hint ? { hint: options.hint } : {}) }
    if (options.tier) { if (!reason?.trim()) throw new UsageError('--tier 需要 --reason'); input.override = { tier: options.tier, reason } }
  } else if (command === 'review') {
    if (args[0] !== 'dispose') throw new UsageError('review 子命令：dispose')
    expectPositionals('review dispose', args.slice(1), 3)
    id = 'review.dispose'; input = { runId: args[1], nodeId: args[2], groupKey: args[3], state: options.state }
  } else if (command === 'lessons') {
    if (args[0] === 'ls') { expectPositionals('lessons ls', args.slice(1), 0); id = 'lessons.list' }
    else {
      expectPositionals('lessons', args, 2)
      if (args[0] === 'show') {
        const lesson = await stores.lessons?.get(args[1]!)
        if (!lesson) throw new UsageError('经验不存在')
        createPrinter(options.json).data(lesson); return 0
      }
      if (!['activate', 'retire'].includes(args[0]!)) throw new UsageError('lessons 子命令：ls | show | retire | activate')
      id = 'lesson.status'; input = { id: args[1], status: args[0] === 'activate' ? 'active' : 'retired' }
    }
  } else {
    expectPositionals('cmd', args, 1)
    if (args[0] === 'ls') { createPrinter(options.json).data(projectCommands(stores).list()); return 0 }
    id = args[0]!
    try { input = JSON.parse(options.input ?? '{}') as Record<string, unknown> } catch { throw new UsageError('--input 必须是 JSON 对象') }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new UsageError('--input 必须是 JSON 对象')
  }
  const runtimeNeeded = ['run.start', 'run.resume', 'run.retry', 'run.cancel', 'task.dispatch', 'attention.answer', 'route.preview', 'eval.run', 'defect.attribute'].includes(id)
  const lead = runtimeNeeded ? await createProjectLead(await loadRuntime(options.project, { mock: options.mock })) : undefined
  let result = await (lead?.commands ?? projectCommands(stores)).run(id, input, { actor, reason })
  await lead?.drain()
  // 短命令退出前等待自己启动的后台任务落盘。
  if (result.ok && id === 'eval.run') {
    const run = await waitEvalRun(stores, (result.result as EvalRun).id)
    result = { ...result, ok: run.status === 'done', result: run }
  }
  if (result.ok && id === 'defect.attribute') {
    const initial = result.result as DefectDetail
    const defect = await waitDefectAttribution(stores, initial.requirementId, initial.id)
    const completed = defect.status === 'attributed' && defect.attribution?.at !== initial.attribution?.at
    result = { ...result, ok: completed, result: defect,
      message: completed ? result.message : '缺陷归因失败，详情见缺陷审计日志' }
  }
  createPrinter(options.json).data(result)
  return result.ok ? 0 : 1
}
