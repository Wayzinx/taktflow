import { projectCommands } from '../project-commands.js'
import { executeCommand } from '../execute-command.js'
import { waitDefectAttribution, type DefectDetail } from '@taktflow/core'
import { expectPositionals, UsageError } from '../args.js'
import { createPrinter } from '../output.js'
import { engineDependencies, loadRuntime, openStores } from '../project.js'
import type { EvalCli, EvalCliRegister } from './eval.js'

export function registerDefectCommands(register: EvalCliRegister): void { register('defect', runDefectCommand) }
export async function runDefectCommand(cli: EvalCli): Promise<number> {
  const [sub, ...args] = cli.positionals, options = cli.options
  const stores = await openStores(options.project)
  let result: unknown
  if (sub === 'report') {
    expectPositionals('defect report', args, 1, 1)
    if (!options.title || !options.desc || !options.severity) throw new UsageError('必须提供 --title --desc --severity')
    result = await executeCommand(stores, projectCommands(stores), 'defect.report', { requirementId: args[0], title: options.title, description: options.desc, severity: options.severity, acs: options.ac, evidence: options.evidence, links: options.links?.map((url) => ({ type: 'url', url })) }, options.reason)
  } else if (sub === 'attribute') {
    expectPositionals('defect attribute', args, 2, 2)
    const deps = await loadRuntime(options.project, { mock: options.mock })
    const initial = await executeCommand<DefectDetail>(stores, projectCommands(stores, {}, engineDependencies(deps)), 'defect.attribute', { requirementId: args[0], defectId: args[1] }, options.reason)
    result = await waitDefectAttribution(stores, args[0]!, args[1]!)
    if ((result as DefectDetail).status !== 'attributed' || (result as DefectDetail).attribution?.at === initial.attribution?.at) throw new Error('缺陷归因失败，详情见缺陷审计日志')
  } else if (sub === 'confirm') {
    expectPositionals('defect confirm', args, 2, 2)
    result = await executeCommand(stores, projectCommands(stores), 'defect.confirm', { requirementId: args[0], defectId: args[1], note: options.note }, options.reason)
  } else throw new UsageError('defect 子命令：report | attribute | confirm')
  const printer = createPrinter(options.json)
  if (options.json) printer.data(result)
  else printer.text(JSON.stringify(result, null, 2))
  return 0
}
