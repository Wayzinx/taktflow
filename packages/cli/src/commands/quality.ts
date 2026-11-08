import { projectCommands } from '@taktflow/server'
import type { AttentionTickResult, QualityStatus } from '@taktflow/core'
import { executeCommand } from '../execute-command.js'
import { expectPositionals, UsageError, type ParsedCli } from '../args.js'
import { loadRuntime, openStores } from '../project.js'
import { createPrinter } from '../output.js'
import { resumeAfterAnswer } from './serve.js'
import { answerLead } from '../lead.js'

export async function runQualityCommand(cli: ParsedCli): Promise<number> {
  expectPositionals(cli.command!, cli.positionals, 1)
  const sub = cli.positionals[0]!
  if (cli.command === 'quality' ? !['sync', 'verify', 'repair'].includes(sub) : sub !== 'tick') throw new UsageError('quality sync|verify|repair；attention tick')
  if (sub === 'repair' && !cli.options.reason?.trim()) throw new UsageError('quality repair 必须提供 --reason，说明修复锚点的原因')
  const stores = await openStores(cli.options.project)
  const result = await executeCommand<QualityStatus | AttentionTickResult>(stores, projectCommands(stores), `${cli.command}.${sub}`, sub === 'sync' ? { runId: cli.options.req } : {}, cli.options.reason)
  if ('resume' in result && !cli.options.noResume && result.resume.length) {
    const context = await loadRuntime(cli.options.project)
    for (const runId of result.resume) {
      const item = (await stores.attention.list()).find(item => item.runId === runId && item.handedBack)!
      if (!await answerLead(context, item)) await resumeAfterAnswer(context, item)
    }
  }
  const printer = createPrinter(cli.options.json)
  if (cli.options.json) printer.data(result)
  else printer.text(JSON.stringify(result, null, 2))
  return 'ok' in result && !result.ok ? 1 : 0
}
