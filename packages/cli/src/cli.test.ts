import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createInsights, openProject, type AttentionItem, type RunState } from '@taktflow/core'
import { repoRoot } from './project.js'

const entry = join(repoRoot, 'packages/cli/src/index.ts')
const deps = realpathSync(join(repoRoot, 'node_modules'))
const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'takt-cli-'))
  temporary.push(dir)
  return dir
}

async function cli(project: string, args: string[], input?: Buffer, target = entry) {
  const child = spawn(process.execPath, ['--import', 'tsx', target, '--project', project, ...args], { cwd: repoRoot, stdio: 'pipe' })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  child.stdin.end(input)
  const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
  return { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString() }
}

async function json<T = any>(project: string, args: string[], expectedCode = 0): Promise<T> {
  const result = await cli(project, [...args, '--json'])
  expect(result.code, result.stdout.toString() + result.stderr).toBe(expectedCode)
  // JSON.parse 校验 stdout 是完整的单个 JSON，不能混入进度或第二份结果。
  return JSON.parse(result.stdout.toString()) as T
}

async function init(): Promise<string> {
  const dir = await temp()
  await json(dir, ['init', '--layout', 'legacy', '--name', '外部项目'])
  return dir
}

async function runtimeProject(nodes: string): Promise<string> {
  const dir = await init()
  await writeFile(join(dir, 'package.json'), JSON.stringify({ type: 'module' }))
  await symlink(deps, join(dir, 'node_modules'), 'dir')
  await writeFile(join(dir, 'takt.config.json'), JSON.stringify({ project: { name: 'test' }, workflows: [] }))
  await writeFile(join(dir, 'custom.workflow.ts'), `import { defineWorkflow } from '@taktflow/core'\nexport default defineWorkflow({ id: 'custom', title: '自定义', version: '1', stages: [{id:'build',title:'构建'}], nodes: ${nodes} })\n`)
  await json(dir, ['req', 'new', 'test'])
  return dir
}

const human = `{ id: 'approval', kind: 'human', title: '审批', stage: 'build', ask: '继续？', form: 'approve' }`
const agent = `{ id: 'work', kind: 'agent', title: '执行', stage: 'build', role: 'dev', needs: ['approval'], prompt: 'do work', outputs: [{path: 'tasks/done.md', kind: 'task'}] }`
const inspectOptions = `{ id: 'inspect', kind: 'script', title: '选项已落盘', run: async (ctx) => { const { readFile } = await import('node:fs/promises'); const opts = JSON.parse(await readFile(ctx.projectDir + '/.takt/runs/' + ctx.runId + '/cli.json', 'utf8')); if (!opts.workflowPath || opts.harness !== 'mock' || !opts.mock) throw new Error('CLI options missing before execution'); } }`
async function mockFile(dir: string, name = 'outside-mock.json', content = 'done'): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, JSON.stringify({ steps: [{ match: { nodeId: 'work' }, writes: { '{{workspace}}/tasks/done.md': content }, finalText: 'done' }] }))
  return path
}

type State = RunState & { attention: AttentionItem[] }

it('init 在无 package.json 的外部项目中可用；坏 workflow 不阻断 store 命令；产物保留原始字节和目标 git 作者', async () => {
  const dir = await init()
  const workflow = join(dir, '.takt/workflows/sdlc.workflow.ts')
  await writeFile(workflow, 'invalid workflow sentinel')
  await writeFile(join(dir, '.takt/agents/dev.md'), 'custom agent sentinel')
  await json(dir, ['init'])
  expect(await readFile(workflow, 'utf8')).toBe('invalid workflow sentinel')
  expect(await readFile(join(dir, '.takt/agents/dev.md'), 'utf8')).toBe('custom agent sentinel')
  await mkdir(join(dir, '.git'))
  await writeFile(join(dir, '.git/config'), '[user]\n  name = Target Project User\n')
  // 用完整的本地 git 初始化结构，让 git config 识别目标仓库。
  await mkdir(join(dir, '.git/objects'))
  await mkdir(join(dir, '.git/refs'))
  await writeFile(join(dir, '.git/HEAD'), 'ref: refs/heads/main\n')
  expect((await json(dir, ['req', 'new', '需求', '--link', 'https://example.org/req'])).id).toBe('REQ-001')
  expect(await json(dir, ['req', 'ls'])).toHaveLength(1)
  const bytes = Buffer.from([0, 255, 65, 13, 10, 66])
  const written = await cli(dir, ['ws', 'put', 'REQ-001', 'inputs/raw.bin', '-', '--reason', '原始输入', '--json'], bytes)
  expect(written.code, written.stderr).toBe(0)
  expect((await cli(dir, ['ws', 'get', 'REQ-001', 'inputs/raw.bin'])).stdout).toEqual(bytes)
  expect((await json(dir, ['ws', 'get', 'REQ-001', 'inputs/raw.bin', '--version', '1'])).content).toBe(bytes.toString('base64'))
  expect(await json(dir, ['ws', 'ls', 'REQ-001'])).toHaveLength(1)
  const history = await json(dir, ['ws', 'log', 'REQ-001', 'inputs/raw.bin'])
  expect(history[0]).toMatchObject({ author: { type: 'human', id: 'Target Project User' }, reason: '原始输入' })
  expect(await json(dir, ['status'])).toHaveLength(1)
  expect(await json(dir, ['trace', 'REQ-001'])).toMatchObject({ edges: [], acCoverage: [] })
  expect(await json(dir, ['kb', 'query', 'nothing', '--intent', 'business'])).toEqual([])
  expect(await json(dir, ['audit', 'verify', 'missing'], 1)).toMatchObject({ ok: false })
}, 30000)

it('命令参数错误用非零退出码和单个 JSON 返回', async () => {
  const dir = await temp()
  for (const args of [ ['run'], ['run', 'x', 'y'], ['req', 'ls', 'extra'], ['serve', '--port', '65536'], ['kb', 'query', 'x', '--intent', 'wrong'], ['answer', 'q', '--approve', '--reject'], ['run', 'x'], ['--unknown'] ]) {
    expect((await json(dir, args, 2)).error).toBeTruthy()
  }
}, 30000)

it('symlink 入口可执行；导入入口不运行 CLI', async () => {
  const dir = await temp()
  const link = join(dir, 'takt.ts')
  await symlink(entry, link)
  const result = await cli(dir, ['--help'], undefined, link)
  expect(result.code).toBe(0)
  expect(result.stdout.toString()).toContain('用法：takt')
  const probe = join(dir, 'probe.mjs')
  await writeFile(probe, `await import(${JSON.stringify(entry)}); process.stdout.write('imported')`)
  const imported = await cli(dir, [], undefined, probe)
  expect(imported.code).toBe(0)
  expect(imported.stdout.toString()).toBe('imported')
})

it('直接相对路径从另一 cwd 启动；answer 自动恢复原 workflow/harness/mock；重复回答不改记录', async () => {
  const dir = await runtimeProject(`[${inspectOptions}, ${human}, ${agent}]`)
  const mock = await mockFile(dir)
  const run = await json<State>(dir, ['run', './custom.workflow.ts', '--req', 'REQ-001', '--harness', 'mock', '--mock', relative(repoRoot, mock), '--arg', 'x=1', '--arg', 'x=2'])
  expect(run.status).toBe('waiting_human')
  expect(run.nodes.inspect?.status).toBe('succeeded')
  expect(run.args).toEqual({ x: '2' })
  const optionsPath = join(dir, '.takt/runs', run.runId, 'cli.json')
  expect(JSON.parse(await readFile(optionsPath, 'utf8'))).toEqual({ workflowPath: join(dir, 'custom.workflow.ts'), harness: 'mock', mock })
  const request = run.attention[0]!.requestId
  expect((await json(dir, ['answer', request, '--choice', 'bad'], 2)).error).toContain('不接受')
  await expect((await openProject(dir)).attention.list({ pending: true }).then((items) => items.length)).resolves.toBe(1)
  const resumed = await json<State>(dir, ['answer', request, '--approve'])
  expect(resumed.status).toBe('succeeded')
  await expect((await openProject(dir)).workspaces.readArtifact({ workspace: 'REQ-001', path: 'tasks/done.md' }).then((b) => b?.toString())).resolves.toBe('done')
  expect((await json(dir, ['answer', request, '--reject'], 1)).error).toContain('已处理')
  expect((await (await openProject(dir)).attention.list())[0]?.decision).toBe('approve')
  expect((await json(dir, ['audit', 'verify', run.runId])).ok).toBe(true)
  // status 读取运行快照，当前 workflow 已坏也能显示阶段。
  await writeFile(join(dir, 'takt.config.json'), JSON.stringify({ project: { name: 'test' }, workflows: ['missing.ts'] }))
  expect((await json(dir, ['status']))[0].stages[0]).toMatchObject({ id: 'build', status: 'done' })
}, 30000)

it('no-resume 留在等待态；resume 覆盖 mock 写回并用于随后无选项恢复', async () => {
  const dir = await runtimeProject(`[${human}, ${agent}]`)
  const original = await mockFile(dir)
  const replacement = await mockFile(dir, 'new-mock.json', 'replacement')
  const run = await json<State>(dir, ['run', 'custom.workflow.ts', '--req', 'REQ-001', '--harness', 'mock', '--mock', original])
  expect((await json<State>(dir, ['resume', run.runId, '--mock', replacement])).status).toBe('waiting_human')
  expect(JSON.parse(await readFile(join(dir, '.takt/runs', run.runId, 'cli.json'), 'utf8')).mock).toBe(replacement)
  await json(dir, ['answer', run.attention[0]!.requestId, '--approve', '--no-resume'])
  expect((await (await openProject(dir)).runs.get(run.runId))?.status).toBe('waiting_human')
  expect((await json<State>(dir, ['resume', run.runId])).status).toBe('succeeded')
  expect(await readFile(join(dir, '.takt/workspaces/REQ-001/tasks/done.md'), 'utf8')).toBe('replacement')
}, 30000)

it('choice 和文本回答完成相应表单；reject 的默认恢复返回 failed 和非零', async () => {
  const dir = await runtimeProject(`[
    { id: 'pick', kind: 'human', title: '选择', ask: '选一个', form: 'choice', choices: ['a', 'b'] },
    { id: 'text', kind: 'human', title: '回答', needs: ['pick'], ask: '说明', form: 'answer' },
    { id: 'approval', kind: 'human', title: '批准', needs: ['text'], ask: '继续', form: 'approve' }
  ]`)
  const run = await json<State>(dir, ['run', 'custom.workflow.ts', '--req', 'REQ-001'])
  const pick = run.attention[0]!.requestId
  expect((await json(dir, ['answer', pick, '--choice', 'invalid'], 2)).error).toContain('必须')
  const text = await json<State>(dir, ['answer', pick, '--choice', 'b'])
  expect(text.nodes.pick?.status).toBe('succeeded')
  const approval = await json<State>(dir, ['answer', text.attention[0]!.requestId, '--answer', '确认边界'])
  expect(approval.nodes.text?.status).toBe('succeeded')
  const rejected = await json<State>(dir, ['answer', approval.attention[0]!.requestId, '--reject'], 1)
  expect(rejected.status).toBe('failed')
  const answers = await (await openProject(dir)).attention.list()
  expect(answers.find((item) => item.nodeId === 'pick')?.answer).toBe('b')
  expect(answers.find((item) => item.nodeId === 'text')?.answer).toBe('确认边界')
}, 30000)

it('failed / cancelled 运行返回非零；audit 拒绝篡改', async () => {
  const dir = await runtimeProject(`[{ id: 'bad', kind: 'script', title: '失败', run: async () => { throw new Error('expected failure') } }]`)
  const run = await json<State>(dir, ['run', 'custom.workflow.ts', '--req', 'REQ-001'], 1)
  expect(run.status).toBe('failed')
  expect((await json<State>(dir, ['resume', run.runId], 1)).status).toBe('failed')
  const stores = await openProject(dir)
  await stores.runs.save({ ...run, status: 'cancelled' })
  expect((await json<State>(dir, ['resume', run.runId], 1)).status).toBe('cancelled')
  const log = join(dir, '.takt/runs', run.runId, 'events.jsonl')
  const lines = (await readFile(log, 'utf8')).trim().split('\n')
  const first = JSON.parse(lines[0]!)
  first.data.workflowId = 'tampered'
  lines[0] = JSON.stringify(first)
  await writeFile(log, `${lines.join('\n')}\n`)
  expect(await json(dir, ['audit', 'verify', run.runId], 1)).toMatchObject({ ok: false, brokenAt: 1 })
}, 30000)

it('serve HTTP 回答后在进程内恢复 direct workflow 和保存的 mock', async () => {
  const dir = await runtimeProject(`[${human}, ${agent}]`)
  const mock = await mockFile(dir)
  const run = await json<State>(dir, ['run', 'custom.workflow.ts', '--req', 'REQ-001', '--harness', 'mock', '--mock', mock])
  const { createServer } = await import('@taktflow/server')
  const { loadRuntime } = await import('./project.js')
  const { resumeAfterAnswer } = await import('./commands/serve.js')
  const context = await loadRuntime(dir)
  const server = await createServer({ projectDir: dir, host: '127.0.0.1', port: 0, onAnswer: (item) => resumeAfterAnswer(context, item) })
  try {
    const response = await fetch(`${server.url}/api/attention/${run.attention[0]!.requestId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'approve' }) })
    expect(response.status, await response.text()).toBe(200)
    expect((await (await openProject(dir)).runs.get(run.runId))?.status).toBe('succeeded')
    expect(await readFile(join(dir, '.takt/workspaces/REQ-001/tasks/done.md'), 'utf8')).toBe('done')
  } finally { await server.close() }
}, 30000)

async function copyCleanExample(source: string, destination: string): Promise<void> {
  const generated = new Set(['runs', 'objects', 'workspaces', 'attention.jsonl'])
  await cp(source, destination, {
    recursive: true,
    filter: (path) => {
      const parts = relative(source, path).split(/[\\/]/)
      return !parts.includes('node_modules') && !parts.includes('.git') && !(parts[0] === '.takt' && generated.has(parts[1] ?? ''))
    },
  })
  await cp(join(destination, 'fixtures/greet.buggy.js'), join(destination, 'src/greet.js'))
  await symlink(deps, join(destination, 'node_modules'), 'dir')
}

it('复制 demo 后的脏 example 时排除生成状态和依赖链接，恢复 bug 并保留配置', async () => {
  const source = await temp()
  await cp(join(repoRoot, 'examples/hello-delivery'), source, { recursive: true, filter: (path) => basename(path) !== 'node_modules' })
  for (const name of ['runs', 'objects', 'workspaces']) {
    await mkdir(join(source, '.takt', name), { recursive: true })
    await writeFile(join(source, '.takt', name, 'sentinel'), 'stale')
  }
  await writeFile(join(source, '.takt/attention.jsonl'), 'stale')
  await writeFile(join(source, 'src/greet.js'), 'fixed')
  await symlink(deps, join(source, 'node_modules'), 'dir')
  const destination = await temp()
  await copyCleanExample(source, destination)
  for (const path of ['runs/sentinel', 'objects/sentinel', 'workspaces/sentinel', 'attention.jsonl']) {
    await expect(readFile(join(destination, '.takt', path))).rejects.toMatchObject({ code: 'ENOENT' })
  }
  expect(await readFile(join(destination, 'src/greet.js'), 'utf8')).toBe(await readFile(join(destination, 'fixtures/greet.buggy.js'), 'utf8'))
  expect(realpathSync(join(destination, 'node_modules'))).toBe(deps)
  for (const path of ['agents/dev.md', 'workflows/sdlc.workflow.ts', 'mock.json']) {
    expect(await readFile(join(destination, '.takt', path), 'utf8')).toBe(await readFile(join(source, '.takt', path), 'utf8'))
  }
})

it('完整示例 run --json：成功、迭代两轮、审计和质量报告，再严格要求一个原始 judge.verdict', async () => {
  const dir = await temp()
  await copyCleanExample(join(repoRoot, 'examples/hello-delivery'), dir)
  const req = await json(dir, ['req', 'new', '问候语支持空名字'])
  expect(req.id).toBe('REQ-001')
  await json(dir, ['ws', 'put', req.id, 'inputs/prd.md', join(dir, 'fixtures/prd.md'), '--kind', 'input'])
  const run = await json<State>(dir, ['run', 'sdlc', '--req', req.id, '--harness', 'mock', '--auto-approve'])
  expect(run.status).toBe('succeeded')
  expect(run.nodes['dev-test-loop']?.iteration).toBe(2)
  expect((await json(dir, ['audit', 'verify', run.runId])).ok).toBe(true)
  const stores = await openProject(dir)
  expect((await stores.workspaces.readArtifact({ workspace: req.id, path: 'reports/quality.md' }))?.length).toBeGreaterThan(0)
  const trace = await json(dir, ['trace', req.id])
  expect(trace.acCoverage).toHaveLength(2)
  expect(trace.edges.length).toBeGreaterThan(0)
  expect((await json(dir, ['status', '--req', req.id]))[0].runs.at(-1).status).toBe('succeeded')
  const events = await stores.events.read(run.runId)
  expect((await stores.workspaces.getRequirement(req.id))?.status).toBe('delivered')
  expect((await createInsights(stores).metrics(req.id)).humanInterventions).toBe(0)
  expect(await stores.workspaces.detectUntracked(req.id)).toEqual([])
  const artifacts = await stores.workspaces.listArtifacts(req.id)
  for (const id of ['TC-GREET-001', 'TC-GREET-002']) expect(artifacts.some((artifact) => artifact.path === `evidence/${id}/result.json`)).toBe(true)
  expect(events.filter((event) => event.type === 'judge.verdict')).toHaveLength(1)
}, 60000)

it('审计先报告损坏 JSON 行的位置，不追加事件或掩盖断链', async () => {
  const dir = await runtimeProject(`[{ id: 'done', kind: 'script', title: '完成', run: async () => {} }]`)
  const run = await json<State>(dir, ['run', 'custom.workflow.ts', '--req', 'REQ-001'])
  const file = join(dir, '.takt/runs', run.runId, 'events.jsonl')
  const lines = (await readFile(file, 'utf8')).trim().split('\n')
  lines[1] = '{broken json'
  const broken = `${lines.join('\n')}\n`
  await writeFile(file, broken)
  await writeFile(join(dir, '.takt/workspaces/REQ-001/untracked.txt'), 'new')
  expect(await json(dir, ['audit', 'verify', run.runId], 1)).toMatchObject({ runId: run.runId, ok: false, brokenAt: 2 })
  expect(await readFile(file, 'utf8')).toBe(broken)
}, 30000)

it('audit 检出直接修改及未登记的逐条证据，重复扫描去重；ws put 登记并传播 stale', async () => {
  const dir = await runtimeProject(`[
    { id: 'read', kind: 'script', title: '读取', stage: 'build', inputs: [{path: 'spec.md'}], run: async () => {} },
    { id: 'after', kind: 'script', title: '下游', stage: 'build', needs: ['read'], run: async () => {} }
  ]`)
  const source = join(dir, 'input.txt')
  await writeFile(source, 'v1')
  await json(dir, ['ws', 'put', 'REQ-001', 'spec.md', source])
  const run = await json<State>(dir, ['run', 'custom.workflow.ts', '--req', 'REQ-001'])
  const stores = await openProject(dir)
  const workspace = stores.workspaces.dir('REQ-001')
  await writeFile(join(workspace, 'spec.md'), 'bypassed')
  await mkdir(join(workspace, 'evidence/TC-1'), { recursive: true })
  await writeFile(join(workspace, 'evidence/TC-1/result.json'), '{"status":"passed"}')
  const first = await json(dir, ['audit', 'verify', run.runId], 1)
  expect(first).toMatchObject({ ok: false, untracked: expect.arrayContaining([expect.objectContaining({ path: 'spec.md' }), expect.objectContaining({ path: 'evidence/TC-1/result.json' })]) })
  expect(await stores.events.verify(run.runId)).toEqual({ ok: true })
  const count = (await stores.events.read(run.runId)).length
  await json(dir, ['audit', 'verify', run.runId], 1)
  expect(await stores.events.read(run.runId)).toHaveLength(count)
  await writeFile(source, 'v2')
  const edited = await json(dir, ['ws', 'put', 'REQ-001', 'spec.md', source, '--reason', '需求修订'])
  expect(edited).toMatchObject({ version: 2, staleNodes: expect.arrayContaining([{ runId: run.runId, nodeId: 'read' }, { runId: run.runId, nodeId: 'after' }]) })
  expect((await stores.runs.get(run.runId))?.nodes.after?.status).toBe('stale')
  const afterEdit = (await stores.events.read(run.runId)).length
  expect((await json(dir, ['ws', 'put', 'REQ-001', 'spec.md', source])).staleNodes).toEqual([])
  expect(await stores.events.read(run.runId)).toHaveLength(afterEdit)
  expect((await stores.events.read(run.runId, { types: ['artifact.edited'] }))).toHaveLength(1)
  await json(dir, ['ws', 'put', 'REQ-001', 'evidence/TC-1/result.json', join(workspace, 'evidence/TC-1/result.json'), '--kind', 'evidence'])
  expect(await json(dir, ['audit', 'verify', run.runId])).toMatchObject({ ok: true, untracked: [] })
}, 30000)

it('空间被占用时 run 拒绝并提示去 dsh 释放', async () => {
  const dir = await runtimeProject(`[${human}]`)
  await writeFile(join(dir, '.takt/lease.json'), JSON.stringify({
    owner: 'serve:42', pid: process.pid, host: hostname(),
    acquiredAt: '2020-01-01T00:00:00.000Z', heartbeatAt: new Date().toISOString(), ttlMs: 60_000,
  }))
  const result = await cli(dir, ['run', 'custom.workflow.ts', '--req', 'REQ-001'])
  expect(result.code).toBe(2)
  expect(result.stderr).toContain('空间正被 serve:42 使用')
  expect(result.stderr).toContain('请在 dsh 里操作')
})

it('--takeover 接管失效租约后运行并释放', async () => {
  const dir = await runtimeProject(`[${human}]`)
  await writeFile(join(dir, '.takt/lease.json'), JSON.stringify({
    owner: 'serve:42', pid: 1, host: 'another-host',
    acquiredAt: '2020-01-01T00:00:00.000Z', heartbeatAt: '2020-01-01T00:00:00.000Z', ttlMs: 1,
  }))
  const run = await json<State>(dir, ['run', 'custom.workflow.ts', '--req', 'REQ-001', '--takeover'])
  expect(run.status).toBe('waiting_human')
  await expect(readFile(join(dir, '.takt/lease.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('cancel 取消等待中的运行并答复待办', async () => {
  const dir = await runtimeProject(`[${human}]`)
  const run = await json<State>(dir, ['run', 'custom.workflow.ts', '--req', 'REQ-001'])
  expect(run.status).toBe('waiting_human')
  const cancelled = await json<RunState>(dir, ['cancel', run.runId])
  expect(cancelled.status).toBe('cancelled')
  const stores = await openProject(dir)
  const item = (await stores.attention.list()).find((entry) => entry.runId === run.runId)
  expect(item?.decision).toBe('cancelled')
  expect(await stores.events.verify(run.runId)).toEqual({ ok: true })
  await expect(readFile(join(dir, '.takt/lease.json'))).rejects.toMatchObject({ code: 'ENOENT' })
}, 30000)

it('信号早于业务启动时也取消运行并释放租约', async () => {
  const dir = await runtimeProject(`[{ id: 'slow', kind: 'script', title: '慢', run: 'sleep 30' }]`)
  const child = spawn(process.execPath, ['--import', 'tsx', entry, '--project', dir, 'run', 'custom.workflow.ts', '--req', 'REQ-001'], { cwd: repoRoot, stdio: 'pipe' })
  const stderr: Buffer[] = []
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  const closed = new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
  const lease = join(dir, '.takt/lease.json')
  try {
    // 租约文件出现说明信号监听已安装、acquire 已完成；此时通常还没走到 run.started。
    await vi.waitFor(async () => { await access(lease) }, { timeout: 15000, interval: 5 })
    child.kill('SIGINT')
    expect(await closed).toBe(130)
    const runs = await (await openProject(dir)).runs.list()
    expect(runs.every((run) => run.status === 'cancelled')).toBe(true)
    await expect(readFile(lease)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
    await closed.catch(() => undefined)
    expect(stderr.toString()).not.toContain('取消失败')
  }
}, 40000)

it('Ctrl-C 取消在途运行、等待收敛并释放租约', async () => {
  const dir = await runtimeProject(`[{ id: 'slow', kind: 'script', title: '慢', run: 'sleep 30' }]`)
  const child = spawn(process.execPath, ['--import', 'tsx', entry, '--project', dir, 'run', 'custom.workflow.ts', '--req', 'REQ-001'], { cwd: repoRoot, stdio: 'pipe' })
  const stderr: Buffer[] = []
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  const closed = new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
  const stores = await openProject(dir)
  try {
    await vi.waitFor(async () => {
      const runs = await stores.runs.list()
      expect(runs).toHaveLength(1)
      expect(await stores.events.read(runs[0]!.runId, { types: ['node.started'] })).not.toHaveLength(0)
    }, { timeout: 15000, interval: 50 })
    child.kill('SIGINT')
    expect(await closed).toBe(130)
    expect((await stores.runs.list())[0]?.status).toBe('cancelled')
    await expect(readFile(join(dir, '.takt/lease.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
    await closed.catch(() => undefined)
    expect(stderr.toString()).not.toContain('取消失败')
  }
}, 40000)
