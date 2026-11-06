import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { initProject, listDefects, listEvalCases, openProject } from '@taktflow/core'
import { main } from './index.js'
import { createRunEngine, loadRuntime } from './project.js'
import { createProjectLead } from './lead.js'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function cli(root: string, args: string[], expectedCode = 0) {
  const chunks: string[] = []
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { chunks.push(String(chunk)); return true })
  try {
    const code = await main([...args, '--project', root, '--json'])
    const data = JSON.parse(chunks.join(''))
    expect(code, JSON.stringify(data)).toBe(expectedCode)
    return data
  } finally { spy.mockRestore() }
}

it('正式 CLI 入口解析 eval/defect 全部子命令，共享命令等待后台结果，Lead 可查成绩单', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-eval-wiring-cli-')); roots.push(root)
  const stores = await initProject(root)
  stores.config.workflows = []
  await writeFile(join(root, 'takt.config.json'), JSON.stringify(stores.config))
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  for (const role of ['dev', 'auditor', 'evaluator', 'lead']) await writeFile(join(stores.paths.agents, `${role}.md`),
    `---\nrole: ${role}\nharness: { harness: mock, model: ${role === 'evaluator' ? 'judge' : 'tested'} }\nwriteScope: ['**']\n---\n${role}`)
  await writeFile(join(stores.paths.workflows, 'flow.workflow.ts'), `export default { id: 'flow', title: '接线', version: '1', stages: [], nodes: [{ id: 'write', kind: 'agent', title: '规格', role: 'dev', prompt: '写规格', outputs: [{ path: 'spec.md', kind: 'spec' }] }] }`)
  const mockFile = join(root, 'eval-mock.json')
  await writeFile(mockFile, JSON.stringify({ steps: [
    { match: { role: 'lead' }, structured: { reply: '查询成绩单', actions: [{ type: 'command', id: 'eval.scorecards', input: { by: 'node', workflowId: 'flow' } }] } },
    { match: { role: 'dev' }, writes: { '{{workspace}}/spec.md': 'AC-1：边界说明' }, finalText: '规格已登记' },
    { match: { role: 'auditor' }, structured: { introducedAt: { origin: 'implementation', nodeId: 'write', evidence: ['spec.md 的边界说明不完整'] }, missedBy: [], confidence: 0.9, suggestions: [] } },
    { match: { role: 'evaluator' }, structured: { checks: [{ id: 'c1', criterion: '不得引入：遗漏边界', pass: true, evidence: 'mock 核对冻结产物 spec.md' }], score: 100, reason: 'mock 判分' } },
  ] }))
  const context = await loadRuntime(root, { mock: mockFile })
  const req = await stores.workspaces.createRequirement({ title: '评测接线' })
  const seed = await createRunEngine(context).start({ requirementId: req.id, workflow: context.workflows[0]! })
  expect(seed.status).toBe('succeeded')
  expect(await cli(root, ['defect', 'report', req.id, '--title', '边界缺失', '--desc', '遗漏边界', '--severity', 'major', '--ac', 'AC-1', '--ac', 'AC-2', '--evidence', 'spec.md', '--evidence', 'log.txt', '--link', 'https://example.org/1', '--link', 'https://example.org/2'])).toMatchObject({ id: 'D-1', status: 'open', acs: ['AC-1', 'AC-2'], evidence: ['spec.md', 'log.txt'], links: [{ type: 'url', url: 'https://example.org/1' }, { type: 'url', url: 'https://example.org/2' }] })
  expect(await cli(root, ['defect', 'attribute', req.id, 'D-1', '--mock', mockFile])).toMatchObject({ status: 'attributed' })
  expect(await cli(root, ['defect', 'confirm', req.id, 'D-1', '--note', '人工核验'])).toMatchObject({ status: 'confirmed', attribution: { confirmed: { note: '人工核验' } } })
  expect(await cli(root, ['eval', 'scorecards', '--by', 'recipe', '--workflow', 'flow'])).toMatchObject([{ escapes: 1 }])
  expect(await cli(root, ['eval', 'collect', '--target', 'node:flow/write', '--defects'])).toHaveProperty('added')
  expect(await listEvalCases(await openProject(root))).toHaveLength(1)
  const variants = [{ id: 'baseline', label: '基线' }, { id: 'candidate', label: '候选', harness: { harness: 'mock', model: 'candidate' } }]
  const evaluated = await cli(root, ['eval', 'run', 'node:flow/write', '--variant', JSON.stringify(variants[0]), '--variant', JSON.stringify(variants[1]), '--judge', '{"harness":"mock","model":"judge"}', '--mock', mockFile])
  expect(evaluated).toMatchObject({ status: 'done', results: [{ pass: true }, { pass: true }] })
  expect(evaluated.variants).toHaveLength(2)
  expect(await cli(root, ['eval', 'show', evaluated.id])).toMatchObject({ id: evaluated.id, status: 'done' })
  const specs = await cli(root, ['cmd', 'ls'])
  expect(specs.map((spec: { id: string }) => spec.id)).toEqual(expect.arrayContaining(['eval.run', 'defect.confirm']))
  const viaCommand = await cli(root, ['cmd', 'eval.run', '--input', JSON.stringify({ target: { kind: 'node', workflowId: 'flow', nodeId: 'write' }, variants: [variants[0]], judge: { harness: 'mock', model: 'judge' } }), '--reason', '验证共享命令', '--mock', mockFile])
  expect(viaCommand).toMatchObject({ ok: true, result: { status: 'done', results: [{ pass: true }] } })
  await cli(root, ['cmd', 'defect.report', '--input', JSON.stringify({ requirementId: req.id, title: '再次复现', description: '遗漏边界', severity: 'minor' }), '--reason', '检查命令归因'])
  expect(await cli(root, ['cmd', 'defect.attribute', '--input', JSON.stringify({ requirementId: req.id, defectId: 'D-2' }), '--reason', '只读归因', '--mock', mockFile])).toMatchObject({ ok: true, result: { status: 'attributed' } })
  const persisted = (await listDefects(await openProject(root), req.id)).find((defect) => defect.id === 'D-2')!
  expect(persisted.status).toBe('attributed'); expect(persisted.attributing).toBeUndefined()
  const failedMock = join(root, 'failed-auditor.json')
  await writeFile(failedMock, JSON.stringify({ steps: [{ match: { role: 'auditor' }, fail: '归因模型不可用' }] }))
  const failed = await cli(root, ['cmd', 'defect.attribute', '--input', JSON.stringify({ requirementId: req.id, defectId: 'D-2' }), '--reason', '重新归因', '--mock', failedMock], 1)
  expect(failed).toMatchObject({ ok: false, message: '缺陷归因失败，详情见缺陷审计日志' })
  expect(failed.result.attribution.at).toBe(persisted.attribution!.at)
  const lead = await createProjectLead(await loadRuntime(root, { mock: mockFile }))
  const message = await stores.chat.post(req.id, { author: { type: 'human', id: 'local' }, kind: 'text', text: '@lead 查询成绩单', mentions: ['lead'] })
  const turn = await lead.onMessage(req.id, message); await lead.drain()
  expect(turn?.results).toMatchObject([{ action: 'command', ok: true }])
  expect(turn!.results[0]!.message).toContain('escapes')
}, 20000)
