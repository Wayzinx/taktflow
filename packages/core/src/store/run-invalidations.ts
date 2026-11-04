import path from 'node:path'
import type { ArtifactRef, NodeState, RunState } from '../types.js'
import { readJsonFile } from './fs-utils.js'

export interface RunInvalidation {
  cause: ArtifactRef
  readers: string[]
  nodes: Record<string, Pick<NodeState, 'attempts' | 'iteration' | 'startedAt'> & { readers?: string[] }>
}

export const invalidationsFile = (dir: string): string => path.join(dir, 'invalidations.json')
export async function readInvalidations(dir: string): Promise<RunInvalidation[]> {
  return (await readJsonFile<RunInvalidation[]>(invalidationsFile(dir))) ?? []
}

function newer(node: NodeState, old: RunInvalidation['nodes'][string]): boolean {
  return node.attempts > old.attempts
    || (node.attempts === old.attempts && (node.iteration ?? 0) > (old.iteration ?? 0))
}

export function applyInvalidations(state: RunState, invalidations: RunInvalidation[]): void {
  for (const invalidation of invalidations) {
    const { cause, nodes, readers } = invalidation
    for (const [id, old] of Object.entries(nodes)) {
      const node = state.nodes[id]
      if (!node) continue
      const consumed = (old.readers ?? readers).every((readerId) => {
        const reader = state.nodes[readerId]
        if (!reader || !newer(reader, nodes[readerId]!)) return false
        // 条件已在新执行中重判为跳过，旧读者不再产出结果；不要求重新打开已不使用的输入。
        if (reader.status === 'skipped' && reader.outputs.length === 0 && reader.result === undefined) return true
        return cause.version !== undefined && reader.inputs?.some((input) =>
          input.workspace === cause.workspace && input.path === cause.path && input.version !== undefined && input.version >= cause.version!)
      })
      // 新尝试可以进入 running 并解析输入；成功落盘仍必须证明旧读者已经消费新版本。
      const fresh = newer(node, old)
      if (fresh && (node.status === 'running' || node.status === 'ready' || consumed)) continue
      node.status = 'stale'
    }
  }
  if (state.status === 'succeeded' && Object.values(state.nodes).some((node) => node.status === 'stale')) {
    state.status = 'failed'
    delete state.endedAt
  }
}
