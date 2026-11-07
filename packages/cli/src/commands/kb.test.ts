import { expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { initProject } from '../../../core/src/store/project.js'
import { createKnowledgeStore } from '../../../knowledge/src/store/index.js'
import { runKbCommand } from './kb.js'
it('CLI 入口创建、上传、等待构建、发布、查询、关闭绑定', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-kb-cli-'))
  const output: string[] = [], write = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output.push(String(chunk)); return true })
  try {
    const stores = await initProject(root), kb = createKnowledgeStore(stores)
    await runKbCommand(root, 'new', [], { kind: 'rag', name: '规则', json: true })
    const base = (await kb.list())[0]!
    const file = join(root, 'refund.md'); await writeFile(file, '# 退款\n七天退款')
    await runKbCommand(root, 'upload', [base.id, file], { json: true })
    await runKbCommand(root, 'build', [base.id], { wait: true, json: true })
    await runKbCommand(root, 'publish', [base.id], { reason: '批准', json: true })
    output.length = 0
    vi.stubEnv('TAKT_NODE_ID', 'test-node'); vi.stubEnv('TAKT_ROLE', 'dev'); vi.stubEnv('TAKT_REQ', 'req-cli')
    await runKbCommand(root, 'query', ['退款'], { base: base.id, top: 1, json: true })
    expect(JSON.parse(output.join(''))).toMatchObject({ hits: [{ baseId: base.id, version: 1, ref: 'refund.md#0' }] })
    const record = JSON.parse((await readFile(join(stores.taktDir, 'knowledge/queries.jsonl'), 'utf8')).trim())
    expect(record).toMatchObject({ queryId: JSON.parse(output.join('')).queryId, nodeId: 'test-node', role: 'dev', requirementId: 'req-cli', via: 'tool' })
    await runKbCommand(root, 'bind', [base.id], { off: true, json: true })
    expect((await kb.bindings())[0]?.enabled).toBe(false)
  } finally { vi.unstubAllEnvs(); write.mockRestore(); await rm(root, { recursive: true, force: true }) }
})
