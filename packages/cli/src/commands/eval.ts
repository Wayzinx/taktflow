import { projectCommands } from '@taktflow/server'
import { executeCommand } from '../execute-command.js'
import type { EvalRun } from '@taktflow/core'
import { getEvalRun, parseEvalTarget, scorecards, waitEvalRun, type EvalVariant, type HarnessSelector, type ScorecardOptions } from '@taktflow/core'
import { createPrinter } from '../output.js'
import { engineDependencies, loadRuntime, openStores } from '../project.js'
import { expectPositionals, parsePositiveInt, UsageError, type ParsedCli } from '../args.js'

export interface EvalCli extends Omit<ParsedCli, 'options'> {
  options: ParsedCli['options'] & { by?: string; workflow?: string; target?: string; defects?: boolean; variant?: string[]; judge?: string; title?: string; desc?: string; severity?: string; note?: string }
}
export type EvalCliRegister = (command: string, handler: (cli: EvalCli) => Promise<number>) => void
export function registerEvalCommands(register: EvalCliRegister): void { register('eval', runEvalCommand) }
export async function runEvalCommand(cli: EvalCli): Promise<number> {
  const [sub, ...args] = cli.positionals, options = cli.options
  const printer = createPrinter(options.json)
  const output = (value: unknown) => options.json ? printer.data(value) : printer.text(JSON.stringify(value, null, 2))
  if (sub === 'scorecards') {
    expectPositionals('eval scorecards', args, 0, 0)
    output(await scorecards(await openStores(options.project), { by: (options.by ?? 'node') as ScorecardOptions['by'], workflowId: options.workflow }))
  } else if (sub === 'collect') {
    expectPositionals('eval collect', args, 0, 0)
    const stores = await openStores(options.project)
    output(await executeCommand(stores, projectCommands(stores), 'eval.collect', { target: options.target ? parseEvalTarget(options.target) : undefined, includeDefects: options.defects }, options.reason))
  } else if (sub === 'sample' || sub === 'retire') {
    expectPositionals(`eval ${sub}`, args, sub === 'sample' ? 0 : 1)
    const stores = await openStores(options.project)
    output(await executeCommand(stores, projectCommands(stores), sub === 'sample' ? 'eval.sample' : 'eval.retire', sub === 'sample' ? JSON.parse(options.input ?? '{}') : { caseId: args[0] }, options.reason))
  } else if (sub === 'show') {
    expectPositionals('eval show', args, 1, 1)
    output(await getEvalRun(await openStores(options.project), args[0]!))
  } else if (sub === 'run') {
    expectPositionals('eval run', args, 1, 1)
    const context = await loadRuntime(options.project, { mock: options.mock })
    const variants = (options.variant ?? []).map((value) => JSON.parse(value) as EvalVariant)
    const judge = options.judge ? options.judge.trim().startsWith('{') ? JSON.parse(options.judge) as HarnessSelector : { ...context.profiles.evaluator?.harness, harness: context.profiles.evaluator?.harness.harness ?? 'native', model: options.judge } : undefined
    const run = await executeCommand<EvalRun>(context.stores, projectCommands(context.stores, {}, engineDependencies(context)), 'eval.run', { target: parseEvalTarget(args[0]!), variants, judge, repeats: options.repeats ? parsePositiveInt(options.repeats, '--repeats') : undefined }, options.reason)
    // CLI 进程拥有后台任务，退出前等落盘，避免留下永远 running 的记录。
    const finished = await waitEvalRun(context.stores, run.id)
    output(finished)
    return finished.status === 'done' ? 0 : 1
  } else throw new UsageError('eval 子命令：scorecards | collect | run | show | sample | retire')
  return 0
}
