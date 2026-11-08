import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ArtifactRef, Checkpoint, SnapshotManifest } from '../types.js'
import type { HarnessHost } from './harness.js'
import { assertArtifactPath, assertRunId } from '../store/paths.js'
import { assertNoSymlinks, readJsonFile } from '../store/fs-utils.js'
import { sha256 } from '../util/hash.js'
import { safeNodeName } from './execution.js'

export interface SnapshotMaterial {
  path: string; role: 'target' | 'reference'; source: 'artifact' | 'diff' | 'file'
  ref?: ArtifactRef; repo?: string; commit?: string; content: Buffer | string
}
const git = promisify(execFile)
export async function codeMaterials(path: string, repo: string, base: string): Promise<SnapshotMaterial[]> {
  const run = (args: string[]) => git('git', ['-C', path, ...args], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 }).then(result => result.stdout)
  const commit = (await run(['rev-parse', 'HEAD'])).toString().trim()
  const patch = await run(['diff', base, commit, '--'])
  const names = (await run(['diff', '--name-only', '--diff-filter=ACMRT', '-z', base, commit, '--'])).toString().split('\0').filter(Boolean)
  const root = `code/${safeNodeName(repo)}/${sha256(path).slice(0, 12)}`
  const materials: SnapshotMaterial[] = [{ path: `${root}/changes.diff`, role: 'target', source: 'diff', repo, commit, content: patch }]
  for (const name of names) {
    assertArtifactPath(name)
    materials.push({ path: `${root}/files/${name}`, role: 'target', source: 'file', repo, commit, content: await run(['show', `${commit}:${name}`]) })
  }
  return materials
}
export async function artifactMaterials(host: Pick<HarnessHost, 'deps'>, refs: ArtifactRef[], role: 'target' | 'reference'): Promise<SnapshotMaterial[]> {
  return Promise.all(refs.map(async ref => {
    assertArtifactPath(ref.path)
    if (ref.version === undefined) throw new Error(`快照需要指定版本：${ref.path}；请先冻结输入`)
    const content = await host.deps.stores.workspaces.readArtifact(ref)
    if (content === undefined) throw new Error(`快照材料缺失：${ref.path} v${ref.version}；请恢复产物后重试`)
    return { path: `${role}/${ref.path}`, role, source: 'artifact' as const, ref, content }
  }))
}
async function protect(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await protect(path)
    else await chmod(path, 0o444)
  }

}
export async function createSnapshot(host: Pick<HarnessHost, 'deps' | 'guard' | 'emit' | 'timestamp'>, point: Checkpoint, materials: SnapshotMaterial[]): Promise<SnapshotManifest> {
  const stores = host.deps.stores
  const dir = `snapshots/${assertRunId(point.runId)}/${safeNodeName(point.id)}`
  const root = join(stores.taktDir, dir)
  await assertNoSymlinks(stores.taktDir, root)
  await assertNoSymlinks(root, join(root, 'manifest.json'))
  const existing = await readJsonFile<SnapshotManifest>(join(root, 'manifest.json'))
  if (existing) {
    for (const file of existing.files) {
      assertArtifactPath(file.path)
      const path = join(root, 'files', file.path)
      await assertNoSymlinks(root, path)
      if (sha256(await readFile(path)) !== file.sha256) throw new Error('快照内容已改变；请检查存储完整性')
    }
    return existing
  }
  return host.guard.system([`.takt/${dir}/**`], async () => {
    await mkdir(join(root, 'files'), { recursive: true })
    const manifest: SnapshotManifest = { checkpointId: point.id, dir, files: [], duties: point.duties ?? [], readOnly: 'none', createdAt: host.timestamp() }
    const seen = new Set<string>()
    for (const material of materials) {
      assertArtifactPath(material.path)
      if (seen.has(material.path)) throw new Error(`快照路径重复：${material.path}`)
      seen.add(material.path)
      const file = join(root, 'files', material.path)
      await assertNoSymlinks(root, file)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, material.content)
      const { content, ...meta } = material
      manifest.files.push({ ...meta, sha256: sha256(content), size: Buffer.byteLength(content) })
    }
    try { await protect(join(root, 'files')); manifest.readOnly = 'permissions' } catch { /* 无法保证权限时如实记录 none。 */ }
    await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2))
    await host.emit('snapshot.created', manifest, point.nodeId)
    return manifest
  })
}
export function snapshotPrompt(taktDir: string, manifest: SnapshotManifest): string {
  return `只评审以下冻结材料（不得改读存放区当前版本）：\n${manifest.files.map(file => `${file.role} [${file.source}] ${join(taktDir, manifest.dir, 'files', file.path)}`).join('\n')}`
}

export async function snapshotMaterials(taktDir: string, snapshot: SnapshotManifest): Promise<SnapshotMaterial[]> {
  assertArtifactPath(snapshot.dir)
  const root = join(taktDir, snapshot.dir, 'files')
  await assertNoSymlinks(taktDir, root)
  return Promise.all(snapshot.files.map(async file => {
    assertArtifactPath(file.path)
    const path = join(root, file.path)
    await assertNoSymlinks(root, path)
    const content = await readFile(path)
    if (sha256(content) !== file.sha256) throw new Error(`快照材料已损坏：${file.path}；请检查存储完整性`)
    const { sha256: _hash, size: _size, ...metadata } = file
    return { ...metadata, content }
  }))
}
