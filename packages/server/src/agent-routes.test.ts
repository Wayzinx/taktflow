import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { initProject, parseFrontmatter, createEngine, defineWorkflow, agent, type AgentRoleView, type TaktConfig } from '@taktflow/core'
import { createServer } from './index.js'
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs() })
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'takt-agent-api-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true })); vi.stubEnv('TAKT_SECRETS_FILE', join(dir, 'keys.json'))
  const stores = await initProject(dir)
  const config: TaktConfig = { ...stores.config, members: [{ id: 'owner', name: 'Owner', role: 'owner' }, { id: 'member', name: 'Member', role: 'member' }], roles: { custom: { harness: 'mock' } }, plugins: ['./roles.mjs'], knowledgeBindings: [{ baseId: 'docs', scope: 'space', enabled: true, priority: 0 }] }
  await writeFile(join(dir, 'takt.config.json'), JSON.stringify(config))
  await writeFile(join(dir, 'roles.mjs'), `export default { name: 'roles', apiVersion: 1, roles: { plugin: '---\\ntitle: 插件\\nharness: mock\\n---\\n原插件正文\\n', fallback: '---\\ntitle: 默认\\n---\\n正文\\n' } }`)
  await writeFile(join(stores.paths.agents, 'custom.md'), '---\n# 原注释\ntitle: 原标题\nextra: { nested: true }\nknowledge: [docs]\nwriteScope: ["src/**"]\n---\n\n正文保留  \n\n')
  await mkdir(join(stores.paths.skills, 'git'), { recursive: true }); await writeFile(join(stores.paths.skills, 'git/SKILL.md'), '---\nname: git\n---\ngit')
  const server = await createServer({ projectDir: dir, port: 0 }); cleanups.push(() => server.close())
  const request = (path: string, method = 'GET', input?: unknown, user = 'owner') => fetch(server.url + path, { method, headers: { 'content-type': 'application/json', 'x-takt-user': user }, ...(input ? { body: JSON.stringify(input) } : {}) })
  const get = async (role: string) => (await request(`/api/space/agents/${role}`)).json() as Promise<AgentRoleView>
  const put = (role: string, input: object) => request(`/api/space/agents/${role}`, 'PUT', { reason: '测试角色', ...input })
  return { dir, stores, request, get, put }
}
it('三层来源、部分更新、键序和正文保留、null 删除、并发版本冲突与源码一致', async () => {
  const f = await fixture()
  const initial = await f.get('custom')
  expect(initial.effective).toEqual({ harness: { harness: 'mock' }, source: 'space-default' })
  expect((await f.get('fallback')).effective.source).toBe('builtin')
  expect((await f.get('dev')).origin).toBe('builtin')
  const response = await f.put('custom', { baseRevision: initial.revision, harness: { harness: 'mock' }, skills: ['git'] })
  expect(response.status).toBe(200)
  const saved = await response.json() as AgentRoleView
  expect(saved.effective.source).toBe('role'); expect(saved.revision).not.toBe(initial.revision)
  const content = await readFile(join(f.stores.paths.agents, 'custom.md'), 'utf8')
  expect(content).toContain('# 原注释'); expect(content.indexOf('title:')).toBeLessThan(content.indexOf('extra:'))
  expect(parseFrontmatter(content)).toMatchObject({ data: { extra: { nested: true } }, body: '\n正文保留  \n\n' })
  expect((await f.put('custom', { baseRevision: initial.revision, title: '旧客户端' })).status).toBe(409)
  const deleted = await f.put('custom', { baseRevision: saved.revision, harness: null, knowledge: null, readScope: null, allowBash: null })
  expect(deleted.status).toBe(200); expect((await deleted.json()).effective.source).toBe('space-default')
  expect(parseFrontmatter(await readFile(join(f.stores.paths.agents, 'custom.md'), 'utf8')).data).not.toHaveProperty('knowledge')
  const source = await (await f.request('/api/space/files?kind=agent&name=custom')).json()
  expect(source.content).toBe(await readFile(join(f.stores.paths.agents, 'custom.md'), 'utf8'))
  expect((await f.request('/api/space/agents/custom', 'PUT', { reason: '无权', title: '越权' }, 'member')).status).toBe(403)
})
it('插件首次保存复制原正文，覆盖后可删除，workflow 引用阻止删除', async () => {
  const f = await fixture()
  const original = await f.get('plugin'); expect(original.origin).toBe('plugin')
  const saved = await f.put('plugin', { baseRevision: original.revision, title: '覆盖' })
  expect(saved.status).toBe(200); expect(await saved.json()).toMatchObject({ origin: 'space', instructions: '原插件正文\n' })
  await writeFile(join(f.stores.paths.workflows, 'uses.workflow.ts'), `import { defineWorkflow, agent } from '@taktflow/core'\nexport default defineWorkflow({ id: 'uses', title: '引用', version: '1', stages: [], nodes: [agent({ id: 'work', title: '工作', role: 'plugin', harness: { harness: 'mock' }, prompt: 'hello' })] })`)
  expect((await f.get('plugin')).usedBy).toContainEqual({ workflowId: 'uses', workflowTitle: '引用', nodeId: 'work', harness: { harness: 'mock' } })
  const blocked = await f.request('/api/space/agents/plugin', 'DELETE', { reason: '删除' }); expect(blocked.status).toBe(409); expect((await blocked.json()).error).toContain('uses/work')
  await rm(join(f.stores.paths.workflows, 'uses.workflow.ts'))
  expect((await f.request('/api/space/agents/plugin', 'DELETE', { reason: '删除' })).status).toBe(204)
  expect((await f.get('plugin')).origin).toBe('plugin')
})
it('非法 role、scope、harness、model、技能与知识库返回字段错误', async () => {
  const f = await fixture()
  for (const [input, field] of [[{ harness: { harness: 'missing' } }, 'harness'], [{ harness: { harness: 'mock', model: 'missing-alias' } }, 'model'], [{ skills: ['missing'] }, 'skills'], [{ knowledge: ['missing'] }, 'knowledge'], [{ writeScope: ['/tmp/**'] }, 'writeScope'], [{ readScope: ['x/../**'] }, 'readScope']] as const) {
    const response = await f.put('custom', input); expect(response.status).toBe(400); expect((await response.json()).error).toContain(field)
  }
  expect((await f.put('Upper', { title: '非法' })).status).toBe(400)
  expect((await f.request('/api/space/agents/dev', 'DELETE', { reason: '删除内置' })).status).toBe(400)
})

it('保存角色按补全预设后的 provider 与协议桥判断搭配：预设入口直连、协议对不上经桥都能存', async () => {
  const f = await fixture()
  const config = JSON.parse(await readFile(join(f.dir, 'takt.config.json'), 'utf8')) as TaktConfig
  // 只写了 preset：Anthropic 入口来自预设，配置里没有
  await writeFile(join(f.dir, 'takt.config.json'), JSON.stringify({ ...config, providers: { deepseek: { preset: 'deepseek' } }, models: { ds: { id: 'deepseek-flash', provider: 'deepseek' } } }))
  for (const harness of ['claude-code', 'codex']) {
    const response = await f.put('custom', { harness: { harness, model: 'ds' } })
    expect(response.status, harness).toBe(200)
  }
})

it('在线编辑角色与运行中的写守卫兼容，源码入口同样只允许 owner', async () => {
  const f = await fixture()
  let release!: () => void, started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const running = createEngine({ stores: f.stores, profiles: {}, knowledge: [], harnesses: { mock: { id: 'mock', displayName: 'mock', available: async () => ({ ok: true }), run: async () => {
    started(); await new Promise<void>(resolve => { release = resolve }); return { ok: true, finalText: '完成' }
  } } } }).start({ requirementId: (await f.stores.workspaces.createRequirement({ title: '运行期间编辑' })).id,
    workflow: defineWorkflow({ id: 'guard', title: 'guard', version: '1', stages: [], nodes: [agent({ id: 'work', title: 'work', role: 'custom', prompt: 'test' })] }) })
  await ready
  try {
    expect((await f.put('custom', { title: '运行中编辑' })).status).toBe(200)
    expect((await f.request('/api/space/files?kind=agent&name=custom', 'PUT', { content: 'invalid', reason: '越权' }, 'member')).status).toBe(403)
  } finally { release() }
  expect((await running).status).toBe('succeeded')
})
