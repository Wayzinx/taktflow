import { syncObservations } from '@taktflow/core'
import type { ParsedCli } from '../args.js'
import { expectPositionals, UsageError } from '../args.js'
import { withCliLease } from '../lease.js'
import { createPrinter } from '../output.js'
import { openStores } from '../project.js'

export async function runQuality(cli: ParsedCli): Promise<number> {
  expectPositionals('quality', cli.positionals, 1)
  const command = cli.positionals[0]!
  if (!['sync', 'repair', 'verify', 'defects'].includes(command)) throw new UsageError('quality 子命令：sync | repair | verify | defects')
  if (cli.options.run && command !== 'sync') throw new UsageError('--run 只用于 quality sync')
  const stores = await openStores(cli.options.project)
  const quality = stores.quality!
  const printer = createPrinter(cli.options.json)
  if (command === 'verify') {
    const result = await quality.verify()
    if (printer.json) printer.data(result)
    else printer.text(result.ok ? '质量日志哈希链完整' : `质量日志校验失败：${result.reason}，seq=${result.brokenAt}`)
    return result.ok ? 0 : 1
  }
  return withCliLease(stores.taktDir, async () => {
    if (command === 'defects') {
      const items = await quality.defects({ requirement: cli.options.req })
      if (printer.json) printer.data(items)
      else if (!items.length) printer.text('暂无缺陷')
      else for (const item of items) printer.text(`${item.id}  ${item.severity}  ${item.validity}/${item.resolution}  r${item.revision}  ${item.title}`)
    } else if (command === 'repair') {
      const commit = await quality.repair(cli.options.reason)
      const result = await quality.verify()
      if (!result.ok) throw new Error(`修复后校验失败：${result.reason}`)
      if (printer.json) printer.data({ ...result, revision: commit.revision, appended: commit.appended })
      else printer.text(`质量日志已恢复并校验通过，revision=${commit.revision}`)
    } else {
      const ids = cli.options.run ? [cli.options.run] : (await stores.runs.list()).map((item) => item.runId)
      const results = []
      for (const id of ids) results.push(await syncObservations(stores, id))
      if (printer.json) printer.data(results)
      else for (const result of results) printer.text(`${result.runId}  seq=${result.seq}  新增观察=${result.observations}`)
    }
    return 0
  }, { takeover: cli.options.takeover })
}
