import { constants } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import type { ProjectStores } from '../interfaces.js'
import { assertNoSymlinks, isEnoent } from '../store/fs-utils.js'
import { evalId } from './storage.js'
import { getEvalRun } from './runner.js'

const maxBytes = 200 * 1024

export async function getEvalOutput(stores: ProjectStores, id: string, caseId: string, variant: string): Promise<{ files: Array<{ path: string; content: string }> }> {
  evalId(caseId); evalId(variant)
  const run = await getEvalRun(stores, id)
  const evidence = run.replayEvidence
  if (evidence) {
    const rows = evidence.filter(row => row.caseId === caseId && row.variant === variant)
    if (!rows.length) throw new Error('评测输出不存在；请核对样本与变体')
    return { files: rows.map(row => ({ path: `repeat-${row.repeat + 1}.json`, content: JSON.stringify({ output: row.output, verdict: row.verdict }, null, 2) })) }
  }
  const result = run.results.find((row) => row.caseId === caseId && row.variant === variant)
  if (!result?.outputDir) throw new Error('评测输出不存在')
  const root = join(stores.taktDir, 'evals', 'runs', evalId(id), caseId, variant)
  if (resolve(result.outputDir) !== resolve(root)) throw new Error('评测输出路径不合法')
  const files: Array<{ path: string; content: string }> = []
  const safe = async (path: string) => {
    try { await assertNoSymlinks(stores.taktDir, path) }
    catch { throw new Error('评测输出路径不合法') }
  }
  const visit = async (dir: string): Promise<void> => {
    await safe(dir)
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name)
      await safe(path)
      if (entry.isDirectory()) { await visit(path); continue }
      if (!entry.isFile()) continue
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const bytes = Buffer.alloc(maxBytes + 1)
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
        const truncated = bytesRead > maxBytes
        const prefix = bytes.subarray(0, Math.min(bytesRead, maxBytes))
        if (prefix.includes(0)) continue
        let content: string
        try { content = new TextDecoder('utf-8', { fatal: true }).decode(prefix, { stream: truncated }) }
        catch { continue }
        if (truncated) content += '\n[已截断：文件超过 200KB，仅显示前 200KB]'
        files.push({ path: relative(root, path).split('\\').join('/'), content })
      } finally { await handle.close() }
    }
  }
  try { await visit(root) }
  catch (error) { if (isEnoent(error)) throw new Error('评测输出不存在'); throw error }
  return { files }
}
