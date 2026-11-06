import path from 'node:path'
import type { ProjectStores } from '../interfaces.js'
import type { Actor, ArtifactRef, RunState } from '../types.js'
import { propagateStale } from '../engine/stale.js'
import { withFileLock } from './file-lock.js'
import { readJsonFile, toJsonText, writeFileAtomic } from './fs-utils.js'
import { assertArtifactPath, assertRequirementId, runDir } from './paths.js'
import { loadRunGraph } from './run-graph.js'
import { applyInvalidations, invalidationsFile, readInvalidations, type RunInvalidation } from './run-invalidations.js'

export async function persistArtifactInvalidation(stores: ProjectStores, runId: string, cause: ArtifactRef): Promise<string[]> {
  assertRequirementId(cause.workspace)
  assertArtifactPath(cause.path)
  const graph = await loadRunGraph(stores, runId)
  const dir = runDir(stores.taktDir, runId)
  const file = path.join(dir, 'state.json')
  return withFileLock(file, async () => {
    const state = await readJsonFile<RunState>(file)
    if (!state) throw new Error(`运行不存在：${runId}`)
    const invalidations = await readInvalidations(dir)
    applyInvalidations(state, invalidations)
    const propagated: string[] = propagateStale(state, graph, cause)
    const ids = propagated.filter((id) => state.nodes[id])
    if (!ids.length) return []
    const version = cause.version ?? (await stores.workspaces.listArtifacts(cause.workspace))
      .find((artifact) => artifact.path === cause.path)?.versions.at(-1)?.version
    const readers = ids.filter((id) => state.nodes[id]!.inputs?.some((input) => input.workspace === cause.workspace
      && input.path === cause.path && (cause.version === undefined || input.version === undefined || input.version < cause.version)))
    const readerImpacts = new Map(readers.map((reader) => {
      const isolated: RunState = { ...state, nodes: Object.fromEntries(Object.entries(state.nodes)
        .map(([id, node]) => [id, { ...node, inputs: id === reader ? node.inputs : [] }])) }
      return [reader, new Set<string>(propagateStale(isolated, graph, cause))]
    }))
    const invalidation: RunInvalidation = {
      cause: { ...cause, version }, readers,
      nodes: Object.fromEntries(ids.map((id) => {
        const { attempts, iteration, startedAt } = state.nodes[id]!
        return [id, { attempts, iteration, startedAt, readers: readers.filter((reader) => readerImpacts.get(reader)!.has(id)) }]
      })),
    }
    // 保留失效墓碑：后来的旧内存快照仍须通过版本与新尝试校验，不能在首次恢复后重新覆盖。
    invalidations.push(invalidation)
    await writeFileAtomic(invalidationsFile(dir), toJsonText(invalidations))
    applyInvalidations(state, invalidations)
    await writeFileAtomic(file, toJsonText(state))
    return ids
  })
}

export async function markArtifactEdited(stores: ProjectStores, cause: ArtifactRef, actor: Actor, reason: string, impact: 'cosmetic' | 'semantic' = 'semantic'): Promise<Array<{ runId: string; nodeId: string }>> {
  assertRequirementId(cause.workspace)
  assertArtifactPath(cause.path)
  if (actor.type !== 'human' && actor.type !== 'agent') throw new Error('产物修改必须使用 human 或 agent actor')
  if (!reason.trim()) throw new Error('产物修改必须填写原因')
  const affected: Array<{ runId: string; nodeId: string }> = []
  for (const run of await stores.runs.list({ requirementId: cause.workspace })) {
    if (impact === 'cosmetic') {
      await stores.events.append(run.runId, { type: 'artifact.edited', actor, data: { ref: cause, reason, impact } })
      continue
    }
    const ids = await persistArtifactInvalidation(stores, run.runId, cause)
    if (!ids.length) continue
    await stores.events.append(run.runId, { type: 'artifact.edited', actor, data: { ref: cause, reason, impact } })
    for (const nodeId of ids) {
      await stores.events.append(run.runId, { type: 'node.stale', actor, nodeId, data: { cause } })
      affected.push({ runId: run.runId, nodeId })
    }
  }
  return affected
}
