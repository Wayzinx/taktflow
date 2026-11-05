import { validateAnswer as validateCoreAnswer, type AttentionItem } from '@taktflow/core'
import type { ParsedCli } from '../args.js'
import { parseAnswerOptions } from '../args.js'
import { UsageError } from '../args.js'
import { createPrinter } from '../output.js'
import { currentUser } from './ws.js'
import { loadRuntime, openStores } from '../project.js'
import { handleInterrupts, withCliLease } from '../lease.js'
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
    // answer 与随后的 resume 共用一把租约，避免两次获取之间被别的进程插入。
    return await withCliLease(stores.taktDir, async () => {
      // 信号先到就不再批准：不能"已中断却仍然写入答复并返回 0"。
      if (interrupts.interrupted) return 130
      const current = (await stores.attention.list()).find((item) => item.requestId === requestId)
      if (!current) throw new Error(`待办不存在：${requestId}`)
      if (current.answeredAt !== undefined) throw new Error(`待办已处理：${requestId}`)
      validateAnswer(current, input)
      if (interrupts.interrupted) return 130
      const answered = await stores.attention.answer(requestId, { ...input, by: { type: 'human', id: currentUser(stores.projectDir) } })
      if (!options.json) {
        printer.text(`${printer.colors.green('✔')} 已回答 ${printer.colors.cyan(requestId)}：${answered.decision ?? answered.answer ?? ''}`)
      }
      if (options.noResume) {
        if (options.json) printer.data(answered)
        return interrupts.interrupted ? 130 : 0
      }
      if (interrupts.interrupted) return 130
      // 运行选项（workflow 路径 / harness / mock）从运行记录恢复，不必重复传。
      const context = await loadRuntime(options.project)
      const state = await runWithDrain(
        () => resumeRun(context, answered.runId, options, printer, active),
        async () => {
          await interrupts.drain()
          await active.drain()
        },
      )
      return interrupts.interrupted ? 130 : await finishOutput(context, printer, state)
    }, {
      takeover: options.takeover,
      onRenewError: async () => {
        await active.cancel()
        await active.drain()
      },
    })
  } finally {
    interrupts.dispose()
  }
}
