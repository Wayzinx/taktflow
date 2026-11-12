import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { canonicalJson, initProject, patchedConfig, sha256 } from '@taktflow/core'
import { stewardConfigPatch } from './steward-config-patch.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })
it('写入锁内用磁盘配置校验基线：内存快照过期也不能删除队友新增成员', async () => {
  const root = await mkdtemp(join(tmpdir(), 'steward-config-lock-'))
  roots.push(root)
  const stores = await initProject(root, { name: '测试' })
  stores.config.members = [{ id: 'alice', name: 'Alice', role: 'owner' }]
  const patch = { members: [...stores.config.members, { id: 'bob', name: 'Bob', role: 'member' }] }
  const baseHash = sha256(canonicalJson(patchedConfig(stores.config, patch)))
  const file = join(root, 'takt.config.json')
  await writeFile(file, JSON.stringify({ ...stores.config, members: [...stores.config.members, { id: 'carol', name: 'Carol', role: 'viewer' }] }))
  await expect(stewardConfigPatch(stores, { patch, baseHash }, { type: 'human', id: 'alice' }, '测试')).rejects.toMatchObject({ status: 409 })
  expect(JSON.parse(await readFile(file, 'utf8')).members.map((m: { id: string }) => m.id)).toEqual(['alice', 'carol'])
  const fresh = JSON.parse(await readFile(file, 'utf8'))
  const input = { patch: { members: [...fresh.members, { id: 'bob', name: 'Bob', role: 'member' }] }, baseHash: sha256(canonicalJson(patchedConfig(fresh, patch))) }
  await stewardConfigPatch(stores, input, { type: 'human', id: 'alice' }, '测试')
  expect(JSON.parse(await readFile(file, 'utf8')).members.map((m: { id: string }) => m.id)).toEqual(['alice', 'carol', 'bob'])
})
