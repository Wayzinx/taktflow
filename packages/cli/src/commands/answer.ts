import { validateAnswer as validateCoreAnswer, type AttentionItem } from '@taktflow/core'
import type { ParsedCli } from '../args.js'
import { parseAnswerOptions } from '../args.js'
import { UsageError } from '../args.js'
import { createPrinter } from '../output.js'
import { currentUser } from './ws.js'
import { openStores } from '../project.js'
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
  const answered = await stores.attention.answer(requestId, { ...input, by: { type: 'human', id: currentUser(stores.projectDir) } })
  if (!options.json) {
    printer.text(`${printer.colors.green('✔')} 已回答 ${printer.colors.cyan(requestId)}：${answered.decision ?? answered.answer ?? ''}`)
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
