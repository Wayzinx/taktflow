import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentProfile, Checkpoint, EvalCase, EvalGate, HarnessAdapter, HarnessRequest, InvocationStart, ReviewRecord, RunState, Sandbox, SnapshotManifest } from '../types.js'
import { initProject } from '../store/project.js'
import { sha256 } from '../util/hash.js'
import { addEvalSample, retireEvalSample } from './samples.js'
import { getEvalInvocations, getEvalRun, runEval, waitEvalRun } from './runner.js'
import { listEvalCases, saveEvalCase } from './cases.js'
import { getEvalOutput } from './output.js'
import { checkReplayIsolation, assertReplayRole } from './isolation.js'
import { freezeEvalCandidate, protectCandidate, verifyCandidate } from './candidates.js'
import { blindOrder, buildEvalReport, wilson95, type ReplayTrial } from './statistics.js'
import { evalRevision } from './quality-access.js'

const roots: string[] = []
const person = { type: 'human' as const, id: 'tester' }
const at = '2026-11-08T00:00:00.000Z'
const gate: EvalGate = { minSamples: 1, minRepeats: 3, maxPassRateDrop: 0, maxFalsePositiveIncrease: 0, regressionsMustPass: true }
afterEach(async () => {
  for (const root of roots.splice(0)) { await protectCandidate(root, true); await rm(root, { recursive: true, force: true }) }
})

async function fixture(options: { role?: Checkpoint['role']; status?: 'done' | 'error' | 'skipped'; snapshot?: boolean; harness?: string; readOnly?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'takt-m5-replay-')); roots.push(root)
  const stores = await initProject(root)
  const req = await stores.workspaces.createRequirement({ id: 'REQ-1', title: '检查点回放' })
  const run: RunState = { runId: 'original', requirementId: req.id, workflowId: 'flow', workflowVersion: '1', status: 'succeeded',
    startedAt: at, args: {}, expansions: [], nodes: { review: { id: 'review', status: 'succeeded', attempts: 1, outputs: [] } } }
  await stores.runs.create(run, { id: 'flow', title: 'flow', version: '1', stages: [], nodes: [{ id: 'review', kind: 'review', title: '评审', needs: [] }] })
  const point: Checkpoint = { id: 'original:review:1:1.1:reviewer', runId: run.runId, nodeId: 'review', role: options.role ?? 'reviewer',
    subject: 'reviewer', attempt: 1, duties: ['核对输入'], scheduledAt: at }
  const manifest: SnapshotManifest = { checkpointId: point.id, dir: 'snapshots/original/point', duties: point.duties!, readOnly: 'permissions', createdAt: at,
    files: [{ path: 'target/input.md', role: 'target', source: 'artifact', sha256: sha256('frozen material'), size: 15 }] }
  const path = join(stores.taktDir, manifest.dir, 'files/target/input.md')
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, 'frozen material')
  await writeFile(join(stores.taktDir, manifest.dir, 'manifest.json'), JSON.stringify(manifest))
  const invocation: InvocationStart = { id: 'original-call', nodeId: 'review', attempt: 1, checkpointId: point.id, role: point.role,
    agentRole: 'reviewer', fallbackIndex: 0, recipeKey: 'original-recipe', harness: options.harness ?? 'mock', model: { requested: 'tested', resolved: 'tested' }, effort: {}, skills: [], at }
  await stores.events.append(run.runId, { type: 'checkpoint.scheduled', nodeId: 'review', actor: person, data: point })
  if (options.snapshot !== false) await stores.events.append(run.runId, { type: 'snapshot.created', nodeId: 'review', actor: person, data: manifest })
  await stores.events.append(run.runId, { type: 'invocation.started', nodeId: 'review', actor: person, data: invocation })
  await stores.events.append(run.runId, { type: 'harness.message', nodeId: 'review', actor: { type: 'agent', role: 'reviewer', harness: invocation.harness, invocationId: invocation.id },
    data: { role: 'user', text: `review frozen input ${path}` } })
  await stores.events.append(run.runId, { type: 'invocation.finished', nodeId: 'review', actor: person, data: { id: invocation.id, outcome: 'ok', durationMs: 1 } })
  const record = { reviewer: 'reviewer', verdict: 'approve', summary: '无问题', issues: [], artifacts: [] } as unknown as ReviewRecord
  await stores.events.append(run.runId, { type: 'review.result', nodeId: 'review', actor: person, data: { checkpointId: point.id, invocationId: invocation.id, record } })
  await stores.events.append(run.runId, { type: 'checkpoint.finished', nodeId: 'review', actor: person, data: { id: point.id, status: options.status ?? 'done' } })
  const profiles: Record<string, AgentProfile> = Object.fromEntries(['reviewer', 'evaluator'].map(role => [role, { role, title: role, description: '',
    instructions: role, skills: [], writeScope: [], harness: { harness: invocation.harness, model: role === 'evaluator' ? 'judge' : 'tested' } }]))
  const requests: HarnessRequest[] = []
  const harness: HarnessAdapter = { id: invocation.harness, displayName: 'fixture', capabilities: { readOnly: options.readOnly, structuredOutput: true }, available: async () => ({ ok: true }),
    run: vi.fn(async (request, onEvent) => {
      requests.push(request)
      expect(request.readOnly).toBe(true)
      expect(request.tools).toEqual({ writeScope: [], allowBash: false })
      expect(request.cwd).not.toContain(root)
      onEvent({ type: 'started', model: 'reported-actual', skills: [] })
      if (request.env?.TAKT_ROLE === 'evaluator') {
        const payload = JSON.parse(request.prompt.split('\n')[1]!)
        expect(Object.keys(payload).sort()).toEqual(['kind', 'materials', 'output'])
        expect(request.prompt).not.toContain('CANDIDATE_SECRET_LABEL')
        return { ok: true, finalText: '', structured: { outcome: 'pass', reason: '已对照冻结材料检查' } }
      }
      expect(request.prompt).not.toContain(root)
      expect(await readFile(join(request.cwd, 'materials/target/input.md'), 'utf8')).toBe('frozen material')
      return { ok: true, finalText: '', structured: { issues: request.model === 'false-positive' ? [{ severity: 'major' }] : [] } }
    }) }
  const deps = { stores, profiles, harnesses: { [harness.id]: harness }, knowledge: [] }
  return { root, stores, deps, point, manifest, harness, requests, path }
}

it('mock 端到端：冻结材料、独立目录、默认三次、误报、匿名评委、日志重建与身份回报', async () => {
  const f = await fixture()
  f.stores.config.eval = { gate }
  const sample = await addEvalSample(f.stores, { kind: 'clean', checkpointId: f.point.id, reason: '人工逐项核实原始材料无问题' }, person)
  const run = await runEval(f.deps, { target: sample.target, variants: [{ id: 'candidate', label: 'CANDIDATE_SECRET_LABEL', harness: { harness: 'mock', model: 'false-positive' } }], reason: '比较误报' }, person)
  const finished = await waitEvalRun(f.stores, run.id)
  expect(finished).toMatchObject({ status: 'done', repeats: 3, isolation: { mode: 'simulated' }, report: {
    falsePositives: { baseline: 0, candidate: 3 }, insufficient: { baseline: 0, candidate: 0 }, exploratory: true, gate: { verdict: 'not_applicable', config: gate },
    judge: { blind: true, recipeKey: expect.any(String) }, passRate: { baseline: { rate: 1, n: 3 }, candidate: { rate: 0, n: 3 } },
  } })
  expect(new Set(f.requests.map(r => r.cwd)).size).toBe(12)
  expect(finished.results).toHaveLength(6)
  expect((await getEvalOutput(f.stores, run.id, sample.id, 'candidate')).files).toHaveLength(3)
  expect(finished.candidates?.candidate).toMatch(/^[a-f0-9]{64}$/)
  expect(await readFile(f.path, 'utf8')).toBe('frozen material')
  expect(await f.stores.runs.list()).toHaveLength(1)
  const log = (await readFile(join(f.stores.taktDir, 'quality/log.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const starts = log.filter(e => e.kind === 'invocation.started')
  const ends = log.filter(e => e.kind === 'invocation.finished')
  expect(starts).toHaveLength(12); expect(ends).toHaveLength(12)
  expect(ends.every(e => e.data.reported.model === 'reported-actual')).toBe(true)
  expect(starts.filter(e => e.data.role === 'evaluator').every(e => e.data.recipeKey === finished.report!.judge!.recipeKey)).toBe(true)
  expect(log.filter(e => e.kind.startsWith('eval.') || e.kind.startsWith('sample.')).every(e => e.data.reason && e.data.baseRevision)).toBe(true)
  await f.stores.quality!.rebuild()
  expect(await getEvalRun(f.stores, run.id)).toEqual(finished)
})

it.each(['producer', 'author', 'command', 'acceptance', 'judge', 'planner'] as const)('拒绝非只读角色 %s', role => {
  expect(() => assertReplayRole(role)).toThrow('不是只读检查点')
})
it.each(['reviewer', 'arbiter', 'rubric', 'auditor', 'evaluator'] as const)('允许只读角色 %s', role => expect(() => assertReplayRole(role)).not.toThrow())

it.each([
  { field: 'provider', reason: 'bwrap', change: (s: Sandbox) => { s.provider = 'local' } },
  { field: 'network', reason: '关闭网络', change: (s: Sandbox) => { s.spec.network = 'egress' } },
  { field: 'mount', reason: '只读挂载', change: (s: Sandbox) => { s.spec.mounts[0]!.mode = 'rw' } },
  { field: 'outside', reason: '额外挂载', change: (s: Sandbox) => { s.spec.mounts.push({ source: '/real', target: '/real', mode: 'ro' }) } },
  { field: 'workdir', reason: '工作目录', change: (s: Sandbox) => { s.spec.workdir = '/real' } },
])('隔离前置拒绝 $field', ({ reason, change }) => {
  const sandbox = { provider: 'bwrap', spec: { workdir: '/tmp/test', mounts: [{ source: '/tmp/test', target: '/tmp/test', mode: 'ro' }], network: 'none' } } as Sandbox
  const harness = { id: 'external', capabilities: { sandbox: true } } as HarnessAdapter
  expect(checkReplayIsolation(harness, '/tmp/test', sandbox)).toMatchObject({ ok: true, mode: 'sandbox' })
  change(sandbox)
  expect(checkReplayIsolation(harness, '/tmp/test', sandbox)).toMatchObject({ ok: false, reasons: expect.arrayContaining([expect.stringContaining(reason)]) })
})

it('harness 不支持沙箱时拒绝；readOnly 声明与 mock 分开记录', () => {
  const h = { id: 'external' } as HarnessAdapter
  expect(checkReplayIsolation(h, '/tmp/x').reasons).toContain('harness 未声明支持沙箱，不能保证调用在隔离环境内执行')
  expect(checkReplayIsolation({ ...h, capabilities: { readOnly: true } }, '/tmp/x')).toMatchObject({ ok: true, mode: 'harness_readonly' })
  expect(checkReplayIsolation({ ...h, id: 'mock' }, '/tmp/x')).toMatchObject({ ok: true, mode: 'simulated' })
})

it('不支持隔离或 fallback 不安全时拒绝启动且不调用模型', async () => {
  const f = await fixture({ harness: 'unsafe' })
  const sample = await addEvalSample(f.stores, { kind: 'clean', checkpointId: f.point.id, reason: '人确认' }, person)
  const result = await runEval(f.deps, { target: sample.target, variants: [{ id: 'baseline', label: '基线' }] })
  expect(result.status).toBe('refused'); expect(f.harness.run).not.toHaveBeenCalled()
  f.harness.capabilities!.readOnly = true
  f.deps.harnesses.unsafeFallback = { ...f.harness, id: 'unsafeFallback', capabilities: {} }
  const fallback = await runEval(f.deps, { target: sample.target, variants: [{ id: 'baseline', label: '基线', harness: { harness: 'unsafe', fallback: [{ harness: 'unsafeFallback' }] } }] })
  expect(fallback.status).toBe('refused'); expect(f.harness.run).not.toHaveBeenCalled()
})

it.each([{ role: 'producer' as const }, { status: 'error' as const }, { status: 'skipped' as const }, { snapshot: false }])('不能从无效检查点创建样本 %j', async options => {
  const f = await fixture(options)
  await expect(addEvalSample(f.stores, { kind: 'clean', checkpointId: f.point.id, reason: '人确认' }, person)).rejects.toThrow()
})

it('旧节点样本仍可读，但执行返回 refused，路径穿越仍拒绝', async () => {
  const f = await fixture()
  const value: EvalCase = { id: 'old', title: '旧写节点', target: { kind: 'node', workflowId: 'flow', nodeId: 'dev' }, source: { kind: 'manual' },
    node: { id: 'dev', kind: 'agent', title: '实现', role: 'dev', needs: [] }, inputs: [], grading: {}, createdAt: at }
  await saveEvalCase(f.stores, value)
  expect(await listEvalCases(f.stores, value.target)).toEqual([value])
  expect(await runEval(f.deps, { target: value.target, variants: [{ id: 'baseline', label: '旧用例' }] })).toMatchObject({ status: 'refused', isolation: { reasons: expect.arrayContaining([expect.stringContaining('整节点')]) } })
  await expect(runEval(f.deps, { target: value.target, variants: [{ id: 'candidate', label: '穿越', promptFile: '../secret' }] })).rejects.toThrow('变体路径无效')
  expect(f.harness.run).not.toHaveBeenCalled()
})

it('候选包按内容寻址、冻结后源文件改变不影响候选，不写回且检测篡改', async () => {
  const f = await fixture()
  const input = join(f.root, 'candidate-prompt.txt'); await writeFile(input, 'candidate content')
  const a = await freezeEvalCandidate(f.deps, { id: 'a', label: '甲', promptFile: input })
  const b = await freezeEvalCandidate(f.deps, { id: 'b', label: '乙', promptFile: input })
  expect(a.id).toBe(b.id)
  await writeFile(input, 'new content')
  expect(await readFile(a.variant.promptFile!, 'utf8')).toBe('candidate content')
  const c = await freezeEvalCandidate(f.deps, { id: 'c', label: '丙', promptFile: input })
  expect(c.id).not.toBe(a.id)
  expect(await readFile(input, 'utf8')).toBe('new content')
  await chmod(a.variant.promptFile!, 0o644); await writeFile(a.variant.promptFile!, 'tampered')
  await expect(verifyCandidate(a)).rejects.toThrow('内容已改变')
})

it('Wilson 0/0 与 3/3，以及稳定且输入次序无关的盲评顺序', () => {
  expect(wilson95(0, 0)).toEqual({ rate: 0, low: 0, high: 1, n: 0 })
  expect(wilson95(3, 0).low).toBeCloseTo(0.4385, 4)
  expect(wilson95(3, 0).high).toBeCloseTo(1)
  const rows = Array.from({ length: 10 }, (_, repeat) => ({ caseId: 'a', variant: repeat % 2 ? 'candidate' : 'baseline', repeat }))
  expect(blindOrder(rows, 'seed')).toEqual(blindOrder([...rows].reverse(), 'seed'))
  expect(blindOrder(rows, 'seed')).not.toEqual(rows)
})

it('门槛快照、探索性、回归全过、通过率下降、误报增加和证据不足', () => {
  const cases = [{ id: 'a', source: { kind: 'defect' }, sample: { kind: 'must_catch' } }] as EvalCase[]
  const variants = [{ id: 'baseline', label: '基线' }, { id: 'candidate', label: '候选' }]
  const trials: ReplayTrial[] = variants.flatMap(v => Array.from({ length: 3 }, (_, repeat) => ({ caseId: 'a', variant: v.id, repeat, verdict: { outcome: 'pass' as const } })))
  const config = structuredClone(gate)
  expect(buildEvalReport(cases, variants, 3, trials, { gate: config }).gate?.verdict).toBe('pass')
  const frozen = buildEvalReport(cases, variants, 3, trials, { gate: config }); config.minSamples = 20
  expect(frozen.gate!.config.minSamples).toBe(1)
  expect(buildEvalReport(cases, variants, 3, trials, { gate: config })).toMatchObject({ exploratory: true, gate: { verdict: 'not_applicable' } })
  trials[5]!.verdict = { outcome: 'fail', falsePositive: true }
  expect(buildEvalReport(cases, variants, 3, trials, { gate }).gate).toMatchObject({ verdict: 'fail', reasons: expect.arrayContaining([
    expect.stringContaining('通过率下降'), expect.stringContaining('误报增加'), expect.stringContaining('回归样本'),
  ]) })
  trials[5]!.verdict = { outcome: 'insufficient' }
  const report = buildEvalReport(cases, variants, 3, trials, { gate })
  expect(report.passRate.candidate).toMatchObject({ rate: 1, n: 2 }); expect(report.gate?.verdict).toBe('fail')
})

it('请求重复数优先于配置；环境与评委错误均为证据不足', async () => {
  const f = await fixture()
  f.stores.config.eval = { repeats: 2 }
  const sample = await addEvalSample(f.stores, { kind: 'clean', checkpointId: f.point.id, reason: '人确认' }, person)
  vi.mocked(f.harness.run).mockImplementation(async request => {
    if (request.env?.TAKT_ROLE === 'evaluator') return { ok: true, finalText: '{}', structured: {} }
    return { ok: true, finalText: '', structured: { issues: [] } }
  })
  const a = await waitEvalRun(f.stores, (await runEval(f.deps, { target: sample.target, repeats: 1, variants: [{ id: 'baseline', label: '基线' }] })).id)
  expect(a.repeats).toBe(1); expect(a.report?.insufficient.baseline).toBe(1); expect(a.report?.passRate.baseline?.n).toBe(0)
  vi.mocked(f.harness.run).mockRejectedValue(new Error('environment down'))
  const b = await waitEvalRun(f.stores, (await runEval(f.deps, { target: sample.target, variants: [{ id: 'baseline', label: '基线' }] })).id)
  expect(b.repeats).toBe(2); expect(b.report?.insufficient.baseline).toBe(2)
})

it('样本退役需理由与并发版本，默认不返回，includeRetired 保留退役时间', async () => {
  const f = await fixture()
  const sample = await addEvalSample(f.stores, { kind: 'clean', checkpointId: f.point.id, reason: '人确认' }, person)
  await expect(retireEvalSample(f.stores, sample.id, person, '', evalRevision(sample))).rejects.toThrow('reason')
  await expect(retireEvalSample(f.stores, sample.id, person, '退役', 'stale')).rejects.toThrow('baseRevision')
  await retireEvalSample(f.stores, sample.id, person, '材料不适用', evalRevision(sample))
  expect(await listEvalCases(f.stores)).toEqual([])
  expect(await listEvalCases(f.stores, sample.target, { includeRetired: true })).toMatchObject([
    { id: sample.id, title: sample.title, target: sample.target, sample: { kind: 'clean', checkpointId: f.point.id, retiredAt: expect.any(String) } },
  ])
})

it('must_catch 仅接受人工确认的五条件，追加校验缺陷 baseRevision，重复添加幂等', async () => {
  const f = await fixture()
  const defect = { id: 'D-1', requirementId: 'REQ-1', title: '必须发现字段遗漏', description: '字段遗漏', severity: 'major', status: 'confirmed',
    validity: 'valid', foundAt: at, reportedBy: person }
  await f.stores.quality!.append([{ kind: 'defect.created', key: 'd1', requirementId: 'REQ-1', data: { ...defect, reason: '确认产品缺陷' }, actor: person }])
  const request = { kind: 'must_catch' as const, checkpointId: f.point.id, defectId: 'D-1', expectIssue: '字段遗漏', reason: '核对漏检材料' }
  await expect(addEvalSample(f.stores, { ...request, baseRevision: 1 }, person)).rejects.toThrow('五条件')
  const attribution = { defectId: 'D-1', introducedAt: { origin: 'implementation', evidence: [] }, missedBy: [], suggestions: [], at, by: person,
    confirmed: { by: person, at }, checkpoints: [{ checkpointId: f.point.id, runId: 'original', nodeId: 'review', verdict: 'should_have_caught',
      conditions: { existed: true, materialProvided: true, inDuty: true, executed: true, notRaised: true }, evidence: ['快照字段缺失'], by: 'human', confirmed: { by: person, at } }] }
  await f.stores.quality!.append([{ kind: 'attribution.confirmed', key: 'a1', requirementId: 'REQ-1', data: { ...attribution, reason: '人工确认五条件' }, actor: person }])
  await expect(addEvalSample(f.stores, request, person)).rejects.toThrow('baseRevision')
  await expect(addEvalSample(f.stores, { ...request, baseRevision: 0 }, person)).rejects.toThrow('baseRevision')
  const sample = await addEvalSample(f.stores, { ...request, baseRevision: 1 }, person)
  expect(sample.sample).toMatchObject({ kind: 'must_catch', expectIssue: '字段遗漏', snapshot: f.manifest.dir })
  expect(await addEvalSample(f.stores, { ...request, baseRevision: 1 }, person)).toEqual(sample)
  expect(await listEvalCases(f.stores)).toHaveLength(1)
  vi.mocked(f.harness.run).mockImplementation(async request => {
    if (request.env?.TAKT_ROLE === 'evaluator') {
      const payload = JSON.parse(request.prompt.split('\n')[1]!)
      expect(payload.expectIssue).toBe('字段遗漏')
      expect(payload.output).toEqual({ issues: [{ severity: 'major', description: '字段遗漏' }] })
      return { ok: true, finalText: '', structured: { outcome: 'pass', reason: '指出了冻结材料中的字段遗漏' } }
    }
    return { ok: true, finalText: '', structured: { issues: [{ severity: 'major', description: '字段遗漏' }] } }
  })
  const run = await runEval(f.deps, { target: sample.target, repeats: 1, variants: [{ id: 'baseline', label: '基线' }] })
  expect((await waitEvalRun(f.stores, run.id)).report?.samples[0]?.variants.baseline).toMatchObject({ pass: 1, insufficient: 0, falsePositives: 0 })
  await expect(addEvalSample(f.stores, { ...request, baseRevision: 1 }, { type: 'system', id: 'auto' })).rejects.toThrow('由人确认')
})

it('安全 readOnly harness 的发布门槛与固定配置；候选 prompt、技能、档案在启动时冻结', async () => {
  const f = await fixture({ harness: 'readonly', readOnly: true })
  f.stores.config.eval = { repeats: 1, gate: { ...gate, minRepeats: 1 } }
  await mkdir(join(f.root, 'replacement/work'), { recursive: true })
  await writeFile(join(f.root, 'replacement/work/SKILL.md'), 'frozen skill')
  await writeFile(join(f.root, 'candidate-prompt'), 'frozen prompt')
  await writeFile(join(f.root, 'candidate-profile.md'), '---\nrole: reviewer\nharness: { harness: readonly, model: candidate-model }\nskills: [work]\n---\nfrozen profile')
  const original = f.harness.run
  f.harness.run = vi.fn(async (request, onEvent) => {
    if (request.model === 'candidate-model') {
      expect(request.prompt).toContain('frozen prompt')
      expect(request.systemAppend).toBe('frozen profile')
      expect(await readFile(join(request.cwd, '.agents/skills/work/SKILL.md'), 'utf8')).toBe('frozen skill')
    }
    return original(request, onEvent)
  })
  const sample = await addEvalSample(f.stores, { kind: 'clean', checkpointId: f.point.id, reason: '人工确认' }, person)
  const run = await runEval(f.deps, { target: sample.target, variants: [{ id: 'candidate', label: '候选', promptFile: 'candidate-prompt',
    profileFile: 'candidate-profile.md', skillsDir: 'replacement' }] })
  f.stores.config.eval.gate!.minSamples = 100
  await writeFile(join(f.root, 'candidate-prompt'), 'changed prompt')
  await writeFile(join(f.root, 'candidate-profile.md'), 'changed profile')
  await writeFile(join(f.root, 'replacement/work/SKILL.md'), 'changed skill')
  const finished = await waitEvalRun(f.stores, run.id)
  expect(finished.status, JSON.stringify({ isolation: finished.isolation, results: finished.results })).toBe('done')
  expect(finished).toMatchObject({ status: 'done', isolation: { mode: 'harness_readonly' }, report: {
    exploratory: false, insufficient: { baseline: 0, candidate: 0 }, gate: { verdict: 'pass', config: { minSamples: 1 } },
  } })
  expect(await readFile(join(f.root, 'candidate-prompt'), 'utf8')).toBe('changed prompt')
})

it.each(['missing', 'tampered', 'traversal', 'symlink'] as const)('快照 %s 拒绝启动且不调用模型', async mode => {
  const f = await fixture()
  const sample = await addEvalSample(f.stores, { kind: 'clean', checkpointId: f.point.id, reason: '人工确认' }, person)
  if (mode === 'missing') await rm(f.path)
  if (mode === 'tampered') await writeFile(f.path, 'tampered')
  if (mode === 'symlink') { await rm(f.path); await symlink(join(f.root, 'takt.config.yaml'), f.path) }
  if (mode === 'traversal') await f.stores.events.append('original', { type: 'snapshot.created', nodeId: 'review', actor: person,
    data: { ...f.manifest, files: [{ ...f.manifest.files[0]!, path: '../escape' }] } })
  const run = await runEval(f.deps, { target: sample.target, variants: [{ id: 'baseline', label: '基线' }] })
  expect(run.status).toBe('refused'); expect(f.harness.run).not.toHaveBeenCalled()
  if (mode === 'symlink') await rm(f.path)
})

it('harness 不可用和错误沙箱返回 refused；无候选调用启动', async () => {
  const f = await fixture({ harness: 'sandboxed' })
  f.harness.capabilities!.sandbox = true
  const sample = await addEvalSample(f.stores, { kind: 'clean', checkpointId: f.point.id, reason: '人工确认' }, person)
  f.harness.available = async () => ({ ok: false, reason: 'unavailable' })
  const unavailable = await runEval(f.deps, { target: sample.target, variants: [{ id: 'baseline', label: '基线' }] })
  expect(unavailable.isolation?.reasons?.join('')).toContain('不可用')
  f.harness.available = async () => ({ ok: true })
  const dispose = vi.fn(async () => {})
  const deps = { ...f.deps, sandbox: { id: 'bwrap', available: async () => ({ ok: true }), create: async (spec: Sandbox['spec']) => ({
    provider: 'bwrap', spec: { ...spec, network: 'egress' as const }, dispose,
  } as Sandbox) } }
  const invalid = await runEval(deps, { target: sample.target, variants: [{ id: 'baseline', label: '基线' }] })
  expect(invalid.status).toBe('refused'); expect(invalid.isolation?.reasons?.join('')).toContain('关闭网络')
  expect(dispose).toHaveBeenCalled(); expect(f.harness.run).not.toHaveBeenCalled()
})

it('旧评测运行首次读取导入日志，重复读取幂等，不补造新证据', async () => {
  const f = await fixture()
  const legacy = { id: 'eval-legacy', target: { kind: 'node', workflowId: 'flow', nodeId: 'old' }, variants: [{ id: 'baseline', label: '旧基线' }],
    caseIds: [], status: 'done', startedAt: at, by: person, results: [] }
  const dir = join(f.stores.taktDir, 'evals/runs')
  await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'eval-legacy.json'), JSON.stringify(legacy))
  expect(await getEvalRun(f.stores, legacy.id)).toEqual(legacy)
  const size = (await f.stores.quality!.status()).entries
  expect(await getEvalRun(f.stores, legacy.id)).toEqual(legacy)
  expect((await f.stores.quality!.status()).entries).toBe(size)
})

it('两个并发退役提交只接受一个版本，另一提交报告冲突', async () => {
  const f = await fixture()
  const sample = await addEvalSample(f.stores, { kind: 'clean', checkpointId: f.point.id, reason: '人工确认' }, person)
  const results = await Promise.allSettled(['理由一', '理由二'].map(reason => retireEvalSample(f.stores, sample.id, person, reason, evalRevision(sample))))
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(r => r.status === 'rejected')).toHaveLength(1)
  expect(await listEvalCases(f.stores)).toEqual([])
})

it('fallback 每次尝试独立留痕，失败与评委身份从质量读模型可回读', async () => {
  const f = await fixture()
  const original = f.harness.run
  f.harness.run = vi.fn(async (request, onEvent) => {
    if (request.model === 'broken') throw new Error('primary failed')
    return original(request, onEvent)
  })
  const sample = await addEvalSample(f.stores, { kind: 'clean', checkpointId: f.point.id, reason: '人工确认' }, person)
  const run = await runEval(f.deps, { target: sample.target, repeats: 1, variants: [{ id: 'baseline', label: '基线',
    harness: { harness: 'mock', model: 'broken', fallback: [{ harness: 'mock', model: 'tested' }] } }] })
  expect((await waitEvalRun(f.stores, run.id)).report?.passRate.baseline).toMatchObject({ n: 1, rate: 1 })
  const invocations = await getEvalInvocations(f.stores, run.id)
  expect(invocations.map(i => [i.role, i.fallbackIndex, i.outcome])).toEqual([['reviewer', 0, 'error'], ['reviewer', 1, 'ok'], ['evaluator', 0, 'ok']])
  expect(new Set(invocations.map(i => i.id)).size).toBe(3)
  expect(invocations[1]?.model).toMatchObject({ requested: 'tested', resolved: 'tested', reported: 'reported-actual' })
})
