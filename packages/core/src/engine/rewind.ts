import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectStores } from '../interfaces.js'
import type { Actor, ArtifactRef, RunState } from '../types.js'
import type { RewindPreview, RewindRequest, RewindResult } from '../api.js'
import { nodeChanges, repoChanges, rewindGit } from '../insights/changes.js'
import { sha256, canonicalJson } from '../util/hash.js'
import { assertNoSymlinks } from '../store/fs-utils.js'
import { assertArtifactPath, assertNodeId, runDir } from '../store/paths.js'
import { withFileLock } from '../store/file-lock.js'
import { loadRunGraph } from '../store/run-graph.js'
import { propagateStale } from './stale.js'
import { markArtifactEdited, persistArtifactInvalidation } from '../store/artifact-edits.js'

export type RewindExecutionResult = RewindResult

export class RewindConflictError extends Error {
  readonly status = 409
  constructor() { super('回退预览已过期，请重新预览并确认') }
}
export async function rewindAffected(stores: ProjectStores, state: RunState, nodeId: string): Promise<string[]> {
  // 借用同一传播规则，只把目标节点作为起点，不改变真实输入。
  const cause: ArtifactRef = { workspace: state.requirementId, path: '__rewind__' }
  const copy = structuredClone(state)
  for (const node of Object.values(copy.nodes)) node.inputs = node.id === nodeId ? [cause] : []
  return propagateStale(copy, await loadRunGraph(stores, state.runId), cause)
}
export async function previewRewind(stores: ProjectStores, runId: string, nodeId: string): Promise<RewindPreview> {
  assertNodeId(nodeId)
  const state = await stores.runs.get(runId)
  if (!state?.nodes[nodeId]) throw new Error('节点不存在，请刷新运行后重试')
  const changes = await nodeChanges(stores, runId, nodeId)
  const affected = await rewindAffected(stores, state, nodeId)
  const graph = await loadRunGraph(stores, runId)
  let blocked = changes.rewindBlocked

  const current = changes.rewindPoint ? await repoChanges(stores, changes.rewindPoint) : undefined
  const artifacts = await stores.workspaces.listArtifacts(state.requirementId)
  const untracked = await stores.workspaces.detectUntracked(state.requirementId)
  const stale = affected.map(id => ({ runId, nodeId: id, title: graph.find(node => node.id === id)?.title }))
  const related = await stores.runs.list({ requirementId: state.requirementId })
  for (const run of related) {
    if (run.runId === runId) continue
    const graph = await loadRunGraph(stores, run.runId)
    for (const file of changes.files.filter(file => file.scope === 'workspace')) {
      for (const id of propagateStale(run, graph, { workspace: state.requirementId, path: file.path })) {
        if (!stale.some(item => item.runId === run.runId && item.nodeId === id)) stale.push({ runId: run.runId, nodeId: id, title: graph.find(node => node.id === id)?.title })
      }
    }
  }
  if (stale.some(item => (item.runId === runId ? state : related.find(run => run.runId === item.runId))?.nodes[item.nodeId]?.status === 'running')) blocked = '本节点或下游正在运行，请等待结束后重新预览'
  return { nodeId, files: changes.files, stale, blocked,
    token: sha256(canonicalJson({ state, related, point: changes.rewindPoint, current, artifacts, untracked, blocked })) }
}
export async function rewind(stores: ProjectStores, runId: string, nodeId: string, input: RewindRequest, actor: Actor): Promise<RewindResult> {
  assertNodeId(nodeId)
  if (actor.type === 'system') throw new Error('回退需要明确的操作人，请使用人工或代理身份')
  if (!input.reason.trim()) throw new Error('回退必须填写原因，请补充后重试')
  return withFileLock(join(runDir(stores.taktDir, runId), 'rewind'), async () => {
    const preview = await previewRewind(stores, runId, nodeId)
    if (preview.token !== input.token) throw new RewindConflictError()
    if (preview.blocked) throw new Error(preview.blocked)
    const changes = await nodeChanges(stores, runId, nodeId)
    const state = (await stores.runs.get(runId))!
    const reason = `回退到 ${nodeId} 之前：${input.reason}`
    const restores: Array<{ ref: ArtifactRef; content: Buffer; kind: import('../types.js').ArtifactKind }> = []
    const kept: string[] = []
    const artifacts = await stores.workspaces.listArtifacts(state.requirementId)
    // 所有可验证的前置条件在第一次写入之前检查。
    for (const file of changes.files) {
      assertArtifactPath(file.path)
      if (file.scope === 'workspace') {
        const ref = changes.rewindPoint!.artifacts?.find(ref => ref.path === file.path)
        if (!ref) { kept.push(file.path); continue }
        const content = await stores.workspaces.readArtifact(ref)
        if (!content) throw new Error(`回退版本不可读：${file.path}，请修复存储后重试`)
        restores.push({ ref, content, kind: artifacts.find(artifact => artifact.path === file.path)!.kind })
      } else {
        const repo = changes.rewindPoint!.repos!.find(repo => repo.repo === file.repo)!
        await assertNoSymlinks(repo.path, join(repo.path, file.path))
        if (file.oldPath) await assertNoSymlinks(repo.path, join(repo.path, assertArtifactPath(file.oldPath)))
      }
    }
    const restored: Array<{ path: string; scope: 'repo' | 'workspace'; repo?: string; version?: number }> = []
    for (const file of changes.files.filter(file => file.scope === 'repo')) {
      const repo = changes.rewindPoint!.repos!.find(repo => repo.repo === file.repo)!
      if (file.status === 'added' || file.status === 'renamed') {
        // rm 只处理已预览的单一路径；从不 reset 或清理整个工作树。
        await rm(join(repo.path, file.path), { force: true })
        await rewindGit(repo.path, ['rm', '--cached', '--ignore-unmatch', '--', file.path])
      }
      if (file.status !== 'added') await rewindGit(repo.path, ['restore', `--source=${repo.head}`, '--staged', '--worktree', '--', file.oldPath ?? file.path])
      restored.push({ path: file.path, scope: 'repo', repo: file.repo })
    }
    const stale = [...preview.stale]
    for (const path of kept) {
      restored.push({ path, scope: 'workspace' })
      const cause: ArtifactRef = { workspace: state.requirementId, path }
      // 内容不变，但依赖这份待重做产物的其他运行也必须过期。
      for (const run of await stores.runs.list({ requirementId: state.requirementId })) {
        for (const id of await persistArtifactInvalidation(stores, run.runId, cause)) {
          if (!stale.some(item => item.runId === run.runId && item.nodeId === id)) stale.push({ runId: run.runId, nodeId: id })
          await stores.events.append(run.runId, { type: 'node.stale', actor, nodeId: id, data: { cause } })
        }
      }
    }
    for (const restore of restores) {
      const ref = await stores.workspaces.writeArtifact({ ref: restore.ref, content: restore.content, kind: restore.kind, author: actor, reason })
      restored.push({ path: ref.path, scope: 'workspace', version: ref.version })
      if (actor.type === 'human' || actor.type === 'agent') for (const item of await markArtifactEdited(stores, ref, actor, reason)) {
        if (!stale.some(existing => existing.runId === item.runId && existing.nodeId === item.nodeId)) stale.push(item)
      }
    }
    const latest = (await stores.runs.get(runId))!
    for (const item of preview.stale.filter(item => item.runId === runId)) latest.nodes[item.nodeId]!.status = 'stale'
    if (latest.status === 'succeeded') { latest.status = 'failed'; delete latest.endedAt }
    await stores.runs.save(latest)
    const data = { files: restored, kept, stale, reason }
    await stores.events.append(runId, { type: 'node.rewound', actor, nodeId, data })
    return { files: preview.files.map(file => ({ ...file, version: restored.find(item => item.scope === file.scope && item.path === file.path && item.repo === file.repo)?.version })), stale }
  })
}
