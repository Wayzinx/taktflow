import { mkdtemp, mkdir, readFile, symlink, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createEngine, initProject, openProject, waitDefectAttribution, waitEvalRun, type AgentProfile, type EngineDeps, type HarnessAdapter } from '@taktflow/core'
import { createServer, type RunningServer } from './index.js'

const roots: string[] = [], servers: RunningServer[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

it.each(['tested', undefined])('正式 server 评测闭环、输出快照及审计原因；被测模型=%s', async (testedModel) => {
  const root = await mkdtemp(join(tmpdir(), 'takt-eval-wiring-http-')); roots.push(root)
  const stores = await initProject(root)
  const req = await stores.workspaces.createRequirement({ title: '入口联调' })
  const profiles = Object.fromEntries(['dev', 'auditor', 'evaluator'].map((role): [string, AgentProfile] => [role, {
    role, title: role, description: '', instructions: '', skills: [], writeScope: ['**'], harness: { harness: 'mock', model: role === 'evaluator' ? 'mock-judge' : testedModel },
  }]))
  const harness: HarnessAdapter = { id: 'mock', displayName: 'mock', available: async () => ({ ok: true }), capabilities: { structuredOutput: true }, run: async (request) => {
    if (request.env?.TAKT_ROLE === 'auditor') return { ok: true, finalText: '', structured: { introducedAt: { origin: 'implementation', nodeId: 'write', evidence: ['spec/a.md 缺少边界说明'] }, missedBy: [], confidence: 0.9, suggestions: [] } }
    if (request.env?.TAKT_ROLE === 'evaluator') {
      const payload = JSON.parse(request.prompt.split('\n')[1]!) as { criteria: string[] }
      return { ok: true, finalText: '', structured: { checks: payload.criteria.map((criterion, i) => ({ id: `c${i + 1}`, criterion, pass: true, evidence: 'mock 核对冻结输出' })), score: 100, reason: 'mock 判分' } }
    }
    await mkdir(join(request.env!.TAKT_WORKSPACE!, 'spec'), { recursive: true })
    await writeFile(join(request.env!.TAKT_WORKSPACE!, 'spec/a.md'), 'AC-1：已补边界说明')
    return { ok: true, finalText: '完成' }
  } }
  const deps: EngineDeps = { stores, profiles, harnesses: { mock: harness }, knowledge: [], skillsDir: stores.paths.skills }
  const run = await createEngine(deps).start({ requirementId: req.id, workflow: { id: 'flow', title: '联调', version: '1', stages: [], nodes: [
    { kind: 'agent', id: 'write', title: '写规格', role: 'dev', prompt: '写规格', outputs: [{ path: 'spec/a.md', kind: 'spec' }] },
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
  expect(await request('/api/eval/scorecards')).toMatchObject([{ key: { nodeId: 'write' }, escapes: 0 }])
  const defect = await request(`/api/requirements/${req.id}/defects`, 'POST', { title: '边界缺失', description: '遗漏边界', severity: 'major', acs: ['AC-1'], reason: '记录边界问题' })
  expect(await request(`/api/requirements/${req.id}/defects`)).toHaveLength(1)
  expect(await request(`/api/requirements/${req.id}/defects/${defect.id}/attribute`, 'POST', testedModel ? { reason: '调查边界根因' } : undefined)).toMatchObject({ attributing: true })
  expect((await waitDefectAttribution(stores, req.id, defect.id)).status).toBe('attributed')
  expect(await request(`/api/requirements/${req.id}/defects/${defect.id}/confirm`, 'POST', { note: '人工确认', reason: '采纳归因' })).toMatchObject({ status: 'confirmed', attribution: { confirmed: { by: { type: 'human', id: 'web' } } } })
  expect(await request('/api/eval/cases/collect', 'POST', { includeDefects: true })).toHaveProperty('added')
  expect(await request('/api/eval/cases?target=node:flow/write')).toHaveLength(1)
  const started = await request('/api/eval/runs', 'POST', { target: { kind: 'node', workflowId: 'flow', nodeId: 'write' }, variants: [{ id: 'baseline', label: '基线' }], judge: { harness: 'mock', model: 'mock-judge' }, reason: '验证边界修复' })
  const finished = await waitEvalRun(stores, started.id)
  expect(await request(`/api/eval/runs/${started.id}`)).toMatchObject({ status: 'done', results: [{ pass: true }] })
  expect(await request('/api/eval/runs')).toHaveLength(1)
  const result = finished.results[0]!
  const outputUrl = `/api/eval/runs/${started.id}/output?case=${result.caseId}&variant=baseline`
  expect(await request(outputUrl)).toMatchObject({ files: expect.arrayContaining([{ path: 'spec/a.md', content: 'AC-1：已补边界说明' }]) })
  await writeFile(join(result.outputDir!, 'large.txt'), 'x'.repeat(200 * 1024 + 1))
  await writeFile(join(result.outputDir!, 'binary.bin'), Buffer.from([0, 255]))
  const output = await request(outputUrl)
  expect(output.files.find((file: { path: string }) => file.path === 'large.txt').content).toBe('x'.repeat(200 * 1024) + '\n[已截断：文件超过 200KB，仅显示前 200KB]')
  expect(output.files.some((file: { path: string }) => file.path === 'binary.bin')).toBe(false)
  for (const [url, status] of [
    [`/api/eval/runs/missing/output?case=${result.caseId}&variant=baseline`, 404],
    [`/api/eval/runs/${started.id}/output?case=missing&variant=baseline`, 404],
    [`/api/eval/runs/${started.id}/output?case=${result.caseId}&variant=missing`, 404],
    [`/api/eval/runs/${started.id}/output?case=..%2Fescape&variant=baseline`, 400],
    [`/api/eval/runs/${started.id}/output?case=${result.caseId}&variant=%2Ftmp`, 400],
  ] as const) expect((await fetch(server.url + url)).status).toBe(status)
  await symlink(join(root, 'takt.config.json'), join(result.outputDir!, 'escape.txt'))
  expect((await fetch(server.url + outputUrl)).status).toBe(400)
  await rm(join(result.outputDir!, 'escape.txt'))
  const recordPath = join(stores.taktDir, 'evals/runs', `${started.id}.json`)
  await writeFile(recordPath, JSON.stringify({ ...finished, results: [{ ...result, outputDir: root }] }))
  expect((await fetch(server.url + outputUrl)).status).toBe(400)
  await writeFile(recordPath, JSON.stringify(finished))
  await rm(result.outputDir!, { recursive: true })
  expect((await fetch(server.url + outputUrl)).status).toBe(404)
  const card = await request('/api/commands/eval.scorecards', 'POST', { input: { by: 'node' } })
  expect(card).toMatchObject({ ok: true, result: [{ key: { nodeId: 'write' }, escapes: 1 }] })
  const reported = await request('/api/commands/defect.report', 'POST', { input: { requirementId: req.id, title: '命令入口', description: '检查共享注册表', severity: 'minor' }, reason: '联调' })
  expect(reported).toMatchObject({ ok: true, result: { id: 'D-2' } })
  const reloaded = await openProject(root)
  expect((await reloaded.workspaces.listArtifacts(req.id)).some((artifact) => artifact.path === 'defects/D-2.md')).toBe(true)
  expect((await reloaded.workspaces.listArtifacts(req.id)).find((artifact) => artifact.path === 'defects/D-1.md')?.versions[0]?.reason).toBe('记录边界问题')
  const audit = (await readFile(join(stores.taktDir, 'space-events.jsonl'), 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(JSON.parse(line).data.message)).map((entry) => JSON.parse(entry.message))
    .filter((entry) => entry.phase === 'requested')
  for (const [id, reason] of [
    ['defect.report', '记录边界问题'], ['defect.attribute', testedModel ? '调查边界根因' : 'defect.attribute via web'],
    ['defect.confirm', '采纳归因'], ['eval.collect', 'eval.collect via web'], ['eval.run', '验证边界修复'],
  ]) expect(audit).toContainEqual(expect.objectContaining({ id, reason }))
}, 15000)
