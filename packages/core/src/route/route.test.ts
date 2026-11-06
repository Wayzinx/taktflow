import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { initProject } from '../store/project.js'
import type { Tier, WorkflowSnapshot } from '../types.js'
import { pathsOverlap, routeRequirement } from './index.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const by = { type: 'human', id: 'alice' } as const
const workflow = (id: string, tiers?: Tier[]): { id: string; snapshot: WorkflowSnapshot } => ({ id, snapshot: { id, title: id, version: '1', stages: [], tiers, nodes: [] } })
async function setup(title = '优化文案') {
  const root = await mkdtemp(join(tmpdir(), 'takt-route-')); roots.push(root)
  const stores = await initProject(root)
  const req = await stores.workspaces.createRequirement({ title })
  return { stores, requirementId: req.id, by, workflows: [workflow('quick-fix', ['T0', 'T1']), workflow('taktflow-standard', ['T2', 'T3'])] }
}
it.each([
  ['优化文案', 'T1'], ['只改 src/title.ts', 'T0'], ['```diff\n-a\n+b\n```', 'T0'],
  ['修改 src/a.ts 与 tests/a.ts', 'T2'], ['优化 src/a.ts 和 src/b.ts', 'T1'],
])('启发式按形状判档：%s', async (title, tier) => {
  const input = await setup(title)
  expect(await routeRequirement(input)).toMatchObject({ tier, workflowId: tier === 'T2' ? 'taktflow-standard' : 'quick-fix', decidedBy: by })
})
it('仓库名也计入改动面；hint 与标题合并', async () => {
  const input = await setup('优化 api')
  input.stores.config.repos = ['api', 'web'].map((id) => ({ id, path: id, defaultBranch: 'main' }))
  expect(await routeRequirement({ ...input, hint: '同步 web' })).toMatchObject({ tier: 'T2' })
})
it('路径冲突降 T2 并重新选择支持该档的流程，递归收集门禁和角色', async () => {
  const input = await setup()
  input.workflows[1]!.snapshot.nodes = [{ id: 'loop', kind: 'loop', title: '循环', needs: [], body: [
    { id: 'review', kind: 'review', title: '代码评审', needs: [], review: { author: 'dev', reviewers: [{ role: 'qa' }, { role: 'qa' }], arbiter: { role: 'arbiter' }, pass: 'all', maxRounds: 2, onExhausted: 'human', target: [] } },
    { id: 'gate', kind: 'gate', title: '校验', needs: [] }, { id: 'human', kind: 'human', title: '人工确认', needs: [] },
  ] }]
  const model = vi.fn(async () => ({ tier: 'T3', workflowId: 'quick-fix', reason: '并行', surfaces: [{ id: 'a', paths: ['src/**'] }, { id: 'b', paths: ['src/api/*.ts'] }] }))
  const result = await routeRequirement({ ...input, model })
  expect(result).toMatchObject({ tier: 'T2', workflowId: 'taktflow-standard', gates: ['代码评审', '校验', '人工确认'], roles: ['dev', 'qa', 'arbiter'] })
  expect(result.adjustments).toHaveLength(2)
  expect(model.mock.calls).toHaveLength(1)
})
it('不相交路径保持 T3；不同仓库的同名目录可以并行', async () => {
  const input = await setup()
  for (const surfaces of [[{ id: 'a', paths: ['api/**'] }, { id: 'b', paths: ['web/**'] }], [{ id: 'a', repo: 'api', paths: ['src/**'] }, { id: 'b', repo: 'web', paths: ['src/**'] }]]) {
    expect(await routeRequirement({ ...input, model: async () => ({ tier: 'T3', surfaces, reason: '独立' }) })).toMatchObject({ tier: 'T3' })
  }
  expect(pathsOverlap('src/a*', 'src/abc/**')).toBe(true)
  expect(pathsOverlap('other/../src/**', 'src/api/**')).toBe(true)
  expect(pathsOverlap('**', 'src/api/**')).toBe(true)
})
it('人工改档留痕且仍过路径校验；空路径不能证明可并行', async () => {
  const input = await setup()
  const result = await routeRequirement({ ...input, override: { tier: 'T3', reason: '并发试验' } })
  expect(result).toMatchObject({ tier: 'T2', overridden: { by, from: 'T1', reason: '并发试验' } })
  await expect(routeRequirement({ ...input, override: { tier: 'T0', reason: ' ' } })).rejects.toThrow('原因')
})
it('流程优先级：模型、显式档位、配置、标准、首个兼容流程', async () => {
  const input = await setup()
  const model = async () => ({ tier: 'T1', reason: '单面', surfaces: [], workflowId: 'chosen' })
  input.workflows.push(workflow('chosen'))
  expect((await routeRequirement({ ...input, model })).workflowId).toBe('chosen')
  input.stores.config.route = { defaultWorkflow: 'chosen' }
  expect((await routeRequirement(input)).workflowId).toBe('quick-fix')
  input.workflows = [workflow('first'), workflow('taktflow-standard'), workflow('chosen')]
  expect((await routeRequirement(input)).workflowId).toBe('chosen')
  input.stores.config.route = {}
  expect((await routeRequirement(input)).workflowId).toBe('taktflow-standard')
  input.workflows = [workflow('first')]
  expect((await routeRequirement(input)).workflowId).toBe('first')
})
it('非法模型结果、缺失需求、空流程、全部不支持都不生成虚假路由', async () => {
  const input = await setup()
  await expect(routeRequirement({ ...input, model: async () => ({ tier: 'T9', surfaces: [], reason: 'bad' }) })).rejects.toThrow('enum')
  await expect(routeRequirement({ ...input, workflows: [] })).rejects.toThrow('没有可用')
  await expect(routeRequirement({ ...input, requirementId: 'REQ-999' })).rejects.toThrow('需求不存在')
  await expect(routeRequirement({ ...input, workflows: [workflow('wrong', ['T3'])] })).rejects.toThrow('没有支持')
})
