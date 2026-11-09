import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { selectHarness } from '@taktflow/core'
import { loadRuntimeProfiles } from './runtime-profiles.js'

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
it('共用角色来源：缺 harness 的空间和插件档案继承默认值，knowledge 空数组保留，同名空间覆盖插件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'takt-cli-profiles-')); dirs.push(dir)
  await writeFile(join(dir, 'local.md'), '---\nknowledge: [docs]\n---\n空间正文')
  await writeFile(join(dir, 'same.md'), '---\nharness: mock\nknowledge: []\n---\n覆盖正文')
  const warn = vi.fn()
  const profiles = await loadRuntimeProfiles(dir, {
    plugin: '---\nknowledge: [plugin-docs]\n---\n插件正文',
    same: '---\nharness: codex\n---\n插件同名',
  }, warn)
  expect(warn).not.toHaveBeenCalled()
  expect(profiles.local?.knowledge).toEqual(['docs'])
  expect(profiles.plugin?.knowledge).toEqual(['plugin-docs'])
  expect(profiles.same).toMatchObject({ instructions: '覆盖正文', knowledge: [] })
  expect(profiles.dev).toBeDefined()
  const context = { profiles, harnesses: {}, config: { project: { name: 'test' }, workflows: [], roles: {
    local: { harness: 'local-default' }, plugin: { harness: 'plugin-default' }, same: { harness: 'ignored' },
  } } }
  expect(selectHarness('local', undefined, context).harness).toBe('local-default')
  expect(selectHarness('plugin', undefined, context).harness).toBe('plugin-default')
  expect(selectHarness('same', undefined, context).harness).toBe('mock')
  expect(selectHarness('local', undefined, { ...context, config: { ...context.config, roles: {} } }).harness).toBe('mock')
  await writeFile(join(dir, 'duplicate.md'), '---\nrole: local\n---\n重复')
  await expect(loadRuntimeProfiles(dir, {})).rejects.toThrow('重复')
})
