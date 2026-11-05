import { execFile } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { commitWorkflow } from './git.js'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))
afterEach(() => vi.resetAllMocks())

function reply(code = 0, stderr = '') {
  vi.mocked(execFile).mockImplementationOnce((...args: unknown[]) => {
    const callback = args.at(-1) as (error: unknown, stdout: string, stderr: string) => void
    callback(code ? Object.assign(new Error(stderr), { code }) : null, '', stderr)
    return {} as ReturnType<typeof execFile>
  })
}

describe('可选 git 提交（仅模拟命令，不执行提交）', () => {
  it('非 git 目录跳过', async () => {
    reply(128, 'not a git repository')
    await commitWorkflow('/tmp/workflows/demo.workflow.ts', { type: 'human', id: 'alice' }, '更新')
    expect(execFile).toHaveBeenCalledTimes(1)
  })
  it('仅提交当前文件，作者来自 Actor，其他暂存项不随提交带走', async () => {
    reply(); reply(); reply()
    await commitWorkflow('/tmp/workflows/demo.workflow.ts', { type: 'agent', role: 'dev', harness: 'test' }, '更新提示词')
    const calls = vi.mocked(execFile).mock.calls
    expect(calls[1]?.[1]).toEqual(['add', '--', 'demo.workflow.ts'])
    expect(calls[2]?.[1]).toEqual(['-c', 'user.name=dev (test)', '-c', 'user.email=workflow@taktflow.local', 'commit', '--only', '--author=dev (test) <workflow@taktflow.local>', '-m', '更新提示词', '--', 'demo.workflow.ts'])
  })
  it('提交失败明确说明源码已经保存', async () => {
    reply(); reply(); reply(1, 'hook failed')
    await expect(commitWorkflow('/tmp/workflows/demo.workflow.ts', { type: 'human', id: 'alice' }, '更新')).rejects.toThrow('源码已保存，但 git 提交失败')
  })
})
