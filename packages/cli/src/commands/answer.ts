import { handleInterrupts, withCliLease } from '../lease.js'
import { projectCommands } from '../project-commands.js'
import { executeCommand } from '../execute-command.js'
import { assertAnswerFreshness, validateAnswer as validateCoreAnswer, type AttentionItem } from '@taktflow/core'
import type { ParsedCli } from '../args.js'
import { parseAnswerOptions } from '../args.js'
import { UsageError } from '../args.js'
import { createPrinter } from '../output.js'
import { answerLead } from '../lead.js'
import { loadRuntime, openStores } from '../project.js'
import { ActiveRun, finishOutput, resumeRun, runWithDrain } from './run.js'

export function validateAnswer(item: AttentionItem, input: { decision?: string; answer?: string }): void {
  try { validateCoreAnswer(item, input) } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
}

export async function runAnswer(cli: ParsedCli): Promise<number> {
  const options = cli.options
  const requestId = cli.positionals[0]!
  const input = parseAnswerOptions(options)
  const stores = await openStores(options.project)
  const printer = createPrinter(options.json)
  const active = new ActiveRun()
  const interrupts = handleInterrupts(() => active.cancel())
  try {
    return await withCliLease(stores.taktDir, async () => {
      if (interrupts.interrupted) return 130
      const current = (await stores.attention.list()).find((item) => item.requestId === requestId)
      if (!current) throw new Error(`待办不存在：${requestId}`)
      if (current.answeredAt !== undefined) throw new Error(`待办已处理：${requestId}`)
      await assertAnswerFreshness(stores, current)
      validateAnswer(current, input)
      if (interrupts.interrupted) return 130
      const answered = await executeCommand<AttentionItem>(stores, projectCommands(stores), 'attention.answer', { requestId, ...input }, options.reason)
      if (!options.json) {
        printer.text(`${printer.colors.green('✔')} 已回答 ${printer.colors.cyan(requestId)}：${answered.decision ?? answered.answer ?? ''}`)
      }
      const run = await stores.runs.get(answered.runId)
      if (run?.workflowId === 'lead') {
        if (await answerLead(await loadRuntime(options.project, { mock: options.mock }), answered)) {
          if (options.json) printer.data(answered)
          const resumed = await stores.runs.get(answered.runId)
          return resumed && ['failed', 'cancelled'].includes(resumed.status) ? 1 : 0
        }
      }
      if (options.noResume) {
        if (options.json) printer.data(answered)
        return interrupts.interrupted ? 130 : 0
      }
      if (interrupts.interrupted) return 130
      const context = await loadRuntime(options.project)
      const state = await runWithDrain(
        () => resumeRun(context, answered.runId, options, printer, active),
        async () => { await interrupts.drain(); await active.drain() },
      )
      return interrupts.interrupted ? 130 : await finishOutput(context, printer, state)
    }, {
      takeover: options.takeover,
      onRenewError: async () => { await active.cancel(); await active.drain() },
    })
  } finally { interrupts.dispose() }
}
