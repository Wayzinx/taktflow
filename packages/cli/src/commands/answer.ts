import type { AttentionItem } from '@taktflow/core'
import type { ParsedCli } from '../args.js'
import { parseAnswerOptions } from '../args.js'
import { UsageError } from '../args.js'
import { createPrinter } from '../output.js'
import { currentUser } from './ws.js'
import { openStores } from '../project.js'
import { resumeWorkflow } from './run.js'

/** 按待办表单校验回答：choice 必须命中选项，approve/reject 只给 approve 表单，文本只给 answer 表单。 */
export function validateAnswer(item: AttentionItem, input: { decision?: string; answer?: string }): void {
  if (input.decision === 'choice') {
    if (item.form !== 'choice') throw new UsageError(`待办 ${item.requestId} 的表单是 ${item.form}，不接受 --choice`)
    if (!item.choices?.includes(input.answer ?? '')) {
      throw new UsageError(`--choice 必须是以下之一：${(item.choices ?? []).join(', ')}`)
    }
    return
  }
  if (input.decision === 'approve' || input.decision === 'reject') {
    if (item.form !== 'approve') throw new UsageError(`待办 ${item.requestId} 的表单是 ${item.form}，不接受 --${input.decision}`)
    return
  }
  if (item.form !== 'answer') throw new UsageError(`待办 ${item.requestId} 的表单是 ${item.form}，不接受 --answer`)
  if (input.answer === undefined || input.answer.trim() === '') throw new UsageError('--answer 不能为空')
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
