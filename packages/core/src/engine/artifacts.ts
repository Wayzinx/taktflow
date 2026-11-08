import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectStores } from '../interfaces.js'
import type { Actor, ArtifactRef, NodeDef, NodeState, RunState } from '../types.js'
import { assertArtifactPath } from '../store/paths.js'
import { assertNoSymlinks, isEnoent } from '../store/fs-utils.js'
import { listFiles, matchGlob } from '../util/glob.js'
import { sha256 } from '../util/hash.js'
import { BlockedError, type Emit } from './harness.js'
import { validateSchema } from './schema.js'

const metadata = new Set(['manifest.json', 'requirement.json', 'comments.jsonl'])

export async function readCurrent(stores: ProjectStores, workspace: string, path: string): Promise<Buffer | undefined> {
  assertArtifactPath(path)
  if (metadata.has(path.split('/')[0]!.toLowerCase())) throw new Error(`不能读取存储元数据：${path}`)
  const file = join(stores.workspaces.dir(workspace), path)
  await assertNoSymlinks(stores.paths.requirements, file)
  try { return await readFile(file) } catch (error) { if (isEnoent(error)) return undefined; throw error }
}

async function files(stores: ProjectStores, requirementId: string): Promise<string[]> {
  return (await listFiles(stores.workspaces.dir(requirementId), ['**'], { ignore: [] }))
    .filter((path) => !metadata.has(path.toLowerCase()) && !/\.[a-f0-9]{16}\.tmp$/.test(path))
}

export async function resolveInputs(stores: ProjectStores, state: RunState, node: NodeDef, emit: Emit): Promise<ArtifactRef[]> {
  if (!node.inputs?.length) return []
  const available = await files(stores, state.requirementId)
  const records = await stores.workspaces.listArtifacts(state.requirementId)
  const refs = new Map<string, ArtifactRef>()
  for (const input of node.inputs) {
    const matches = available.filter((path) => matchGlob(input.path, path))
    if (!matches.length && input.required !== false) throw new BlockedError(`缺少必需输入：${input.path}`)
    for (const path of matches) {
      if (refs.has(path)) continue
      const content = await readCurrent(stores, state.requirementId, path)
      if (!content) throw new BlockedError(`输入已消失：${path}`)
      const record = records.find((item) => item.path === path)
      const latest = record?.versions.at(-1)
      if (latest?.sha256 === sha256(content)) refs.set(path, { workspace: state.requirementId, path, version: latest.version })
      else {
        const kind = input.kind ?? record?.kind ?? 'input'
        const ref = await stores.workspaces.writeArtifact({
          ref: { workspace: state.requirementId, path }, content, kind,
          author: { type: 'system', id: 'engine' }, reason: `冻结 ${node.id} 的输入版本`,
        })
        refs.set(path, ref)
        await emit('artifact.written', { ref, kind, sha256: sha256(content) }, node.id)
      }
    }
  }
  return [...refs.values()]
}

export async function collectOutputs(stores: ProjectStores, state: RunState, node: NodeDef, ns: NodeState, actor: Actor, emit: Emit): Promise<void> {
  if (!node.outputs?.length) return
  const available = await files(stores, state.requirementId)
  const collected = new Map<string, ArtifactRef>()
  for (const output of node.outputs) {
    const matches = available.filter((path) => matchGlob(output.path, path))
    if (!matches.length && output.required !== false) throw new Error(`缺少必需产物：${output.path}`)
    for (const path of matches) {
      if (collected.has(path)) continue
      const content = await readCurrent(stores, state.requirementId, path)
      if (!content) throw new Error(`产物已消失：${path}`)
      if (path.endsWith('.json') && output.schema) validateSchema(JSON.parse(content.toString()), output.schema)
      const ref = await stores.workspaces.writeArtifact({
        ref: { workspace: state.requirementId, path }, content, kind: output.kind, author: actor,
        reason: node.title, derivedFrom: ns.inputs ?? [], producedBy: { runId: state.runId, nodeId: node.id, invocationId: actor.type === 'agent' ? actor.invocationId : undefined },
      })
      collected.set(path, ref)
      await emit('artifact.written', { ref, kind: output.kind, sha256: sha256(content) }, node.id, actor)
    }
  }
  ns.outputs = [...collected.values()]
}
