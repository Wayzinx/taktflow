import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createEngine, initProject, openProject, waitDefectAttribution, waitEvalRun, type AgentProfile, type EngineDeps, type HarnessAdapter } from '@taktflow/core'
import { createServer, type RunningServer } from './index.js'

const roots: string[] = [], servers: RunningServer[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

it('正式 server 入口可达全部评测路由，共享命令可执行，节点配方与确认后成绩单可回读', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-eval-wiring-http-')); roots.push(root)
  const stores = await initProject(root)
  const req = await stores.workspaces.createRequirement({ title: '入口联调' })
  const profiles = Object.fromEntries(['dev', 'auditor', 'evaluator'].map((role): [string, AgentProfile] => [role, {
    role, title: role, description: '', instructions: '', skills: [], writeScope: ['**'], harness: { harness: 'mock', model: role === 'evaluator' ? 'judge' : 'tested' },
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
    const response = await fetch(server.url + path, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify({ reason: '接口联调', ...(data as object ?? {}) }) })
    const result = await response.json()
    expect(response.status, JSON.stringify(result)).toBe(200)
    return result
  }
  const commands = await request('/api/commands')
  expect(commands.map((value: { id: string }) => value.id)).toEqual(expect.arrayContaining(['eval.scorecards', 'eval.collect', 'eval.run', 'defect.report', 'defect.attribute', 'defect.confirm']))
  expect((await request(`/api/runs/${run.runId}/nodes/write`)).recipe).toMatchObject({ nodeId: 'write', role: 'dev', harness: 'mock', recipeKey: expect.any(String) })
  expect(await request('/api/eval/scorecards')).toMatchObject([{ key: { nodeId: 'write' }, escapes: 0 }])
  const defect = await request(`/api/requirements/${req.id}/defects`, 'POST', { title: '边界缺失', description: '遗漏边界', severity: 'major', acs: ['AC-1'] })
  expect(await request(`/api/requirements/${req.id}/defects`)).toHaveLength(1)
  expect(await request(`/api/requirements/${req.id}/defects/${defect.id}/attribute`, 'POST')).toMatchObject({ attributing: true })
  expect((await waitDefectAttribution(stores, req.id, defect.id)).status).toBe('attributed')
  expect(await request(`/api/requirements/${req.id}/defects/${defect.id}/confirm`, 'POST', { note: '人工确认' })).toMatchObject({ status: 'confirmed', attribution: { confirmed: { by: { type: 'human', id: 'web' } } } })
  expect(await request('/api/eval/cases/collect', 'POST', { includeDefects: true })).toHaveProperty('added')
  expect(await request('/api/eval/cases?target=node:flow/write')).toHaveLength(1)
  const started = await request('/api/eval/runs', 'POST', { target: { kind: 'node', workflowId: 'flow', nodeId: 'write' }, variants: [{ id: 'baseline', label: '基线' }], judge: { harness: 'mock', model: 'judge' } })
  await waitEvalRun(stores, started.id)
  expect(await request(`/api/eval/runs/${started.id}`)).toMatchObject({ status: 'done', results: [{ pass: true }] })
  expect(await request('/api/eval/runs')).toHaveLength(1)
  const card = await request('/api/commands/eval.scorecards', 'POST', { input: { by: 'node' } })
  expect(card).toMatchObject({ ok: true, result: [{ key: { nodeId: 'write' }, escapes: 1 }] })
  const reported = await request('/api/commands/defect.report', 'POST', { input: { requirementId: req.id, title: '命令入口', description: '检查共享注册表', severity: 'minor' }, reason: '联调' })
  expect(reported).toMatchObject({ ok: true, result: { id: 'D-2' } })
  const reloaded = await openProject(root)
  expect((await reloaded.workspaces.listArtifacts(req.id)).some((artifact) => artifact.path === 'defects/D-2.md')).toBe(true)
}, 15000)
