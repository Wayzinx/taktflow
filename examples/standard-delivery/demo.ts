import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEngine, initProject, listReviews, listSkills, loadProfiles, openProject, reviewDetail, type EventEnvelope, type EventType } from '@taktflow/core'
import { createMockHarness, loadMockScript } from '@taktflow/harness'
import workflow from './workflows/taktflow-standard.workflow.js'

const example = dirname(fileURLToPath(import.meta.url))
const root = await mkdtemp(join(tmpdir(), 'takt-standard-delivery-'))
// 每次使用独立的新布局空间，证据保留在打印的目录，不修改示例源码或其他运行。
for (const name of ['agents', 'workflows', 'skills', 'knowledge', 'requirements', 'fixtures', 'src', 'tests', 'package.json', 'takt.config.json', 'mock.json']) {
  await cp(join(example, name), join(root, name), { recursive: true })
}
console.log(`演示空间与持久化证据：${root}`)
const stores = await initProject(root)
assert.equal(stores.paths.requirements, join(root, 'requirements'))
const req = await stores.workspaces.createRequirement({ title: '问候语支持空名字：标准评审演示', owner: 'demo-owner' })
await stores.workspaces.writeArtifact({ ref: { workspace: req.id, path: 'inputs/prd.md' }, kind: 'input', content: await readFile(join(root, 'fixtures/prd.md')), author: { type: 'human', id: 'demo-owner' }, reason: '导入演示物料' })
const profiles = await loadProfiles(stores.paths)
const mock = createMockHarness(await loadMockScript(join(root, 'mock.json')))
const engine = createEngine({ stores, profiles, harnesses: { mock }, knowledge: [] }, { concurrency: 2, harnessOverride: 'mock', autoApprove: true })
const returned = await engine.start({ workflow, requirementId: req.id })
const reopened = await openProject(root)
const state = (await reopened.runs.get(returned.runId))!
assert.equal(state.status, 'succeeded', JSON.stringify(Object.values(state.nodes).filter((node) => node.error), null, 2))
const events = await reopened.events.read(state.runId)
function ofType<T extends EventType>(type: T, nodeId?: string): EventEnvelope<T>[] {
  return events.filter((event) => event.type === type && (nodeId === undefined || event.nodeId === nodeId)) as EventEnvelope<T>[]
}
assert.deepEqual(ofType('review.round', 'review-prd').map((event) => [event.data.round, event.data.passed]), [[1, false], [2, true]])
assert.equal(ofType('review.response', 'review-prd').length, 1)
assert.deepEqual(ofType('review.round', 'review-design').map((event) => [event.data.round, event.data.passed]), [[1, false], [2, false], [3, false], [1, true]])
assert.equal(ofType('review.exhausted', 'review-design').length, 1)
assert.equal(ofType('rework.started', 'review-design').length, 1)
assert.equal(state.nodes.design?.reworks, 1)
assert.deepEqual(ofType('review.round', 'implement/greet-core/review-code').map((event) => [event.data.round, event.data.passed]), [[1, true]])
assert.equal(state.nodes['dev-test-loop']?.iteration, 2)
const executions = ofType('node.finished', 'dev-test-loop/run-cases')
assert.equal(executions.length, 2)
assert.equal((executions[0]!.data.result as { failures: unknown[] }).failures.length, 1)
assert.equal((executions[1]!.data.result as { failures: unknown[] }).failures.length, 0)
assert.equal(ofType('judge.verdict').length, 1)
assert.equal(ofType('judge.verdict')[0]!.data.verdicts[0]!.category, 'product_bug')
assert(ofType('node.finished', 'dev-test-loop/fix-code').some((event) => event.data.status === 'succeeded'))
assert.equal(ofType('review.round', 'dev-test-loop/review-fix').length, 1)
assert.deepEqual(await reopened.events.verify(state.runId), { ok: true })
assert.deepEqual(await reopened.workspaces.detectUntracked(req.id), [])
const artifacts = await reopened.workspaces.listArtifacts(req.id)
for (const nodeId of new Set(ofType('review.round').map((event) => event.nodeId!))) {
  const detail = await reviewDetail(reopened, state.runId, nodeId)
  assert.equal(detail?.rounds.length, ofType('review.round', nodeId).length, `${nodeId} 的评审记录不完整`)
  assert(artifacts.some((artifact) => artifact.path === `reviews/${nodeId}/summary.md` && artifact.kind === 'review'))
  const summary = (await reopened.workspaces.readArtifact({ workspace: req.id, path: `reviews/${nodeId}/summary.md` }))!.toString()
  assert(summary.includes('第 1 轮'))
}
assert(artifacts.find((artifact) => artifact.path === 'spec/prd.md')!.versions.length >= 2)
assert.equal((await listReviews(reopened, req.id)).find((review) => review.nodeId === 'review-design')?.reworks, 1)
const messages = await reopened.chat.list(req.id)
assert(messages.some((message) => message.kind === 'system' && message.text === '需求已创建'))
assert(messages.some((message) => message.kind === 'system' && message.text === '运行开始'))
assert(messages.some((message) => message.kind === 'system' && message.text === '运行结束：succeeded'))
assert.equal(messages.filter((message) => message.kind === 'progress').length, ofType('review.round').length)
assert(messages.some((message) => message.text.startsWith('打回重做：')))
for (const event of ofType('human.requested')) assert(messages.some((message) => message.kind === 'attention' && message.refs?.requestId === event.data.requestId))
assert.equal((await reopened.chat.getRoom(req.id))?.members.length, 2)
assert.equal((await listSkills(reopened.paths.skills))[0]?.name, 'greeting')
const evidence = JSON.parse((await reopened.workspaces.readArtifact({ workspace: req.id, path: 'evidence/TC-GREET-002/result.json' }))!.toString())
assert.equal(evidence.actual, 'Hello, stranger!')
assert.equal(evidence.status, 'passed')
console.log('PASS 新布局与群聊；PRD 修改后第 2 轮通过；系分 3 轮耗尽、打回一次后通过；代码与脚本评审；真实用例失败 → 判决 → 修复 → 第 2 轮通过；评审记录完整；审计链与产物登记通过。')
console.log(`运行 ID：${state.runId}\n记录：${stores.workspaces.dir(req.id)}/reviews/\n事件：${root}/.takt/runs/${state.runId}/events.jsonl`)
