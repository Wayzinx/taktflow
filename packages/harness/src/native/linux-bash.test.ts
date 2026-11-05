import { afterEach, describe, expect, it, vi } from 'vitest'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolPaths } from './paths.js'
import { linuxBashArgs } from './linux-bash.js'
import { runBash, sandboxAvailable } from './bash.js'
import * as bash from './bash.js'
import { createNativeHarness } from './index.js'
import type { HarnessEvent, ModelProvider } from '@taktflow/core'

const dirs: string[] = []
async function paths(scope: string[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'takt-linux-bash-')))
  dirs.push(root)
  await mkdir(join(root, 'allowed', 'deep'), { recursive: true })
  await writeFile(join(root, 'allowed', 'deep', 'yes.txt'), 'original')
  await writeFile(join(root, 'allowed', 'no.js'), 'original')
  await writeFile(join(root, 'denied'), 'original')
  return ToolPaths.create(root, scope, new AbortController().signal)
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

it('omits bash and explains why when isolation is unavailable, even with opt in', async () => {
  vi.spyOn(bash, 'sandboxAvailable').mockResolvedValue(false)
  const provider: ModelProvider = {
    id: 'test', protocol: 'openai-chat', available: async () => ({ ok: true }),
    chat: async request => {
      expect(request.tools?.some(tool => tool.name === 'bash')).toBe(false)
      return { message: { role: 'assistant', content: 'done' }, stopReason: 'end' }
    },
  }
  const harness = createNativeHarness({ providers: { test: provider }, models: { test: { provider: 'test', id: 'test' } } })
  expect(await harness.available()).toMatchObject({ ok: true, reason: expect.stringContaining('bash disabled') })
  const cwd = (await paths(['**'])).root
  const events: HarnessEvent[] = []
  expect((await harness.run({ cwd, prompt: 'test', model: 'test', tools: { allowBash: true } }, event => events.push(event))).ok).toBe(true)
  expect(events).toContainEqual({ type: 'message', role: 'system', text: expect.stringContaining('bash disabled') })
})

it('maps full subtrees to directory binds but never expands a file glob to its parent', async () => {
  const narrow = await paths(['allowed/**/*.txt'])
  const args = await linuxBashArgs(narrow)
  expect(args).toContain('--unshare-net')
  expect(args).toContain('--unshare-pid')
  const binds = args.flatMap((arg, index) => arg === '--bind' ? [args[index + 1]] : [])
  expect(binds).toEqual([join(narrow.root, 'allowed', 'deep', 'yes.txt')])
  const broad = await paths(['allowed/**'])
  const broadArgs = await linuxBashArgs(broad)
  expect(broadArgs.flatMap((arg, index) => arg === '--bind' ? [broadArgs[index + 1]] : [])).toEqual([join(broad.root, 'allowed')])
})

const available = process.platform === 'linux' && await sandboxAvailable()
it('CI requires a usable Linux native bash sandbox', () => {
  if (process.env.TAKT_REQUIRE_BWRAP === '1') expect(available).toBe(true)
})
describe.skipIf(!available)('real Linux native bash', () => {
  it('writes allowed subtrees, denies other writes, and keeps file glob scopes narrow', async () => {
    const broad = await paths(['allowed/**'])
    await runBash('printf new > allowed/new; mkdir allowed/newdir', broad)
    expect(await readFile(join(broad.root, 'allowed/new'), 'utf8')).toBe('new')
    await expect(runBash('printf bad > denied', broad)).rejects.toThrow()
    expect(await readFile(join(broad.root, 'denied'), 'utf8')).toBe('original')
    const narrow = await paths(['allowed/**/*.txt'])
    await runBash('printf updated > allowed/deep/yes.txt', narrow)
    await expect(runBash('printf bad > allowed/no.js', narrow)).rejects.toThrow()
    await expect(runBash('printf bad > allowed/deep/new.txt', narrow)).rejects.toThrow()
    expect(await readFile(join(narrow.root, 'allowed/deep/yes.txt'), 'utf8')).toBe('updated')
  })
  it('cancels descendants and removes background processes when the shell exits', async () => {
    const base = await paths(['allowed/**'])
    const controller = new AbortController()
    const scoped = await ToolPaths.create(base.root, base.scope, controller.signal)
    const running = runBash('(sleep 1; printf bad > allowed/later) & wait', scoped)
    setTimeout(() => controller.abort(), 100)
    await expect(running).rejects.toThrow('cancelled')
    await runBash('(sleep 1; printf bad > allowed/after) & printf done', base)
    await new Promise(resolve => setTimeout(resolve, 1100))
    await expect(access(join(base.root, 'allowed/later'))).rejects.toThrow()
    await expect(access(join(base.root, 'allowed/after'))).rejects.toThrow()
  })
})
