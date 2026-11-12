import { auditKnowledge, compactRunEvents, EVENT_COMPACTION_RULES, type EventCompactionResult, type EventCompactionRule } from '@taktflow/core'
import { cliActor } from '../actor.js'
import { UsageError, type CliOptions } from '../args.js'
import { createPrinter, type Printer } from '../output.js'
import { openStores } from '../project.js'

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

function summary(printer: Printer, plan: EventCompactionResult) {
  const { colors } = printer
  printer.text(`${colors.bold(plan.runId)} 事件日志压缩（规则 ${plan.rules.join(' + ')}）`)
  printer.text(`  归档 ${plan.dropped} 条${plan.dropped ? `：${Object.entries(plan.byRule).map(([rule, n]) => `${rule} ${n}`).join('，')}` : ''}`)
  printer.text(`  主日志 ${mb(plan.originalBytes)} → ${plan.record ? '' : '约 '}${mb(plan.keptBytes)}`)
  if (plan.hidesThinking) printer.text(colors.yellow(`  ${EVENT_COMPACTION_RULES['acp-thought-chunks']}`))
}

/** takt runs compact <runId> [--rule …] [--dry-run]：把噪声行移进归档，seq / hash 不变，写一条空间审计。 */
export async function runRunsCompact(runId: string, options: CliOptions): Promise<number> {
  const rules = (options.rule ?? []).flatMap(rule => rule.split(',')).map(rule => rule.trim()).filter(Boolean)
  for (const rule of rules) if (!Object.hasOwn(EVENT_COMPACTION_RULES, rule)) throw new UsageError(`--rule 只能是 ${Object.keys(EVENT_COMPACTION_RULES).join(' / ')}：${rule}`)
  const stores = await openStores(options.project)
  const printer = createPrinter(options.json)
  const by = cliActor(stores)
  const result = await compactRunEvents(stores, runId, {
    rules: rules as EventCompactionRule[], dryRun: options.dryRun, by,
    onPlan: plan => { if (!options.json) summary(printer, plan) },
  })
  if (result.record) {
    const { record } = result
    await auditKnowledge(stores, by, options.reason ?? `压缩运行 ${runId} 的事件日志`,
      `run.events.compacted:${runId}:${record.archive}:${record.rule.join('+')}:${record.dropped}`)
  }
  if (options.json) {
    printer.data(result)
    return result.verify?.ok === false ? 1 : 0
  }
  const { colors } = printer
  if (!result.record) {
    summary(printer, result)
    printer.text(colors.dim(result.dryRun ? '  dry-run：没有改动任何文件' : '  没有可归档的行，没有改动文件'))
    return 0
  }
  printer.text(`${colors.green('✔')} 已压缩：${mb(result.originalBytes)} → ${mb(result.keptBytes)}，归档 ${result.record.archive}（${mb(result.record.archiveBytes)}）`)
  const verify = result.verify
  if (verify?.ok) printer.text(`${colors.green('✔')} 哈希链完整（连同归档）`)
  else printer.text(`${colors.red('✘')} 哈希链在第 ${verify?.brokenAt} 条断链${verify?.reason ? `：${verify.reason}` : ''}`)
  return verify?.ok ? 0 : 1
}
