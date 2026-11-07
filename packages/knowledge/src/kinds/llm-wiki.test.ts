import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initProject, type AgentProfile, type HarnessAdapter } from '@taktflow/core'
import { createKnowledgeStore } from '../store/index.js'
import { createWikiKind } from './llm-wiki.js'
it('生成 Wiki 创建 task run、独立评审，发布前不写 content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-wiki-run-'))
  try {
    const stores = await initProject(root)
    stores.config.repos = [{ id: 'app', path: 'repo', defaultBranch: 'main' }]
    await mkdir(join(root, 'repo')); await writeFile(join(root, 'repo/app.ts'), 'export const app = 1')
    const profiles: Record<string, AgentProfile> = Object.fromEntries(['wiki-writer', 'reviewer'].map(role => [role, { role, title: role, description: '', instructions: '', skills: [], writeScope: ['**'], harness: { harness: 'mock' } }]))
    const harness: HarnessAdapter = { id: 'mock', displayName: 'mock', available: async () => ({ ok: true }), async run(req) {
      const id = req.env!.TAKT_NODE!, workspace = req.env!.TAKT_WORKSPACE!
      if (id === 'plan') return { ok: true, finalText: JSON.stringify({ items: [{ key: 'app', title: '应用模块' }] }), structured: { items: [{ key: 'app', title: '应用模块' }] } }
      if (req.systemAppend?.includes('评审') || id.includes('review')) return { ok: true, finalText: '', structured: { verdict: 'approve', summary: '通过', issues: [] } }
      await mkdir(join(workspace, 'generated'), { recursive: true })
      await writeFile(join(workspace, 'generated', id === 'index' ? 'index.md' : 'app.md'), id === 'index' ? '# 索引\n[应用](app.md)' : '# 应用\n应用模块职责')
      return { ok: true, finalText: '完成' }
    } }
    const kb = createKnowledgeStore(stores, { kinds: [createWikiKind(async () => ({ profiles, harnesses: { mock: harness } }))] }), by = { type: 'human' as const, id: 'test' }
    await kb.create({ id: 'wiki', name: 'wiki', kind: 'llm-wiki', config: { generate: { repo: 'app', granularity: 'module' } } }, by, '新建')
    const build = await kb.build('wiki', by, '生成')
    let current = build
    for (let i = 0; i < 500 && current.status === 'running'; i++) { await new Promise(r => setTimeout(r, 10)); current = (await kb.getBuild('wiki', build.id))! }
    expect(current.status, current.log.join('\n')).toBe('succeeded')
    expect(current.runId).toBeTruthy()
    expect(await stores.runs.get(current.runId!)).toMatchObject({ workflowId: 'kb-wiki-build', kind: 'task', status: 'succeeded' })
    await expect(readFile(join(root, 'knowledge/wiki/content/app.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    await kb.publish('wiki', { by, reason: '人工批准' })
    expect(await readFile(join(root, 'knowledge/wiki/content/app.md'), 'utf8')).toContain('模块职责')
  } finally { await rm(root, { recursive: true, force: true }) }
})
