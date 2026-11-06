import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { initProject, listDefects } from '@taktflow/core'
import { registerEvalCommands, type EvalCli } from './eval.js'
import { registerDefectCommands } from './defect.js'
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
it('提供可注册的 eval/defect 分发函数并实际落盘缺陷、输出成绩单', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-eval-cli-')); roots.push(root)
  const stores = await initProject(root)
  await stores.workspaces.createRequirement({ id: 'REQ-001', title: 'CLI' })
  const handlers = new Map<string, (cli: EvalCli) => Promise<number>>()
  const register = (command: string, handler: (cli: EvalCli) => Promise<number>) => { handlers.set(command, handler) }
  registerEvalCommands(register); registerDefectCommands(register)
  expect([...handlers.keys()]).toEqual(['eval', 'defect'])
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const options = { project: root, json: true, help: false, arg: [], autoApprove: false, approve: false, reject: false, noResume: false }
  expect(await handlers.get('defect')!({ positionals: ['report', 'REQ-001'], options: { ...options, title: '缺陷', desc: 'AC-2', severity: 'major' } })).toBe(0)
  expect(await listDefects(stores, 'REQ-001')).toMatchObject([{ id: 'D-1', title: '缺陷' }])
  expect(await handlers.get('eval')!({ positionals: ['scorecards'], options })).toBe(0)
  expect(output).toHaveBeenCalled()
  await expect(handlers.get('eval')!({ positionals: ['bad'], options })).rejects.toThrow('子命令')
})
