import { createServer } from 'node:http'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import sdlc from '../../../../templates/workflows/sdlc.workflow.js'
import standard from '../../../../templates/workflows/taktflow-standard.workflow.js'
import { initProject, openProject } from '../store/project.js'
import type { AgentProfile, HarnessAdapter, LoopNodeDef, TaktConfig, WorkflowDefinition } from '../types.js'
import { createEngine } from './index.js'

const roots: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`
const nodeCommand = (s: string) => `${quote(process.execPath)} -e ${quote(s)}`
const read = (root: string, path: string) => readFile(join(root, path), 'utf8')
const count = async (root: string, path: string) => (await read(root, path)).trim().split('\n').length
const envNodes = (template: WorkflowDefinition) => {
  const loop = template.nodes.find((node) => node.id === 'dev-test-loop') as LoopNodeDef
  const get = (id: string) => [...template.nodes, ...loop.body].find((node) => node.id === id)!
  return { loop, get }
}

async function fixture(environment?: TaktConfig['environment'], template = sdlc, rounds = 1) {
  const root = await mkdtemp(join(tmpdir(), 'takt-environment-'))
  roots.push(root)
  const stores = await initProject(root)
  stores.config.environment = environment
  await writeFile(join(root, 'takt.config.json'), JSON.stringify(stores.config))
  const requirementId = (await stores.workspaces.createRequirement({ title: '部署验收' })).id
  const workspace = stores.workspaces.dir(requirementId)
  const put = (path: string, content: string) => stores.workspaces.writeArtifact({ ref: { workspace: requirementId, path }, content, kind: 'other', author: { type: 'system', id: 'test' } })
  const program = `import {writeFile,appendFile,mkdir} from 'node:fs/promises';
await appendFile('cases-ran','x\\n');
await mkdir(process.env.TAKT_WORKSPACE+'/evidence',{recursive:true});
await writeFile(process.env.TAKT_WORKSPACE+'/evidence/summary.json',JSON.stringify({cases:[{id:'TC-1',status:'passed'}]}));
if (process.env.TEST_TOKEN) console.log(process.env.TEST_TOKEN);
if (process.env.TAKT_ENV_URL) await writeFile('received-url',process.env.TAKT_ENV_URL);`
  await mkdir(join(root, 'tests'))
  await writeFile(join(root, 'tests/run-cases.mjs'), program)
  await put('scripts/run-cases.mjs', program)
  await put('cases/TC-1.json', JSON.stringify({ id: 'TC-1', covers: ['AC-1'] }))
  const harness: HarnessAdapter = { id: 'mock', displayName: '不应调用模型', available: async () => ({ ok: true }), run: vi.fn(async () => { throw new Error('环境判决不得调用模型') }) }
  const profiles: Record<string, AgentProfile> = { judge: { role: 'judge', title: '', description: '', instructions: '', harness: { harness: 'mock' }, skills: [], writeScope: [] } }
  const deps = { stores, profiles, harnesses: { mock: harness }, knowledge: [] }
  const { loop, get } = envNodes(template)
  const judge = get('judge')
  if (judge.kind !== 'judge') throw new Error('缺少判决')
  const workflow: WorkflowDefinition = { id: 'environment-test', title: '', version: '1', stages: template.stages, nodes: [
    { ...get('env-setup'), needs: [] },
    { ...loop, needs: ['env-setup'], maxIterations: 3, until: (ctx) => (ctx.iteration ?? 1) >= rounds,
      body: [get('deploy-env'), get('run-cases'), { ...judge, routes: { env_issue: 'human' } }] },
    get('env-teardown'),
  ] }
  const engine = createEngine(deps)
  const start = () => engine.start({ workflow, requirementId, args: { caseCommand: `${quote(process.execPath)} tests/run-cases.mjs` } })
  return { root, stores, requirementId, workspace, workflow, engine, start, deps, harness }
}

it.each([sdlc, standard])('$id：未配置时三个环境节点 skipped，原用例继续执行', async (template) => {
  const f = await fixture(undefined, template)
  const state = await f.start()
  expect(state.status).toBe('succeeded')
  for (const id of ['env-setup', 'dev-test-loop/deploy-env', 'env-teardown']) expect(state.nodes[id]?.status).toBe('skipped')
  expect(await count(f.root, 'cases-ran')).toBe(1)
  await expect(access(join(f.workspace, 'evidence/env'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each([sdlc, standard])('$id：每轮重新部署；setup 一次，结束 teardown 一次', async (template) => {
  const f = await fixture({ setup: 'echo setup >> setup-count', deploy: 'echo deploy >> deploy-count', healthcheck: { command: 'test -f deploy-count' }, teardown: 'echo teardown >> teardown-count' }, template, 2)
  const state = await f.start()
  expect(state.status).toBe('succeeded')
  expect(await count(f.root, 'setup-count')).toBe(1)
  expect(await count(f.root, 'deploy-count')).toBe(2)
  expect(await count(f.root, 'teardown-count')).toBe(1)
  for (const round of [1, 2]) {
    const evidence = JSON.parse(await read(f.workspace, `evidence/env/round-${round}.json`))
    expect(evidence).toMatchObject({ ok: true, round, attempts: [{ deploy: { code: 0 }, healthcheck: { status: 'passed' } }] })
    expect(await f.stores.workspaces.readArtifact({ workspace: f.requirementId, path: `evidence/env/round-${round}.json` })).toBeDefined()
  }
  expect(await f.stores.events.verify(state.runId)).toEqual({ ok: true })
})

it.each([sdlc, standard])('$id：部署重试失败不运行用例，生成 env_issue 并交人；拒绝后回收', async (template) => {
  const f = await fixture({ deploy: 'echo attempt >> deploy-count; echo deployment-error; exit 17', teardown: 'echo cleanup >> teardown-count' }, template)
  await mkdir(join(f.workspace, 'evidence'))
  await writeFile(join(f.workspace, 'evidence/summary.json'), '{"cases":[{"id":"TC-OLD","status":"passed"}]}')
  const state = await f.start()
  expect(state.status).toBe('waiting_human')
  expect(await count(f.root, 'deploy-count')).toBe(2)
  await expect(access(join(f.root, 'cases-ran'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(state.nodes['dev-test-loop/run-cases']?.result).toEqual({ total: 0, failures: [{ subject: 'environment', status: 'error', evidence: 'evidence/env/round-1.json' }] })
  expect(state.nodes['dev-test-loop/judge']?.result).toMatchObject({ verdicts: [{ category: 'env_issue', subject: 'environment' }] })
  expect(f.harness.run).not.toHaveBeenCalled()
  expect(await read(f.workspace, 'evidence/summary.json')).not.toContain('TC-OLD')
  const [item] = await f.stores.attention.list({ pending: true })
  await f.stores.attention.answer(item!.requestId, { decision: 'reject', by: { type: 'human', id: 'test' } })
  const finished = await f.engine.resume(state.runId, f.workflow)
  expect(finished.status).toBe('failed')
  expect(finished.nodes['env-teardown']?.status).toBe('succeeded')
  expect(await count(f.root, 'teardown-count')).toBe(1)
})

it('第一次部署失败、重试成功后运行用例', async () => {
  const f = await fixture({ deploy: 'if test -f attempted; then exit 0; else touch attempted; exit 1; fi' })
  expect((await f.start()).status).toBe('succeeded')
  const evidence = JSON.parse(await read(f.workspace, 'evidence/env/round-1.json'))
  expect(evidence.attempts.map((attempt: any) => attempt.deploy.code)).toEqual([1, 0])
  expect(await count(f.root, 'cases-ran')).toBe(1)
})

it('命令就绪检查总超时会杀掉进程组，并重试后转 env_issue', async () => {
  const f = await fixture({ deploy: 'true', healthcheck: { command: "echo checking; sleep 30 & wait", timeoutMs: 120 } })
  const state = await f.start()
  expect(state.status).toBe('waiting_human')
  const evidence = JSON.parse(await read(f.workspace, 'evidence/env/round-1.json'))
  expect(evidence.attempts).toHaveLength(2)
  for (const attempt of evidence.attempts) {
    expect(attempt.healthcheck).toMatchObject({ status: 'failed', probes: [{ code: -1, timedOut: true }] })
    expect(attempt.healthcheck.probes[0].output).toContain('checking')
  }
})

it('URL 检查成功后向用例注入 TAKT_ENV_URL；请求挂起也受超时限制', async () => {
  const server = createServer((req, res) => { if (req.url === '/health') { res.writeHead(200); res.end('ok') } })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const url = `http://127.0.0.1:${address.port}/health`
  try {
    const good = await fixture({ deploy: 'true', healthcheck: { url, timeoutMs: 2000 } })
    expect((await good.start()).status).toBe('succeeded')
    expect(await read(good.root, 'received-url')).toBe(url)
    const bad = await fixture({ deploy: 'true', healthcheck: { url: url + '-hang', timeoutMs: 200 } })
    expect((await bad.start()).status).toBe('waiting_human')
    expect(JSON.parse(await read(bad.workspace, 'evidence/env/round-1.json')).attempts).toHaveLength(2)
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
})

it('等待人工处理后重建引擎取消，回收仍执行且重复取消不重做', async () => {
  const f = await fixture({ setup: 'echo setup >> setup-count', deploy: 'exit 1', teardown: 'echo cleanup >> teardown-count' })
  const state = await f.start()
  const engine = createEngine(f.deps)
  await engine.cancel(state.runId)
  await engine.cancel(state.runId)
  expect((await f.stores.runs.get(state.runId))?.status).toBe('cancelled')
  expect((await f.stores.runs.get(state.runId))?.nodes['env-teardown']?.status).toBe('succeeded')
  expect(await count(f.root, 'teardown-count')).toBe(1)
})

it.each(['setup', 'deploy', 'healthcheck', 'teardown'] as const)('%s 执行中取消：杀掉子进程，随后独立信号执行回收', async (phase) => {
  const hang = nodeCommand("const fs=require('fs');fs.writeFileSync('started',String(process.pid));setTimeout(()=>fs.writeFileSync('late','leak'),800);setInterval(()=>{},1000)")
  const f = await fixture({
    setup: phase === 'setup' ? hang : undefined,
    deploy: phase === 'deploy' ? hang : 'true',
    healthcheck: phase === 'healthcheck' ? { command: hang } : undefined,
    teardown: phase === 'teardown' ? `if test -f cleanup-started; then echo cleanup >> teardown-count; else touch cleanup-started; ${hang}; fi` : 'echo cleanup >> teardown-count',
  })
  const running = f.start()
  await vi.waitFor(async () => expect(Number(await read(f.root, 'started'))).toBeGreaterThan(0), { timeout: 5000 })
  const pid = Number(await read(f.root, 'started'))
  const [state] = await f.stores.runs.list()
  await f.engine.cancel(state!.runId)
  const finished = await running
  expect(finished.status).toBe('cancelled')
  expect(await count(f.root, 'teardown-count')).toBe(1)
  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow())
  await new Promise((resolve) => setTimeout(resolve, 850))
  await expect(access(join(f.root, 'late'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await f.stores.events.verify(finished.runId)).toEqual({ ok: true })
})

it('setup 失败仍回收；回收非零只记日志，不改运行原始结论', async () => {
  const failed = await fixture({ setup: 'exit 3', deploy: 'true', teardown: 'echo done > cleanup; exit 4' })
  expect((await failed.start()).status).toBe('failed')
  expect(await read(failed.root, 'cleanup')).toContain('done')
  const success = await fixture({ deploy: 'true', teardown: 'echo done > cleanup; exit 4' })
  const state = await success.start()
  expect(state.status).toBe('succeeded')
  expect(JSON.stringify(await success.stores.events.read(state.runId))).toContain('环境回收失败（仅记录）')
})

it('部署、健康检查、回收和用例日志中的宿主引用及直接配置值脱敏，尾部不超过 4KB', async () => {
  const secret = 'test-only-env-secret-abc123'
  vi.stubEnv('TAKT_TEST_SECRET', secret)
  const f = await fixture({ setup: 'echo "$TEST_TOKEN"', deploy: nodeCommand(`process.stdout.write('x'.repeat(8000)+process.env.TEST_TOKEN+'tail')`),
    healthcheck: { command: `echo "$TEST_TOKEN"; echo literal-test-secret` }, teardown: 'echo "$TEST_TOKEN"',
    env: { TEST_TOKEN: '${TAKT_TEST_SECRET}', DIRECT_TOKEN: 'literal-test-secret' } })
  const state = await f.start()
  expect(state.status).toBe('succeeded')
  const evidenceText = await read(f.workspace, 'evidence/env/round-1.json')
  const eventText = JSON.stringify(await f.stores.events.read(state.runId))
  for (const text of [evidenceText, eventText]) {
    expect(text).not.toContain(secret)
    expect(text).not.toContain('literal-test-secret')
    expect(text).toContain('[REDACTED]')
  }
  expect(Buffer.byteLength(JSON.parse(evidenceText).attempts[0].deploy.output)).toBeLessThanOrEqual(4096)
})

it('标准模板在集成 worktree 执行准备、部署、用例和回收', async () => {
  const f = await fixture({ setup: 'pwd > setup-cwd', deploy: 'pwd > deploy-cwd', teardown: 'pwd > teardown-cwd' }, standard)
  const integrated = join(f.root, 'integrated')
  await mkdir(integrated)
  f.workflow.nodes.unshift({ id: 'integration', kind: 'script', title: '', run: async () => ({ data: { path: integrated } }) })
  f.workflow.nodes.find((node) => node.id === 'env-setup')!.needs = ['integration']
  expect((await f.start()).status).toBe('succeeded')
  for (const file of ['setup-cwd', 'deploy-cwd', 'teardown-cwd']) expect((await read(integrated, file)).trim()).toBe(await realpath(integrated))
  expect(await count(integrated, 'cases-ran')).toBe(1)
})

it('环境失败交人后恢复：setup 不重复，下一轮重新部署', async () => {
  const f = await fixture({ setup: 'echo setup >> setup-count', deploy: 'test -f repaired', teardown: 'echo cleanup >> teardown-count' }, sdlc, 2)
  const state = await f.start()
  const [item] = await f.stores.attention.list({ pending: true })
  await writeFile(join(f.root, 'repaired'), '')
  await f.stores.attention.answer(item!.requestId, { decision: 'approve', by: { type: 'human', id: 'test' } })
  const restored = createEngine(f.deps)
  expect((await restored.resume(state.runId, f.workflow)).status).toBe('succeeded')
  expect(await count(f.root, 'setup-count')).toBe(1)
  expect(await count(f.root, 'teardown-count')).toBe(1)
  expect(JSON.parse(await read(f.workspace, 'evidence/env/round-2.json')).ok).toBe(true)
})

it.each([
  { deploy: '' }, { deploy: 'true', healthcheck: {} },
  { deploy: 'true', healthcheck: { url: 'http://localhost', command: 'true' } },
  { deploy: 'true', healthcheck: { url: 'file:///tmp/test' } },
  { deploy: 'true', healthcheck: { command: 'true', timeoutMs: 0 } },
  { deploy: 'true', env: { BAD: 12 } },
])('非法环境配置在加载时拒绝：%j', async (environment) => {
  const f = await fixture()
  await writeFile(join(f.root, 'takt.config.json'), JSON.stringify({ ...f.stores.config, environment }))
  await expect(openProject(f.root)).rejects.toThrow('environment.')
})

it('就绪探测两秒后再检查，成功即继续，不额外重部署', async () => {
  const f = await fixture({ deploy: 'echo deploy >> deploy-count', healthcheck: { command: 'if test -f probed; then exit 0; else touch probed; exit 1; fi', timeoutMs: 5000 } })
  expect((await f.start()).status).toBe('succeeded')
  const evidence = JSON.parse(await read(f.workspace, 'evidence/env/round-1.json'))
  expect(evidence.attempts).toHaveLength(1)
  expect(evidence.attempts[0].healthcheck.probes.map((probe: { code: number }) => probe.code)).toEqual([1, 0])
  expect(evidence.attempts[0].healthcheck.durationMs).toBeGreaterThanOrEqual(2000)
  expect(await count(f.root, 'deploy-count')).toBe(1)
})

it('第二轮部署应用修复后的代码；用例阶段失败也触发回收', async () => {
  const f = await fixture({ deploy: 'cp source-version deployed-version', teardown: 'echo cleanup >> teardown-count' }, standard, 2)
  await writeFile(join(f.root, 'source-version'), '1')
  const loop = f.workflow.nodes.find((node) => node.kind === 'loop') as LoopNodeDef
  loop.body.push({ id: 'repair', kind: 'script', title: '', needs: ['judge'], run: async (ctx) => {
    expect(await read(f.root, 'deployed-version')).toBe(String(ctx.iteration))
    if (ctx.iteration === 1) await writeFile(join(f.root, 'source-version'), '2')
    else throw new Error('用例阶段终止')
  } })
  const state = await f.start()
  expect(state.status).toBe('failed')
  expect(state.nodes['dev-test-loop/repair']?.error).toBe('用例阶段终止')
  expect(await read(f.root, 'deployed-version')).toBe('2')
  expect(await count(f.root, 'teardown-count')).toBe(1)
})

it('脱敏覆盖 UTF-8 分段输出及截断边界，宿主变量不会被修改', async () => {
  const secret = '测试变量值🙂-' + 's'.repeat(80)
  vi.stubEnv('TAKT_TEST_UNICODE', secret)
  const f = await fixture({ deploy: nodeCommand("const b=Buffer.from(process.env.TOKEN);process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(Buffer.concat([b.subarray(2),Buffer.from('终'.repeat(1380))])),10)"), env: { TOKEN: '${TAKT_TEST_UNICODE}' } })
  expect((await f.start()).status).toBe('succeeded')
  const output = JSON.parse(await read(f.workspace, 'evidence/env/round-1.json')).attempts[0].deploy.output
  expect(output).not.toContain('sssss')
  expect(output).not.toContain('\ufffd')
  expect(Buffer.byteLength(output)).toBeLessThanOrEqual(4096)
  expect(process.env.TAKT_TEST_UNICODE).toBe(secret)
})
