import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { initProject } from '../../../core/src/store/project.js'
import { runStewardCommand, type StewardCli } from './steward.js'
import { parseCliArgs } from '../args.js'
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
it('CLI 单空间问答、提案批准撤销与汇报均可直接调用', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-steward-cli-')); roots.push(root)
  await initProject(root)
  const output: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((text) => { output.push(String(text)); return true })
  const invoke = async (...args: string[]) => {
    output.length = 0
    const cli = parseCliArgs(['--project', root, '--json', 'steward', ...args]) as StewardCli
    expect(await runStewardCommand(cli)).toBe(0)
    return JSON.parse(output.join(''))
  }
  const status = await invoke('ask', '现在进度怎么样')
  expect(status).toMatchObject({ status: 'done', offline: true }); expect(status.citations[0].href).toMatch(/^\/s\//)
  const reply = await invoke('ask', '新建需求 CLI 草稿')
  const proposal = (await invoke('proposals')).find((item: { id: string }) => item.id === reply.proposalIds[0])
  expect(await invoke('approve', proposal.id)).toMatchObject({ status: 'applied' })
  expect(await invoke('undo', proposal.id)).toMatchObject({ status: 'reverted' })
  expect(await invoke('risks')).toBeInstanceOf(Array)
  expect(await invoke('digest')).toMatchObject({ summary: expect.any(String), progress: expect.any(Array) })
})
