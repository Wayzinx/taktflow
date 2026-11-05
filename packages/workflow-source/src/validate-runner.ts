import { writeSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { defineWorkflow, snapshotWorkflow } from '@taktflow/core'

try {
  const module = await import(pathToFileURL(process.argv[2]!).href)
  const workflow = module.default?.default ?? module.default
  const snapshot = snapshotWorkflow(defineWorkflow(workflow))
  writeSync(3, JSON.stringify({ snapshot, diagnostics: [] }))
} catch (error) {
  writeSync(3, JSON.stringify({ message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined }))
}
// workflow 顶层代码可能注册计时器，快照返回后不让它拖住服务端请求。
process.exit(0)
