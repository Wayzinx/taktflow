import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, readFile, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootstrapWorktree } from './bootstrap.js'
import * as runtime from './runtime.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'takt-bootstrap-'))
  await mkdir(join(root, 'source')); await mkdir(join(root, 'target'))
})
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })
const binding = { id: 'app', path: 'source', defaultBranch: 'main' }

it('bootstrap uses a ten-minute timeout; timeout errors retain output tail', async () => {
  const collect = vi.spyOn(runtime, 'collect')
  await bootstrapWorktree({ ...binding, bootstrap: 'echo ready' }, join(root, 'source'), join(root, 'target'))
  expect(collect.mock.calls[0]?.[2]).toBe(600_000)
  collect.mockImplementationOnce(async child => {
    await runtimeCollectUntilExit(child)
    throw new Error('Sandbox command timed out after 600000ms')
  })
  await expect(bootstrapWorktree({ ...binding, bootstrap: 'echo before-timeout' }, join(root, 'source'), join(root, 'target'))).rejects.toThrow('600000ms\nbefore-timeout')
})
function runtimeCollectUntilExit(child: ReturnType<typeof runtime.launch>): Promise<void> {
  return new Promise(resolve => child.once('close', () => resolve()))
}

it('shares symlinked source directories and rejects escaping target parents before mkdir', async () => {
  await mkdir(join(root, 'cache'))
  await writeFile(join(root, 'cache', 'file'), 'cached')
  await symlink(join(root, 'cache'), join(root, 'source', 'node_modules'))
  expect((await bootstrapWorktree({ ...binding, share: ['node_modules'] }, join(root, 'source'), join(root, 'target')))?.shared).toEqual(['node_modules'])
  expect(await readFile(join(root, 'target/node_modules/file'), 'utf8')).toBe('cached')
  await mkdir(join(root, 'source/nested/new/deps'), { recursive: true })
  await mkdir(join(root, 'outside'))
  await symlink(join(root, 'outside'), join(root, 'target/nested'))
  await expect(bootstrapWorktree({ ...binding, share: ['nested/new/deps'] }, join(root, 'source'), join(root, 'target'))).rejects.toThrow('符号链接')
  await expect(access(join(root, 'outside/new'))).rejects.toThrow()
})
