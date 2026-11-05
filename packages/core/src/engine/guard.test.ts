import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { WriteGuard } from './guard.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'takt-guard-'))
  roots.push(dir)
  return dir
}

async function write(dir: string, file: string): Promise<void> {
  const target = path.join(dir, file)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, '{}')
}

it('精确忽略租约、状态、缓存和 dsh 绑定的中间文件', async () => {
  const dir = await root()
  const guard = new WriteGuard(dir)
  const end = await guard.begin({ profile: [] })
  for (const file of [
    '.takt/lease.json',
    '.takt/lease.json.tmp',
    '.takt/lease.json.0123abcd.tmp',
    '.takt/lease.json.lock',
    '.takt/status/REQ-001.md',
    '.takt/status/REQ-001.md.tmp',
    '.takt/status/REQ-001.json.0123abcd.tmp',
    '.takt/status/REQ-001.json.lock',
    '.takt/cache/agent/state.json',
    '.takt/dsh/bindings.json',
    '.takt/dsh/bindings.json.tmp',
    '.takt/dsh/bindings.json.0123abcd.tmp',
    '.takt/dsh/bindings.json.lock',
  ]) await write(dir, file)
  expect((await end()).paths).toEqual([])
})

it('相近但不属于元数据的路径仍然会被标记', async () => {
  const dir = await root()
  const guard = new WriteGuard(dir)
  const end = await guard.begin({ profile: [] })
  for (const file of [
    '.takt/status/x.ts',
    '.takt/dsh/other.json',
    '.takt/lease.json.backup',
    '.takt/cachex/file',
    '.takt/status/nested/REQ.md',
  ]) await write(dir, file)
  expect((await end()).paths.sort()).toEqual([
    '.takt/cachex/file',
    '.takt/dsh/other.json',
    '.takt/lease.json.backup',
    '.takt/status/nested/REQ.md',
    '.takt/status/x.ts',
  ])
})

it('M2 群聊、仓库镜像和自定义需求目录元数据精确排除，评审产物只在 system 写入窗口放行', async () => {
  const dir = await root()
  const guard = new WriteGuard(dir, 'custom/requirements')
  const end = await guard.begin({ profile: [] })
  for (const file of [
    '.takt/chat/REQ-1/room.json', '.takt/chat/REQ-1/messages.jsonl',
    '.takt/chat/REQ-1/room.json.abcdef.tmp', '.takt/repos/app/HEAD',
    '.takt/runs/run-1/chain.json', '.takt/space-chain.json',
    '.takt/workflow-revisions/test/log.jsonl',
    'custom/requirements/REQ-1/manifest.json',
  ]) await write(dir, file)
  await guard.system(['custom/requirements/REQ-1/reviews/r/round-1.json'], () => write(dir, 'custom/requirements/REQ-1/reviews/r/round-1.json'))
  await write(dir, '.takt/chat/REQ-1/prompt.md')
  await write(dir, 'custom/requirements/REQ-1/reviews/r/unapproved.md')
  expect((await end()).paths.sort()).toEqual(['.takt/chat/REQ-1/prompt.md', 'custom/requirements/REQ-1/reviews/r/unapproved.md'])
})
