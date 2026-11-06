import { describe, expect, it } from 'vitest'
import { checkCompletion, completionPrompt, completionSchema, resultSummary } from './completion.js'
import { validateSchema } from './schema.js'

describe('完成标准契约', () => {
  const criteria = ['测试必须全部通过', '提供可读取的证据']
  it.each([
    undefined,
    { checks: [] },
    { checks: [{ id: 'c1', criterion: criteria[0], pass: false, evidence: 'failed' }] },
    { checks: [{ id: 'c1', criterion: criteria[0], pass: true, evidence: '  ' }] },
    { checks: [1, null, { id: 'c1', pass: 'true' }] },
  ])('缺项、失败、空证据或畸形结果均不得通过：%j', (data) => {
    expect(checkCompletion(criteria, data).unmet).toEqual(['c1', 'c2'])
  })
  it('每条标准按 id 校验，不接受重复 id；schema 保留原字段要求', () => {
    const checks = criteria.map((criterion, index) => ({ id: `c${index + 1}`, criterion, pass: true, evidence: 'tests.log: PASS' }))
    expect(checkCompletion(criteria, { checks: checks.slice().reverse() }).unmet).toEqual([])
    expect(checkCompletion(criteria, { checks: checks.map((check) => ({ ...check, criterion: '不同措辞' })) }).unmet).toEqual([])
    expect(checkCompletion(criteria, { checks: [...checks, checks[0]] }).unmet).toEqual(['c1'])
    const schema = completionSchema({ type: 'object', required: ['done'], properties: { done: { type: 'boolean' } } }, criteria)!
    expect(() => validateSchema({ done: true, checks }, schema)).not.toThrow()
    expect(() => validateSchema({ checks }, schema)).toThrow('done')
    expect(() => validateSchema({ done: true }, schema)).toThrow('checks')
    expect(completionPrompt(criteria)).toContain('c2: 提供可读取的证据')
    expect(completionSchema(undefined)).toBeUndefined()
  })
  it('小结按字符截取 80 字，无结构化小结时取最终消息第一行', () => {
    expect(resultSummary({ summary: '测'.repeat(81) }, '')).toHaveLength(80)
    expect([...resultSummary({ summary: '😀'.repeat(81) }, '')]).toHaveLength(80)
    expect(resultSummary(undefined, '完成\n详情')).toBe('完成')
  })
})

it('真实存储回读 node.checks 并验证审计链（M3 事件接入回归）', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { initProject } = await import('../store/project.js')
  const { createEngine } = await import('./index.js')
  const root = await mkdtemp(join(tmpdir(), 'takt-m3-completion-store-'))
  try {
    const stores = await initProject(root)
    const requirementId = (await stores.workspaces.createRequirement({ title: '自检审计回读' })).id
    const checks = [{ id: 'c1', criterion: '测试必须全部通过', pass: true, evidence: 'test.log: passed' }]
    const state = await createEngine({ stores, knowledge: [], profiles: { dev: {
      role: 'dev', title: '开发', description: '', instructions: '', skills: [], writeScope: [], harness: { harness: 'mock' },
    } }, harnesses: { mock: { id: 'mock', displayName: 'mock', available: async () => ({ ok: true }), run: async () => ({ ok: true, finalText: '', structured: { checks } }) } } })
      .start({ requirementId, workflow: { id: 'checks', title: '自检', version: '1', stages: [], nodes: [
        { id: 'a', kind: 'agent', title: '实现', role: 'dev', prompt: '', completion: [checks[0]!.criterion] },
      ] } })
    expect(state.nodes.a?.status).toBe('succeeded')
    expect((await stores.events.read(state.runId, { types: ['node.checks'] }))[0]?.data).toEqual({ checks, unmet: [] })
    expect(await stores.events.verify(state.runId)).toEqual({ ok: true })
  } finally { await rm(root, { recursive: true, force: true }) }
})
