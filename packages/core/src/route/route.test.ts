import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { initProject } from '../store/project.js'
import type { Tier, WorkflowSnapshot } from '../types.js'
import { pathsOverlap, routeRequirement, RouteUnavailableError } from './index.js'

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
  ['修复按钮文案错别字', 'T1'], ['只改 src/title.ts', 'T1'], ['```diff\n-a\n+b\n```', 'T0'], ['typo in the rapid build guide', 'T1'],
  ['修改 src/a.ts 与 tests/a.ts', 'T2'], ['优化 src/a.ts 和 src/b.ts', 'T2'], ['范围还不清楚', 'T2'],
])('启发式按形状判档：%s', async (title, tier) => {
  const input = await setup(title)
  expect(await routeRequirement(input)).toMatchObject({ tier, workflowId: tier === 'T2' ? 'taktflow-standard' : 'quick-fix', decidedBy: by })
})
it('“改成 / 只改”不再直接判 T0：跨前端、接口、数据的改造走标准流程', async () => {
  const input = await setup()
  const draft = (title: string) => routeRequirement({ ...input, draft: { title }, requirementId: undefined })
  await expect(draft('重构订单模块：前端页面改成分步表单，新增后端接口和数据库表结构迁移')).resolves.toMatchObject({
    tier: 'T2', workflowId: 'taktflow-standard', surfaces: [{ id: 'frontend' }, { id: 'api' }, { id: 'data' }] })
  await expect(draft('问候语空名字文案改成 friend')).resolves.toMatchObject({ tier: 'T1', workflowId: 'quick-fix' })
})
it('T0 只认给定的补丁：补丁里的文件算改动面，+/- 行的词不算；跨多面的补丁不是 T0', async () => {
  const input = await setup()
  const draft = (title: string, description?: string) => routeRequirement({ ...input, draft: { title, description }, requirementId: undefined })
  const one = '空名字回退 stranger\n```diff\ndiff --git a/src/greet.js b/src/greet.js\n--- a/src/greet.js\n+++ b/src/greet.js\n@@ -1 +1 @@\n-  return `Hello, ${name}!` // 前端按钮接口\n+  return `Hello, ${name || \'stranger\'}!`\n```'
  await expect(draft('空名字回退', one)).resolves.toMatchObject({ tier: 'T0', workflowId: 'quick-fix', surfaces: [{ id: 'src', paths: ['src/**'] }] })
  await expect(draft('同步两端', '```patch\n--- a/web/a.ts\n+++ b/web/a.ts\n--- a/api/b.ts\n+++ b/api/b.ts\n```')).resolves.toMatchObject({ tier: 'T2' })
  await expect(draft('前端页面和后端接口一起改', '```diff\n--- a/src/a.ts\n+++ b/src/a.ts\n```')).resolves.toMatchObject({ tier: 'T2' })
  await expect(draft('diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n-a\n+b')).resolves.toMatchObject({ tier: 'T0' })
  await expect(draft('调整代码', 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n-a\n+b\n前端页面和后端接口一起改')).resolves.toMatchObject({ tier: 'T2' })
})
it('空补丁标记、过大的补丁和同目录多个文件的补丁不能跳过需求说明与代码评审', async () => {
  const input = await setup()
  const draft = (description: string) => routeRequirement({ ...input, draft: { title: '调整代码', description }, requirementId: undefined })
  for (const patch of ['```diff\n```', 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts',
    '```diff\n' + Array.from({ length: 41 }, (_, index) => `+line${index}`).join('\n') + '\n```',
    '```diff\n--- a/src/a.ts\n+++ b/src/a.ts\n-a\n+b\n--- a/src/b.ts\n+++ b/src/b.ts\n-c\n+d\n```']) {
    expect((await draft(patch)).tier).not.toBe('T0')
  }
})
it('路由模型漏报改动面也不能把跨前端、接口、数据的补丁改造判成 T0 / T1', async () => {
  const input = await setup()
  for (const tier of ['T0', 'T1'] as const) {
    await expect(routeRequirement({ ...input, draft: { title: '前端页面改成分步表单，新增后端接口和数据库表结构迁移',
      description: '```diff\n--- a/src/a.ts\n+++ b/src/a.ts\n-a\n+b\n```' }, requirementId: undefined,
      model: async () => ({ tier, reason: '单面', surfaces: [] }) })).resolves.toMatchObject({ tier: 'T2', workflowId: 'taktflow-standard' })
  }
})
it('路由模型给出的 T0 / T1 和人工改档都不能绕过补丁与改动面校验', async () => {
  const input = await setup()
  const surfaces = [{ id: 'frontend', paths: [] }, { id: 'api', paths: [] }, { id: 'data', paths: [] }]
  const wide = await routeRequirement({ ...input, model: async () => ({ tier: 'T0', reason: '已写死', surfaces }) })
  expect(wide).toMatchObject({ tier: 'T2', workflowId: 'taktflow-standard', adjustments: ['T0 只适用于单一改动面，这次涉及 3 个，改为 T2'] })
  const unpatched = await routeRequirement({ ...input, model: async () => ({ tier: 'T0', reason: '已写死', surfaces: [] }) })
  expect(unpatched).toMatchObject({ tier: 'T1', workflowId: 'quick-fix', adjustments: ['需求里没有给出单文件小补丁，T0 改为 T1'] })
  await expect(routeRequirement({ ...input, model: async () => ({ tier: 'T1', reason: '单面', surfaces: surfaces.slice(0, 2) }) })).resolves.toMatchObject({ tier: 'T2' })
  await expect(routeRequirement({ ...input, override: { tier: 'T0', reason: '补丁已在评审系统里过审' } })).resolves.toMatchObject({ tier: 'T1', workflowId: 'quick-fix' })
  await expect(routeRequirement({ ...input, model: async () => ({ tier: 'T2', reason: '多面', surfaces }),
    override: { tier: 'T0', reason: '强制轻量' } })).resolves.toMatchObject({ tier: 'T2' })
})
it('草稿路由与关键词改动面一致，关键词并行不能证明 T3', async () => {
  const input = await setup()
  await expect(routeRequirement({ ...input, draft: { title: '导出订单报表支持按部门筛选（前端加多选、接口加参数）' }, requirementId: undefined })).resolves.toMatchObject({ tier: 'T2' })
  await expect(routeRequirement({ ...input, draft: { title: '前端和接口分别并行' }, requirementId: undefined })).resolves.toMatchObject({ tier: 'T2' })
  await expect(routeRequirement({ ...input, draft: { title: 'foo/src/a.ts 与 bar/src/a.ts 独立并行' }, requirementId: undefined })).resolves.toMatchObject({ tier: 'T3' })
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
    { id: 'gate', kind: 'gate', title: '校验', needs: [], checks: [{ id: 'acceptance', kind: 'acceptance', role: 'verifier' }] }, { id: 'human', kind: 'human', title: '人工确认', needs: [] },
  ] }]
  const model = vi.fn(async () => ({ tier: 'T3', workflowId: 'quick-fix', reason: '并行', surfaces: [{ id: 'a', paths: ['src/**'] }, { id: 'b', paths: ['src/api/*.ts'] }] }))
  const result = await routeRequirement({ ...input, model })
  expect(result).toMatchObject({ tier: 'T2', workflowId: 'taktflow-standard', gates: ['代码评审', '校验', '人工确认'], roles: ['dev', 'qa', 'arbiter', 'verifier'] })
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
  await expect(routeRequirement({ ...input, model: async () => ({ tier: 'T9', surfaces: [], reason: 'bad' }) })).rejects.toThrow('取值须为')
  await expect(routeRequirement({ ...input, workflows: [] })).rejects.toThrow(RouteUnavailableError)
  await expect(routeRequirement({ ...input, workflows: [] })).rejects.toThrow('这个空间还没有可用的流水线')
  await expect(routeRequirement({ ...input, requirementId: 'REQ-999' })).rejects.toThrow('需求不存在')
  await expect(routeRequirement({ ...input, workflows: [workflow('wrong', ['T3'])] })).rejects.toThrow('没有支持 T1 的流水线（现有：wrong 支持 T3）')
})

it('路由模型错误结构走统一修正，原始 JSON 也能通过', async () => {
  const input = await setup()
  const prompts: string[] = []
  const result = await routeRequirement({ ...input, model: async prompt => {
    prompts.push(prompt)
    return prompts.length === 1 ? { tier: 'BAD', reason: '错误', surfaces: [] } : JSON.stringify({ tier: 'T1', reason: '小改', surfaces: [] })
  } })
  expect(result.tier).toBe('T1')
  expect(prompts).toHaveLength(2)
  expect(prompts[1]).toContain('$.tier：取值须为 T0 / T1 / T2 / T3 之一')
})
