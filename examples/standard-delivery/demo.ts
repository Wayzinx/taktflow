import { createShopFixture } from './fixtures/create-shop.js'
import { demoKnowledge } from './demo-knowledge.js'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRepoManager } from '@taktflow/sandbox'
import { cp, mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createQualityDefect, updateQualityDefect, addEvalSample, decideCheckpointMiss, nodeQuality, snapshotMaterials, syncQuality, verifyQuality, precheckDefect, attributeDefectCheckpoints, confirmDefect, listDefects, listEvalCases, scorecards, createEngine, initProject, qualityMetrics, listReviews, listSkills, loadProfiles, openProject, reviewDetail, type EventEnvelope, type EventType } from '@taktflow/core'
import { createMockHarness, loadMockScript } from '@taktflow/harness'
import workflow from './workflows/taktflow-standard.workflow.js'

const example = dirname(fileURLToPath(import.meta.url))
// TAKT_DEMO_DIR：把演示数据留在指定目录（需不存在或为空），便于用 takt serve 查看
const root = process.env.TAKT_DEMO_DIR ? await mkdir(process.env.TAKT_DEMO_DIR, { recursive: true }).then(() => process.env.TAKT_DEMO_DIR as string) : await mkdtemp(join(tmpdir(), 'takt-standard-delivery-'))
// 每次使用独立的新布局空间，证据保留在打印的目录，不修改示例源码或其他运行。
for (const name of ['agents', 'workflows', 'skills', 'docs', 'knowledge', 'requirements', 'fixtures', 'src', 'tests', 'package.json', 'takt.config.json', 'mock.json']) {
  await cp(join(example, name), join(root, name), { recursive: true })
}
for (const args of [['init', '-b', 'main'], ['add', 'src', 'tests', 'package.json'], ['-c', 'user.name=Demo', '-c', 'user.email=demo@localhost', 'commit', '-m', '演示基线']]) execFileSync('git', args, { cwd: root, stdio: 'pipe' })
console.log(`演示空间与持久化证据：${root}`)
process.env.TAKT_KB_DEMO_SHOP_DB = await createShopFixture(root)
const stores = await initProject(root)
await demoKnowledge(stores)
assert.equal(stores.paths.requirements, join(root, 'requirements'))
const req = await stores.workspaces.createRequirement({ title: '问候语支持空名字：标准评审演示', owner: 'demo-owner' })
await stores.workspaces.writeArtifact({ ref: { workspace: req.id, path: 'inputs/prd.md' }, kind: 'input', content: await readFile(join(root, 'fixtures/prd.md')), author: { type: 'human', id: 'demo-owner' }, reason: '导入演示物料' })
const profiles = await loadProfiles(stores.paths)
const mock = createMockHarness(await loadMockScript(join(root, 'mock.json')))
const engine = createEngine({ stores, profiles, harnesses: { mock }, knowledge: [], repos: createRepoManager({ projectDir: root, taktDir: stores.taktDir, repos: stores.config.repos ?? [] }), skillsDir: stores.paths.skills }, { concurrency: 2, harnessOverride: 'mock', autoApprove: true })
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
assert(state.nodes['implement/greet-core/code']?.worktree)
assert(state.nodes['integration']?.status === 'succeeded')
assert.equal(ofType('worktree.created').length, 2)
assert.deepEqual(await reopened.events.verify(state.runId), { ok: true })
assert.deepEqual(await reopened.workspaces.detectUntracked(req.id), [])
const artifacts = await reopened.workspaces.listArtifacts(req.id)
for (const nodeId of new Set(ofType('review.round').map((event) => event.nodeId!))) {
  const detail = await reviewDetail(reopened, state.runId, nodeId)
  assert.equal(detail?.rounds.length, ofType('review.round', nodeId).length, `${nodeId} 的评审记录不完整`)
  assert(artifacts.some((artifact) => artifact.path === `reviews/${nodeId}/summary.md` && artifact.kind === 'review'))
  const summary = (await reopened.workspaces.readArtifact({ workspace: req.id, path: `reviews/${nodeId}/summary.md` }))!.toString()
  assert(summary.includes('第 1 轮'))
  assert(detail?.facets)
  assert(detail.rounds.every((round) => round.revision && round.seq && round.targetFingerprint))
}
assert(artifacts.find((artifact) => artifact.path === 'spec/prd.md')!.versions.length >= 2)
assert.equal((await listReviews(reopened, req.id)).find((review) => review.nodeId === 'review-design')?.reworks, 1)
const design = await reviewDetail(reopened, state.runId, 'review-design')
assert.equal(design?.rounds.at(-1)?.revision, 2)
assert.equal(design?.rounds.at(-1)?.round, 1)
assert(ofType('node.checks').length >= 7)
assert(ofType('node.checks').every((event) => event.data.unmet.length === 0))
assert(ofType('gate.result', 'delivery-check').some((event) => event.data.pass && event.data.checks.some((check) => check.id === 'acceptance' && check.pass)))
const quality = await qualityMetrics(events, { store: reopened.workspaces, requirementId: req.id })
assert(quality.verified > 0 && quality.intercepted > 0)
console.log('M3 校验：评审修订 2 / 第 1 轮、自检、独立交付校验、质量计数', quality)
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

// 故意种入的 trim 错误逃过原来的两条用例；这里执行未覆盖输入，留下真实失败证据。
const integration = state.nodes.integration!.result as { path: string }
const reproduction = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
  'import { greet } from "./src/greet.js"; process.stdout.write(JSON.stringify({ input: " Alice ", actual: greet(" Alice ") }))'],
  { cwd: integration.path, encoding: 'utf8' })) as { input: string; actual: string }
const expected = `Hello, ${reproduction.input}!`
assert.notEqual(reproduction.actual, expected)
const actor = { type: 'human', id: 'demo-owner' } as const
const escapeEvidence = await reopened.workspaces.writeArtifact({ ref: { workspace: req.id, path: 'evidence/TC-GREET-ESCAPE/result.json' },
  content: JSON.stringify({ ...reproduction, expected, status: 'failed' }), kind: 'evidence', author: actor, reason: '交付后独立检查未覆盖输入' })
const defect = await createQualityDefect(reopened, req.id, { title: '演示逃逸缺陷：非空名字两侧空格被删除',
  description: 'src/greet.js 的 name.trim() 删除了非空名字两侧空格，违反 PRD 保持现有行为、不做 trim 的约束。',
  severity: 'major', acs: ['AC-1'], evidence: [escapeEvidence.path], reason: '真实复现 trim 错误，人工录入' }, actor)
const precheck = await precheckDefect(reopened, defect)
assert.equal(precheck.acCovered, true)
assert(precheck.cases?.includes('TC-GREET-001'))
assert(precheck.codeNodes?.includes('dev-test-loop/fix-code'))
assert(precheck.gates?.includes('delivery-check'))
const candidate = await attributeDefectCheckpoints({ stores: reopened, profiles, harnesses: { mock }, knowledge: [], skillsDir: reopened.paths.skills }, req.id, defect.id, { baseRevision: defect.revision!, reason: '独立 auditor 检查冻结材料' })
assert.equal(candidate.status, 'attributed')
assert.equal(candidate.attribution?.confirmed, undefined)
assert((await scorecards(reopened, { by: 'node' })).every((card) => card.escapes === 0))
const repair = artifacts.find(a => a.path === 'tasks/repair.diff')!.versions[0]!
await confirmDefect(reopened, req.id, defect.id, { note: '核对实际复现与冻结修复 diff，确认引入点',
  attribution: { ...candidate.attribution!, introducedAt: { ...candidate.attribution!.introducedAt,
    artifact: { workspace: req.id, path: 'tasks/repair.diff', version: repair.version } } } }, actor)
const persisted = await openProject(root)
let confirmed = (await listDefects(persisted, req.id))[0]!
assert.equal(confirmed.status, 'confirmed')
assert.equal((await listEvalCases(persisted)).length, 0, '旧节点归因不能自动生成整节点样本')
confirmed = await updateQualityDefect(persisted, req.id, defect.id, { validity: 'valid', baseRevision: confirmed.revision!, reason: '人确认实际复现为产品缺陷' }, actor)
const missed = (await nodeQuality(persisted, state.runId, 'dev-test-loop/review-fix')).checkpoints.find(p => p.role === 'reviewer')!
assert(missed.snapshot)
const material = await snapshotMaterials(persisted.taktDir, missed.snapshot)
assert(material.some(file => file.ref?.path === 'tasks/repair.diff' && file.content.toString().includes('trim')))
assert(material.some(file => file.ref?.path === 'spec/prd.md' && file.content.toString().includes('trim')))
confirmed = await decideCheckpointMiss(persisted, req.id, defect.id, missed.id, {
  verdict: 'should_have_caught', conditions: { existed: true, materialProvided: true, executed: true, inDuty: true, notRaised: true },
  note: '修复 diff 已含 trim，PRD 明确不 trim；属于回归范围职责，评审完成却未提出该问题',
}, actor, { baseRevision: confirmed.revision!, reason: '逐项核对漏检五条件' })
const mustCatch = await addEvalSample(persisted, { kind: 'must_catch', checkpointId: missed.id, defectId: defect.id,
  baseRevision: confirmed.revision!, expectIssue: '非空名字两侧空格被 trim 删除', reason: '人确认漏检作为回归样本' }, actor)
const cleanPoint = (await nodeQuality(persisted, state.runId, 'review-prd')).checkpoints.filter(p => p.role === 'reviewer' && p.subject === 'architect' && p.record?.verdict === 'approve').at(-1)!
const clean = await addEvalSample(persisted, { kind: 'clean', checkpointId: cleanPoint.id, reason: '人核对修订 PRD 完整且明确不 trim，不存在 blocker/major' }, actor)
assert.deepEqual((await listEvalCases(persisted)).map(c => c.sample!.kind).sort(), ['clean', 'must_catch'])
for (const sample of [mustCatch, clean]) {
  assert(sample.sample?.checkpointId && sample.sample.snapshot)
  assert(sample.inputs.length > 0)
}
const issueEvents = ofType('review.issue', 'review-prd').filter(e => e.data.key === 'ISS-1')
assert(issueEvents.some(e => e.data.action === 'claimed_fixed'))
assert(issueEvents.some(e => e.data.action === 'verified_fixed'))
assert(issueEvents.findIndex(e => e.data.action === 'claimed_fixed') < issueEvents.findIndex(e => e.data.action === 'verified_fixed'))
for (const event of ofType('snapshot.created')) assert((await snapshotMaterials(persisted.taktDir, event.data)).length > 0)
assert(ofType('checkpoint.scheduled').length > 0 && ofType('invocation.started').length > 0)
await syncQuality(persisted, state.runId)
assert.equal((await verifyQuality(persisted)).ok, true)
assert.equal((await scorecards(persisted, { by: 'node' })).find(c => c.key.nodeId === 'dev-test-loop/fix-code')!.escapes, 1)
assert.equal((await scorecards(persisted, { by: 'node' })).find(c => c.key.nodeId === 'dev-test-loop/review-fix')!.detection?.missed, 1)
assert.deepEqual(await persisted.events.verify(`defect-${req.id}`), { ok: true })
console.log(`PASS M5：检查点与只读快照完整；ISS-1 claimed → verified；实际 trim 复现 → 人确认五条件 → must_catch / clean 两类检查点样本；质量日志可校验。mock 归因不代表真实模型验收。缺陷：${defect.id}`)
