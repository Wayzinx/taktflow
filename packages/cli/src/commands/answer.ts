import { projectCommands } from '@taktflow/server'
import { executeCommand } from '../execute-command.js'
import { validateAnswer as validateCoreAnswer, type AttentionItem } from '@taktflow/core'
import type { ParsedCli } from '../args.js'
import { parseAnswerOptions } from '../args.js'
import { UsageError } from '../args.js'
import { createPrinter } from '../output.js'
import { answerLead } from '../lead.js'
import { loadRuntime, openStores } from '../project.js'
import { resumeWorkflow } from './run.js'

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
  const current = (await stores.attention.list()).find((item) => item.requestId === requestId)
  if (!current) throw new Error(`待办不存在：${requestId}`)
  if (current.answeredAt !== undefined) throw new Error(`待办已处理：${requestId}`)
  validateAnswer(current, input)
  const answered = await executeCommand<AttentionItem>(stores, projectCommands(stores), 'attention.answer', { requestId, ...input }, options.reason)
  if (!options.json) {
    printer.text(`${printer.colors.green('✔')} 已回答 ${printer.colors.cyan(requestId)}：${answered.decision ?? answered.answer ?? ''}`)
  }
  if (answered.kind === 'assumption') {
    if (options.json) printer.data(answered)
    return 0
  }
  const run = await stores.runs.get(answered.runId)
  if (run?.workflowId === 'lead' || !options.noResume && run?.workflowId.startsWith('task:')) {
    if (await answerLead(await loadRuntime(options.project, { mock: options.mock }), answered)) {
      if (options.json) printer.data(answered)
      const resumed = await stores.runs.get(answered.runId)
      return resumed && ['failed', 'cancelled'].includes(resumed.status) ? 1 : 0
    }
  }
  if (options.noResume) {
    if (options.json) printer.data(answered)
    return 0
  }
  // 运行选项（workflow 路径 / harness / mock）从运行记录恢复，不必重复传。
  return resumeWorkflow({
    command: 'resume',
    positionals: [answered.runId],
    options: { ...options },
  })
}
