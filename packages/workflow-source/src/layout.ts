import { join } from 'node:path'
import type { WorkflowLayout } from '@taktflow/core'
import { assertId, readOptional, writeAtomic } from './files.js'

export async function readWorkflowLayout(dir: string, id: string): Promise<WorkflowLayout> {
  assertId(id)
  const text = await readOptional(join(dir, `${id}.layout.json`))
  if (text === undefined) return { nodes: {} }
  try { return JSON.parse(text) as WorkflowLayout } catch (error) {
    throw new Error(`布局文件不是合法 JSON：${id}.layout.json`, { cause: error })
  }
}

export async function writeWorkflowLayout(dir: string, id: string, layout: WorkflowLayout): Promise<WorkflowLayout> {
  assertId(id)
  await writeAtomic(join(dir, `${id}.layout.json`), JSON.stringify(layout, null, 2) + '\n')
  return layout
}

export function pruneWorkflowLayout(layout: WorkflowLayout, ids: Iterable<string>): WorkflowLayout {
  const keep = new Set(ids)
  return { ...layout, nodes: Object.fromEntries(Object.entries(layout.nodes).filter(([id]) => keep.has(id))) }
}
