import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { NodeState } from '../types.js'
import { failureCode, inputIdentity, recordFailure, scopesOverlap } from './fingerprint.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
it('指纹按输入版本与 HEAD 区分，输入顺序不影响身份，重复计数持久可序列化', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-fingerprint-')); roots.push(root)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  git('init'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.test')
  await writeFile(join(root, 'file'), 'v1'); git('add', '.'); git('commit', '-m', 'v1')
  const ns: NodeState = { id: 'a', attempts: 1, outputs: [], status: 'failed', inputs: [
    { workspace: 'req', path: 'b', version: 1 }, { workspace: 'req', path: 'a', version: 1 },
  ], worktree: { repo: 'repo', path: root, branch: 'main', base: 'HEAD' } }
  const identity = await inputIdentity(ns)
  ns.inputs!.reverse()
  expect(await inputIdentity(ns)).toBe(identity)
  await recordFailure(ns, 'error', 'TC-1', '2026-01-01T00:00:00Z')
  expect((await recordFailure(ns, 'error', 'TC-1', '2026-01-01T00:01:00Z')).count).toBe(2)
  ns.inputs![0]!.version = 2
  expect((await recordFailure(ns, 'error', 'TC-1', '2026-01-01T00:02:00Z')).count).toBe(1)
  await writeFile(join(root, 'file'), 'v2'); git('commit', '-am', 'v2')
  expect((await recordFailure(ns, 'error', 'TC-1', '2026-01-01T00:03:00Z')).count).toBe(1)
  expect(JSON.parse(JSON.stringify(ns.failures))).toHaveLength(3)
})
it('失败分类与 glob 静态前缀相交', () => {
  expect(failureCode(new Error('命令退出码 9：失败'))).toBe('exit:9')
  expect(failureCode(new DOMException('expired', 'TimeoutError'))).toBe('timeout')
  expect(failureCode(new Error('写权限越界'))).toBe('guard')
  expect(scopesOverlap(['src/foo*.ts'], ['src/foobar.ts'])).toBe(true)
  expect(scopesOverlap(['src/**'], ['src/a/**'])).toBe(true)
  expect(scopesOverlap(['src/a/**'], ['src/b/**'])).toBe(false)
})
