import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { initProject } from '@taktflow/core'
import { createServer, type RunningServer } from './index.js'

const roots: string[] = []; const servers: RunningServer[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function setup(workflows: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'takt-route-preview-')); roots.push(root)
  const stores = await initProject(root)
  stores.config.members = [{ id: 'alice', name: 'Alice', role: 'owner' }]
  await writeFile(join(root, 'takt.config.json'), JSON.stringify(stores.config))
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await symlink(resolve('node_modules'), join(root, 'node_modules'), 'dir')
  for (const [id, tiers] of Object.entries(workflows)) {
    await writeFile(join(stores.paths.workflows, `${id}.workflow.ts`), `import { defineWorkflow, human } from '@taktflow/core'\nexport default defineWorkflow({ id: '${id}', title: '${id}', version: '1', tiers: ${tiers}, stages: [], nodes: [human({ id: 'confirm', title: '确认', ask: '继续？', form: 'approve' })] })`)
  }
  const req = await stores.workspaces.createRequirement({ title: '需要处理一个新需求', owner: 'alice' })
  const server = await createServer({ projectDir: root, port: 0 }); servers.push(server)
  const request = async (path: string, value: unknown) => {
    const response = await fetch(server.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
    return { status: response.status, data: await response.json() as { error?: string } }
  }
  return { req, request }
}

it('空间没有流水线时路由预览返回 409 和可操作的原因，而不是 500', async () => {
  const { req, request } = await setup()
  for (const response of [await request('/api/route/preview', { text: '新用户体验测试\n背景：第一次使用' }), await request(`/api/requirements/${req.id}/route`, {})]) {
    expect(response.status).toBe(409)
    expect(response.data.error).toContain('这个空间还没有可用的流水线')
  }
})

it('没有流水线接得住该档位时同样是 409，并列出现有流水线支持的档位', async () => {
  const { request } = await setup({ 'chat-auto': "['T0', 'T1']" })
  const response = await request('/api/route/preview', { text: '需要处理一个新需求' })
  expect(response).toMatchObject({ status: 409, data: { error: expect.stringContaining('没有支持 T2 的流水线（现有：chat-auto 支持 T0/T1）') } })
  expect((await request('/api/route/preview', { text: '修复按钮文案错别字' })).status).toBe(200)
})
