import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { ProjectStores } from '../interfaces.js'
import { WriteGuard } from '../engine/guard.js'
import { sha256 } from '../util/hash.js'
import { initProject } from './project.js'
import { materializeSnapshot, verifySnapshot } from './materialize-snapshot.js'
import { getObject, putObject } from './objects.js'

let root: string
let stores: ProjectStores
const actor = { type: 'system' as const, id: 'test' }
async function writable(dir: string): Promise<void> {
  await chmod(dir, 0o755)
  for (const entry of await readdir(dir, { withFileTypes: true })) if (entry.isDirectory()) await writable(path.join(dir, entry.name))
}
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'quality-snapshot-'))
  stores = await initProject(root)
  await stores.workspaces.createRequirement({ id: 'REQ-1', title: '快照测试' })
})
afterEach(async () => { await writable(root); await rm(root, { recursive: true, force: true }) })
const artifact = (content: string, name = 'docs/spec.md') => stores.workspaces.writeArtifact({
  ref: { workspace: 'REQ-1', path: name }, content, kind: 'spec', author: actor,
})
const snapshotDir = () => path.join(stores.taktDir, 'quality', 'snapshots', 'run-1:review:1:1:qa')

it('快照使用指定历史对象、保持路径，文件只读、额外文件被拒，可重复校验', async () => {
  const ref = await artifact('原始正文')
  await artifact('新正文')
  await writeFile(path.join(stores.workspaces.dir('REQ-1'), ref.path), '未经登记的编辑')
  const dir = snapshotDir()
  const refs = [{ ref, role: 'target' as const }]
  const manifest = await materializeSnapshot(stores, refs, dir)
  expect(manifest).toEqual({ [ref.path]: sha256('原始正文') })
  expect(await readFile(path.join(dir, ref.path), 'utf8')).toBe('原始正文')
  expect((await lstat(path.join(dir, ref.path))).mode & 0o222).toBe(0)
  // 目录保持可写（项目可删除）；冻结靠文件只读 + 清单校验：额外文件会让校验失败
  await expect(writeFile(path.join(dir, ref.path), '写入')).rejects.toThrow()
  await writeFile(path.join(dir, 'new.txt'), '新文件')
  await expect(materializeSnapshot(stores, [{ ref, role: 'target' }], dir)).rejects.toThrow(/额外文件|不是只读/)
  await rm(path.join(dir, 'new.txt'))
  expect(await materializeSnapshot(stores, refs, dir)).toEqual(manifest)
  await expect(verifySnapshot(dir, manifest)).resolves.toBeUndefined()
})

it('缺版本、缺对象、hash 损坏都拒绝，不创建可使用的半快照', async () => {
  const ref = await artifact('原始正文')
  const dir = snapshotDir()
  await expect(materializeSnapshot(stores, [{ ref: { ...ref, version: undefined }, role: 'target' }], dir)).rejects.toThrow('指定产物版本')
  await expect(materializeSnapshot(stores, [{ ref, role: 'target', sha256: sha256('其他') }], dir)).rejects.toThrow('hash 校验失败')
  const object = path.join(stores.taktDir, 'objects', sha256('原始正文'))
  await writeFile(object, '已篡改')
  await expect(materializeSnapshot(stores, [{ ref, role: 'target' }], dir)).rejects.toThrow('hash 校验失败')
  await rm(object)
  await expect(materializeSnapshot(stores, [{ ref, role: 'target' }], dir)).rejects.toThrow('对象缺失')
  await expect(lstat(dir)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('快照篡改后 verify 与重新物化均拒绝覆盖', async () => {
  const ref = await artifact('原始正文')
  const dir = snapshotDir()
  const refs = [{ ref, role: 'reference' as const }]
  const manifest = await materializeSnapshot(stores, refs, dir)
  const file = path.join(dir, ref.path)
  await chmod(file, 0o644)
  await writeFile(file, '篡改正文')
  await chmod(file, 0o444)
  await expect(verifySnapshot(dir, manifest)).rejects.toThrow('hash 校验失败')
  await expect(materializeSnapshot(stores, refs, dir)).rejects.toThrow('hash 校验失败')
  expect(await readFile(file, 'utf8')).toBe('篡改正文')
})

it('临时回放目录可物化；路径冲突、越界、符号链接拒绝', async () => {
  const ref = await artifact('v1')
  const next = await artifact('v2')
  const temporary = await mkdtemp(path.join(root, 'replay-'))
  await expect(materializeSnapshot(stores, [{ ref, role: 'input' }], temporary)).resolves.toEqual({ [ref.path]: sha256('v1') })
  await expect(materializeSnapshot(stores, [{ ref, role: 'target' }, { ref: next, role: 'reference' }], snapshotDir())).rejects.toThrow('路径版本冲突')
  await expect(materializeSnapshot(stores, [{ ref: { ...ref, path: '../outside' }, role: 'target' }], snapshotDir())).rejects.toThrow('非法产物路径')
  const linked = path.join(root, 'linked')
  await symlink(temporary, linked)
  await expect(materializeSnapshot(stores, [{ ref, role: 'target' }], linked)).rejects.toThrow('符号链接')
  await expect(materializeSnapshot(stores, [{ ref, role: 'target' }], path.join(stores.taktDir, 'objects'))).rejects.toThrow('空间快照必须')
})

it('对象接口可读写二进制，幂等且拒绝路径注入、符号链接和内容损坏', async () => {
  const bytes = Buffer.from([0, 255, 1, 128])
  const hashes = await Promise.all([putObject(stores, bytes), putObject(stores.taktDir, bytes)])
  expect(hashes).toEqual([sha256(bytes), sha256(bytes)])
  expect(await getObject(stores, hashes[0]!)).toEqual(bytes)
  await expect(getObject(stores, '../config')).rejects.toThrow('非法对象')
  const file = path.join(stores.taktDir, 'objects', hashes[0]!)
  await chmod(file, 0o644)
  await writeFile(file, '坏对象')
  await expect(getObject(stores, hashes[0]!)).rejects.toThrow('hash 校验失败')
  await expect(putObject(stores, bytes)).rejects.toThrow('hash 校验失败')
  await rm(file)
  const external = path.join(root, 'outside')
  await writeFile(external, bytes)
  await symlink(external, file)
  await expect(getObject(stores, hashes[0]!)).rejects.toThrow('符号链接')
})

it('WriteGuard 只排除质量存储实际路径，相似名字仍报告越界', async () => {
  const finish = await new WriteGuard(root, 'requirements').begin({ profile: [] })
  const hash = 'a'.repeat(64)
  const allowed = ['log.jsonl', 'chain.json', 'cursors.json', 'log.jsonl.lock', 'chain.json.0123456789abcdef.tmp',
    'views/defects.json', 'views/attributions.json', 'views/evals.json.0123456789abcdef.tmp',
    'snapshots/checkpoint/docs/spec.md', `evals/candidates/${hash}/candidate.json`, `evals/candidates/${hash}/objects/${hash}`,
    `evals/candidates/${hash}.0123456789abcdef.tmp/candidate.json`]
  const denied = ['log.jsonl.bak', 'views/rogue.json', 'evals/settings.json', `evals/candidates/${hash}/extra.ts`,
    'snapshots-extra/checkpoint/spec.md', 'settings.json', 'views/defects.json.locked']
  for (const name of [...allowed, ...denied]) {
    const target = path.join(stores.taktDir, 'quality', name)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, '{}')
  }
  expect((await finish()).paths.sort()).toEqual(denied.map((name) => `.takt/quality/${name}`).sort())
})
