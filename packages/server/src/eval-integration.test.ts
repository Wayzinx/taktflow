import { protectCandidate } from '../../core/src/eval/candidates.js'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createEngine, initProject, openProject, waitDefectAttribution, waitEvalRun, type AgentProfile, type EngineDeps, type HarnessAdapter } from '@taktflow/core'
import { createServer, type RunningServer } from './index.js'

const roots: string[] = [], servers: RunningServer[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); await Promise.all(roots.splice(0).map(async root => { await protectCandidate(join(root, '.takt/quality/candidates'), true).catch(error => { if (error.code !== 'ENOENT') throw error }); await rm(root, { recursive: true, force: true }) })) })

it.each(['tested', undefined])('正式 server 评测闭环、输出快照及审计原因；被测模型=%s', async (testedModel) => {
  const root = await mkdtemp(join(tmpdir(), 'takt-eval-wiring-http-')); roots.push(root)
  const stores = await initProject(root)
  const req = await stores.workspaces.createRequirement({ title: '入口联调' })
  const profiles = Object.fromEntries(['dev', 'reviewer', 'auditor', 'evaluator'].map((role): [string, AgentProfile] => [role, {
    role, title: role, description: '', instructions: '', skills: [], writeScope: ['**'], harness: { harness: 'mock', model: role === 'evaluator' ? 'mock-judge' : testedModel },
  }]))
  const harness: HarnessAdapter = { id: 'mock', displayName: 'mock', available: async () => ({ ok: true }), capabilities: { structuredOutput: true }, run: async (request) => {
    if (request.env?.TAKT_ROLE === 'auditor') return { ok: true, finalText: '', structured: { introducedAt: { origin: 'implementation', nodeId: 'write', evidence: ['spec/a.md 缺少边界说明'] }, missedBy: [], checkpoints: [], confidence: 0.9, suggestions: [] } }
    if (request.env?.TAKT_ROLE === 'evaluator') {
      return { ok: true, finalText: '', structured: { outcome: 'pass', reason: 'mock 核对冻结输出' } }
    }
    if (request.env?.TAKT_ROLE === 'reviewer') return { ok: true, finalText: '', structured: { verdict: 'approve', summary: '核对边界', issues: [] } }
    await mkdir(join(request.env!.TAKT_WORKSPACE!, 'spec'), { recursive: true })
    await writeFile(join(request.env!.TAKT_WORKSPACE!, 'spec/a.md'), 'AC-1：已补边界说明')
    return { ok: true, finalText: '完成' }
  } }
  const deps: EngineDeps = { stores, profiles, harnesses: { mock: harness }, knowledge: [], skillsDir: stores.paths.skills }
  const run = await createEngine(deps).start({ requirementId: req.id, workflow: { id: 'flow', title: '联调', version: '1', stages: [], nodes: [
    { kind: 'agent', id: 'write', title: '写规格', role: 'dev', prompt: '写规格', outputs: [{ path: 'spec/a.md', kind: 'spec' }] },
    { kind: 'review', id: 'review', title: '规格检查', needs: ['write'], target: ['spec/a.md'], reviewers: [{ role: 'reviewer', checklist: ['边界完整'] }], author: { role: 'dev' }, maxRounds: 1 },
  ] } })
  const server = await createServer({ projectDir: root, port: 0, resolveRuntime: (fresh) => ({ ...deps, stores: fresh }) }); servers.push(server)
  const request = async (path: string, method = 'GET', data?: unknown) => {
    const response = await fetch(server.url + path, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : data === undefined ? undefined : JSON.stringify(data) })
    const result = await response.json()
    expect(response.status, JSON.stringify(result)).toBe(200)
    return result
  }
  const commands = await request('/api/commands')
  expect(commands.map((value: { id: string }) => value.id)).toEqual(expect.arrayContaining(['eval.scorecards', 'eval.collect', 'eval.run', 'defect.report', 'defect.attribute', 'defect.confirm']))
  expect((await request(`/api/runs/${run.runId}/nodes/write`)).recipe).toMatchObject({ nodeId: 'write', role: 'dev', harness: 'mock', recipeKey: expect.any(String) })
  expect((await request('/api/eval/scorecards')).find((card: any) => card.key.nodeId === 'write')).toMatchObject({ escapes: 0 })
  const defect = await request(`/api/requirements/${req.id}/defects`, 'POST', { title: '边界缺失', description: '遗漏边界', severity: 'major', acs: ['AC-1'], reason: '记录边界问题' })
  expect(await request(`/api/requirements/${req.id}/defects`)).toHaveLength(1)
  expect(await request(`/api/requirements/${req.id}/defects/${defect.id}/attribute`, 'POST', testedModel ? { reason: '调查边界根因' } : undefined)).toMatchObject({ attributing: true })
  expect((await waitDefectAttribution(stores, req.id, defect.id)).status).toBe('attributed')
  expect(await request(`/api/requirements/${req.id}/defects/${defect.id}/confirm`, 'POST', { note: '人工确认', reason: '采纳归因' })).toMatchObject({ status: 'confirmed', attribution: { confirmed: { by: { type: 'human', id: 'web' } } } })
  expect(await request('/api/eval/cases/collect', 'POST', { includeDefects: true })).toHaveProperty('added')
  expect(await request('/api/eval/cases?target=node:flow/write')).toHaveLength(0)
  const detail = await request(`/api/runs/${run.runId}/nodes/review`)
  const point = detail.checkpoints.find((p: any) => p.role === 'reviewer')
  const sample = await request('/api/eval/samples', 'POST', { kind: 'clean', checkpointId: point.id, reason: '人工核对快照无缺陷' })
  expect(sample.sample).toMatchObject({ kind: 'clean', checkpointId: point.id, snapshot: point.snapshot.dir })
  const started = await request('/api/eval/runs', 'POST', { target: { kind: 'node', workflowId: 'flow', nodeId: 'review' }, repeats: 2, variants: [{ id: 'baseline', label: '基线' }], judge: { harness: 'mock', model: 'mock-judge' }, reason: '验证边界修复' })
  const finished = await waitEvalRun(stores, started.id)
  expect(await request(`/api/eval/runs/${started.id}`)).toMatchObject({ status: 'done', repeats: 2, results: [{ pass: true }, { pass: true }], isolation: { mode: 'simulated' }, report: { exploratory: true } })
  expect(await request('/api/eval/runs')).toHaveLength(1)
  const result = finished.results[0]!
  const outputUrl = `/api/eval/runs/${started.id}/output?case=${result.caseId}&variant=baseline`
  const output = await request(outputUrl)
  expect(output.files).toHaveLength(2)
  expect(JSON.parse(output.files[0].content)).toMatchObject({ output: { verdict: 'approve', issues: [] }, verdict: { outcome: 'pass' } })
  // M5 输出来自权威质量日志；工作区后续修改不影响冻结输出。
  await writeFile(join(stores.workspaces.dir(req.id), 'spec/a.md'), '后续改动')
  expect(await request(outputUrl)).toEqual(output)
  for (const [url, status] of [
    [`/api/eval/runs/missing/output?case=${result.caseId}&variant=baseline`, 404],
    [`/api/eval/runs/${started.id}/output?case=missing&variant=baseline`, 404],
    [`/api/eval/runs/${started.id}/output?case=${result.caseId}&variant=missing`, 404],
    [`/api/eval/runs/${started.id}/output?case=..%2Fescape&variant=baseline`, 400],
    [`/api/eval/runs/${started.id}/output?case=${result.caseId}&variant=%2Ftmp`, 400],
  ] as const) expect((await fetch(server.url + url)).status).toBe(status)
  const card = await request('/api/commands/eval.scorecards', 'POST', { input: { by: 'node' } })
  expect(card).toMatchObject({ ok: true, result: expect.arrayContaining([expect.objectContaining({ key: expect.objectContaining({ workflowId: 'flow', nodeId: 'write' }), escapes: 0 })]) })
  const reported = await request('/api/commands/defect.report', 'POST', { input: { requirementId: req.id, title: '命令入口', description: '检查共享注册表', severity: 'minor' }, reason: '联调' })
  expect(reported).toMatchObject({ ok: true, result: { id: 'D-2' } })
  const reloaded = await openProject(root)
  expect((await reloaded.quality!.defects(req.id)).map(d => d.id)).toEqual(['D-1', 'D-2'])
  const qualityLog = (await readFile(join(stores.taktDir, 'quality/log.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(qualityLog).toContainEqual(expect.objectContaining({ kind: 'defect.created', data: expect.objectContaining({ reason: '记录边界问题' }) }))
  expect(qualityLog.some(e => e.kind === 'invocation.started')).toBe(true)
  expect((await reloaded.quality!.status()).ok).toBe(true)
  const audit = (await readFile(join(stores.taktDir, 'space-events.jsonl'), 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(JSON.parse(line).data.message)).map((entry) => JSON.parse(entry.message))
    .filter((entry) => entry.phase === 'requested')
  for (const [id, reason] of [
    ['defect.report', '记录边界问题'], ['defect.attribute', testedModel ? '调查边界根因' : 'defect.attribute via web'],
    ['defect.confirm', '采纳归因'], ['eval.collect', 'eval.collect via web'], ['eval.run', '验证边界修复'],
  ]) expect(audit).toContainEqual(expect.objectContaining({ id, reason }))
}, 15000)

it('M3 历史输出仍限长、跳过二进制、拒绝 symlink 与逃逸目录；M5 不重跑旧节点', async () => {
  const { symlink } = await import('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'takt-legacy-output-')); roots.push(root)
  const stores = await initProject(root), outputDir = join(stores.taktDir, 'evals/runs/legacy/case/baseline')
  await mkdir(outputDir, { recursive: true })
  await writeFile(join(outputDir, 'large.txt'), 'x'.repeat(200 * 1024 + 1))
  await writeFile(join(outputDir, 'binary.bin'), Buffer.from([0, 255]))
  const legacy = { id: 'legacy', target: { kind: 'node', workflowId: 'flow', nodeId: 'write' }, variants: [{ id: 'baseline', label: '旧基线' }], caseIds: ['case'], status: 'done', startedAt: new Date().toISOString(), by: { type: 'human', id: 'web' }, results: [{ caseId: 'case', variant: 'baseline', pass: true, outputDir }] }
  await writeFile(join(stores.taktDir, 'evals/runs/legacy.json'), JSON.stringify(legacy))
  const server = await createServer({ projectDir: root, port: 0 }); servers.push(server)
  const url = `${server.url}/api/eval/runs/legacy/output?case=case&variant=baseline`
  const response = await fetch(url), output = await response.json()
  expect(response.status).toBe(200)
  expect(output.files).toEqual([{ path: 'large.txt', content: 'x'.repeat(200 * 1024) + '\n[已截断：文件超过 200KB，仅显示前 200KB]' }])
  await symlink(join(root, 'takt.config.json'), join(outputDir, 'escape.txt'))
  expect((await fetch(url)).status).toBe(400)
  await rm(join(outputDir, 'escape.txt'))
  // 导入后的旧磁盘文件不再是权威；改它不能把输出目录重定向到空间根。
  await writeFile(join(stores.taktDir, 'evals/runs/legacy.json'), JSON.stringify({ ...legacy, results: [{ ...legacy.results[0], outputDir: root }] }))
  expect((await fetch(url)).status).toBe(200)
  await stores.quality!.append([{ kind: 'eval.started', key: 'bad-output-root', actor: legacy.by as { type: 'human'; id: string }, data: { ...legacy, id: 'bad-root', results: [{ ...legacy.results[0], outputDir: root }], reason: '旧数据坏路径测试' } }])
  expect((await fetch(`${server.url}/api/eval/runs/bad-root/output?case=case&variant=baseline`)).status).toBe(400)
  await rm(outputDir, { recursive: true })
  expect((await fetch(url)).status).toBe(404)
})
