import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initProject, openProject, routeRequirement, snapshotWorkflow, type EventEnvelope } from '@taktflow/core'
import { createRunEngine, loadRuntime } from '../../packages/cli/src/project.js'
import workflow from './workflows/quick-fix.workflow.js'

const example = dirname(fileURLToPath(import.meta.url))
const root = process.env.TAKT_DEMO_DIR ? await mkdir(process.env.TAKT_DEMO_DIR, { recursive: true }).then(() => process.env.TAKT_DEMO_DIR as string) : await mkdtemp(join(tmpdir(), 'takt-quick-'))
for (const name of ['src', 'tests', 'package.json', 'agents', 'workflows', 'takt.config.json']) await cp(join(example, name), join(root, name), { recursive: true })
const config = JSON.parse(await readFile(join(root, 'takt.config.json'), 'utf8'))
config.project.name = '快速修复示例'
config.space = { ...config.space, id: 'quick-delivery' }
await writeFile(join(root, 'takt.config.json'), JSON.stringify(config, null, 2) + '\n')
await symlink(resolve('node_modules'), join(root, 'node_modules'), 'dir')
for (const args of [['init', '-b', 'main'], ['add', 'src', 'tests', 'package.json'], ['-c', 'user.name=Demo', '-c', 'user.email=demo@localhost', 'commit', '-m', '演示基线']]) execFileSync('git', args, { cwd: root, stdio: 'pipe' })
const stores = await initProject(root)
const req = await stores.workspaces.createRequirement({ title: '修复 src 模块空名字 bug', owner: 'demo-owner' })
const by = { type: 'human', id: 'demo-owner' } as const
await stores.workspaces.writeArtifact({ ref: { workspace: req.id, path: 'inputs/request.md' }, kind: 'input', author: by, content: 'src 模块支持空名字回退 stranger，保留普通名字行为。', reason: '原始需求' })
for (const [id, input, expected, ac] of [['TC-GREET-001', 'World', 'Hello, World!', 'AC-1'], ['TC-GREET-002', '', 'Hello, stranger!', 'AC-2']]) {
  await stores.workspaces.writeArtifact({ ref: { workspace: req.id, path: `cases/${id}.json` }, kind: 'case', author: by,
    content: JSON.stringify({ id, input, expected, covers: [ac] }), reason: '冻结业务用例' })
}
const script = { steps: [
  { match: { nodeId: 'spec' }, writes: { '{{workspace}}/spec/quick.md': '# 简短规格\nAC-1：名字原样问候。\nAC-2：空名字返回 stranger。',
    '{{workspace}}/cases/TC-GREET-001.json': JSON.stringify({ id: 'TC-GREET-001', input: 'World', expected: 'Hello, World!', covers: ['AC-1'] }),
    '{{workspace}}/cases/TC-GREET-002.json': JSON.stringify({ id: 'TC-GREET-002', input: '', expected: 'Hello, stranger!', covers: ['AC-2'] }) }, finalText: '规格已登记' },
  { match: { nodeId: 'implement' }, fail: '演示：相同输入下编译器不可用', times: 2 },
] }
await writeFile(join(root, '.takt/mock.json'), JSON.stringify(script))
const context = await loadRuntime(root)
const route = await routeRequirement({ stores: context.stores, requirementId: req.id, by, workflows: [{ id: workflow.id, snapshot: snapshotWorkflow(workflow) }] })
assert.equal(route.tier, 'T1'); assert.equal(route.workflowId, 'quick-fix')
const blocked = await createRunEngine(context, { harness: 'mock' }).start({ workflow, requirementId: req.id, route, args: { tier: route.tier } })
assert.equal(blocked.status, 'waiting_human')
assert.equal(blocked.nodes.implement?.status, 'blocked')
let reopened = await openProject(root)
const events = await reopened.events.read(blocked.runId)
assert.equal(events.filter((event) => event.type === 'retry.suppressed').length, 1)
const pending = (await reopened.attention.list({ pending: true })).find((item) => item.kind === 'retry')!
assert(pending)
assert.deepEqual(pending.choices, ['再试一次', '交给人处理', '终止运行'])
await reopened.attention.answer(pending.requestId, { decision: 'choice', answer: '再试一次', by })
await writeFile(join(root, '.takt/mock.json'), JSON.stringify({ steps: [
  { match: { nodeId: 'implement' }, writes: { 'src/greet.js': await readFile(join(example, 'fixtures/greet.fixed.js'), 'utf8'), '{{workspace}}/tasks/change.md': '空名字回退 stranger，待交付门禁执行冻结用例。' },
    structured: { summary: '已实现空名字回退', checks: [{ id: 'c1', criterion: '改动符合验收标准且自测结果有证据', pass: true, evidence: 'Mock 自检；tasks/change.md，真实测试随后由交付门禁运行' }] } },
  { match: { nodeId: 'review-code', role: 'reviewer' }, structured: { verdict: 'approve', summary: 'Mock 独立评审', issues: [] } },
  { match: { nodeId: 'delivery-check', role: 'verifier' }, structured: { pass: true, score: 100, message: 'Mock 独立复核；逐条证据由 acceptance 确定性校验' } },
] }))
const resumed = await createRunEngine(await loadRuntime(root), { harness: 'mock' }).resume(blocked.runId, workflow)
reopened = await openProject(root)
const saved = (await reopened.runs.get(resumed.runId))!
assert.equal(saved.status, 'succeeded', JSON.stringify(saved.nodes))
const gate = (await reopened.events.read(saved.runId)).filter((event) => event.type === 'gate.result').at(-1) as EventEnvelope<'gate.result'>
assert(gate.data.pass && gate.data.checks.every((check) => check.pass))
assert.deepEqual(await reopened.events.verify(saved.runId), { ok: true })
assert.equal(JSON.parse((await reopened.workspaces.readArtifact({ workspace: req.id, path: 'evidence/TC-GREET-002/result.json' }))!.toString()).actual, 'Hello, stranger!')
console.log(`PASS T1 自动路由 quick-fix；同样失败两次停止并生成待办；人工再试后完成独立评审、真实测试与交付校验。\n证据目录：${root}`)

// T0 的改动与验收输入已给定，只执行实现和校验。
const t0 = await reopened.workspaces.createRequirement({ title: '给定 diff：空名字回退 stranger', owner: 'demo-owner' })
for (const artifact of await reopened.workspaces.listArtifacts(req.id)) {
  if (!/^(inputs|spec|cases)\//.test(artifact.path)) continue
  await reopened.workspaces.writeArtifact({ ref: { workspace: t0.id, path: artifact.path }, kind: artifact.kind, author: by,
    content: (await reopened.workspaces.readArtifact({ workspace: req.id, path: artifact.path }))!, reason: '给定 T0 验收输入' })
}
const t0State = await createRunEngine(await loadRuntime(root), { harness: 'mock' }).start({ workflow, requirementId: t0.id, args: { tier: 'T0', testCommand: 'exit 99' } })
assert.equal(t0State.status, 'succeeded', JSON.stringify(t0State.nodes))
assert.equal(t0State.nodes.spec?.status, 'skipped')
assert.equal(t0State.nodes['review-code']?.status, 'skipped')
assert.equal(t0State.nodes['delivery-check']?.status, 'succeeded')
console.log('PASS T0 预置 spec/cases；跳过 spec 与代码评审；真实测试和交付校验通过；运行参数不能替换测试命令。')
