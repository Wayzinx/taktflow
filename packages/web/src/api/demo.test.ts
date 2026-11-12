/**
 * TF-001：只有显式 ?mock=1 / VITE_MOCK=1 才进演示数据；演示拒绝写操作；
 * 连真实 API 时慢就退避重试，总时长用满才算连不上（不再 1.5 秒超时就静默换成演示数据）。
 */
import { describe, expect, it } from 'vitest'
import { connectApi } from './client'
import { DEMO_READONLY_MESSAGE, demoMode, isWriteMethod, readOnlyDemo } from './demo'
import type { DataSource } from './source'

describe('demoMode', () => {
  it('只认显式开关 ?mock=1 / VITE_MOCK=1，不能开启可写演示', () => {
    expect(demoMode('?mock=1', undefined)).toBe('readonly')
    expect(demoMode('?mock=rw', undefined)).toBeUndefined()
    expect(demoMode('', '1')).toBe('readonly')
    expect(demoMode('', 'rw')).toBeUndefined()
    expect(demoMode('', undefined)).toBeUndefined()
    expect(demoMode('?mock=0', undefined)).toBeUndefined()
    expect(demoMode('?theme=dark', '')).toBeUndefined()
  })
})

describe('只读演示', () => {
  it('只读查询命令仍可用，写命令和未知命令禁止执行', async () => {
    const run = async () => ({ ok: true })
    const base = { commands: async () => [{ id: 'attention.list', risk: 'read' }, { id: 'run.start', risk: 'write' }], runCommand: run } as unknown as DataSource
    const ds = readOnlyDemo(base)
    await expect(ds.runCommand('attention.list', { input: {} })).resolves.toEqual({ ok: true })
    await expect(ds.runCommand('run.start', { input: {} })).rejects.toMatchObject({ status: 405 })
    await expect(ds.runCommand('unknown', { input: {} })).rejects.toMatchObject({ status: 405 })
  })
  it('写方法按动词识别，查询、订阅、预览类 POST 不算写', () => {
    for (const w of ['setMembers', 'saveSpaceFile', 'createRequirement', 'answer', 'runCommand', 'rewind', 'postStewardMessage', 'patchRuntime', 'putSecret', 'testChannel', 'undoProposal', 'stewardFeedback', 'decideMerge', 'reportProductEvent'])
      expect(isWriteMethod(w), w).toBe(true)
    for (const r of ['project', 'runs', 'run', 'runDelivery', 'rewindPreview', 'routePreview', 'routePreviewDraft', 'subscribeSteward', 'settings', 'stewardFeed', 'proposals', 'mergeSuggestions', 'testimonials'])
      expect(isWriteMethod(r), r).toBe(false)
  })

  it('写操作被拒绝并说明原因，读操作照常；forSpace 绑定的数据源也只读', async () => {
    const calls: string[] = []
    const base = {
      mock: true,
      project: async () => (calls.push('project'), { name: 'demo' }),
      setMembers: async () => (calls.push('setMembers'), {}),
      forSpace: () => base,
    } as unknown as DataSource
    const ds = readOnlyDemo(base)
    expect(ds.mock).toBe(true)
    await expect(ds.project()).resolves.toEqual({ name: 'demo' })
    await expect(ds.setMembers([], '原因')).rejects.toMatchObject({ status: 405, message: DEMO_READONLY_MESSAGE })
    await expect(ds.forSpace('other').setMembers([], '原因')).rejects.toMatchObject({ status: 405 })
    expect(ds.forSpace('other')).toBe(ds.forSpace('other'))
    expect(calls).toEqual(['project'])
  })

  it('汇报只读预览不标已读，查询命令的内部写调用也被拦截', async () => {
    const calls: unknown[] = []
    const base = {
      digest: async (_since: string | undefined, opts: unknown) => (calls.push(opts), {}),
      commands: async () => [{ id: 'nested.read', risk: 'read' }],
      setMembers: async () => (calls.push('write'), {}),
      async runCommand(this: DataSource) { return this.setMembers([], '测试') },
    } as unknown as DataSource
    const ds = readOnlyDemo(base)
    await ds.digest()
    expect(calls).toEqual([{ peek: true }])
    await expect(ds.runCommand('nested.read', { input: {} })).rejects.toMatchObject({ status: 405 })
    expect(calls).toEqual([{ peek: true }])
  })
})

describe('connectApi', () => {
  /** 假时钟：探测按给定超时"耗时"，sleep 推进时间。 */
  function clock(results: boolean[]) {
    let t = 0
    const timeouts: number[] = []
    const retries: number[] = []
    const run = connectApi({
      now: () => t,
      sleep: async (ms) => void (t += ms),
      probe: async (_base, timeout) => {
        timeouts.push(timeout)
        const ok = results.shift() ?? false
        t += ok ? 20 : timeout
        return ok
      },
      onRetry: (n) => retries.push(n),
    })
    return { run, timeouts, retries, elapsed: () => t }
  }

  it('服务忙：前几次超时就放宽超时、退避重试，最后连上', async () => {
    const c = clock([false, false, true])
    await expect(c.run).resolves.toBe(true)
    expect(c.timeouts).toEqual([1500, 3000, 6000])
    expect(c.retries).toEqual([1, 2])
  })

  it('一直连不上：至少等满 10 秒才放弃', async () => {
    const c = clock([])
    await expect(c.run).resolves.toBe(false)
    expect(c.elapsed()).toBeGreaterThanOrEqual(10_000)
    expect(c.timeouts.length).toBeGreaterThanOrEqual(3)
  })

  it('立刻被拒绝（服务没启动）也重试多次，不在第一次失败时放弃', async () => {
    let t = 0
    let attempts = 0
    const ok = await connectApi({ now: () => t, sleep: async (ms) => void (t += ms), probe: async () => (attempts++, false) })
    expect(ok).toBe(false)
    expect(attempts).toBeGreaterThanOrEqual(5)
    expect(t).toBeGreaterThanOrEqual(10_000)
  })
})
