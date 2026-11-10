import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { initProject } from '../store/project.js'
import { createRepoManager, createLocalSandboxProvider } from '@taktflow/sandbox'
import { createEngine } from './index.js'
import { diffPath } from './execution.js'
import type { AgentProfile, HarnessRequest, SandboxProvider, SandboxSpec, WorkflowDefinition } from '../types.js'
import { integrate } from '../../../../templates/workflows/taktflow-standard.integration.js'
import { runCases } from '../../../../templates/workflows/taktflow-standard.hooks.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

it('有 repo 节点只能改自己的工作树，其他工作树的写入按项目相对路径报告', async () => {
  const other = '.takt/worktrees/run-other/integration/src/a.ts'
  const f = await fixture(async req => {
    await writeFile(join(req.cwd, 'src/a.ts'), 'own change')
    await writeFile(join(f.root, other), 'other change')
    return 'done'
  })
  await mkdir(join(f.root, '.takt/worktrees/run-other/integration/src'), { recursive: true })
  await writeFile(join(f.root, other), 'before')
  f.deps.profiles.dev!.writeScope = ['**']
  const state = await createEngine(f.deps).start({ requirementId: f.req.id, workflow: f.workflow([
    { id: 'code', kind: 'agent', title: '', role: 'dev', repo: 'app', prompt: '' },
  ]) })
  expect(state.nodes.code?.status).toBe('blocked')
  expect((await f.stores.events.read(state.runId, { types: ['guard.violation'] }))[0]?.data).toMatchObject({ paths: [other] })
})
async function fixture(handler: (request: HarnessRequest) => Promise<unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'takt-engine-integration-')); roots.push(root)
  const stores = await initProject(root)
  const app = join(root, 'app'); await mkdir(join(app, 'src'), { recursive: true }); await mkdir(join(app, 'tests'))
  await writeFile(join(app, 'src/a.ts'), 'base\n'); await writeFile(join(app, 'tests/test.ts'), 'test\n')
  git(app, ['init', '-b', 'main']); git(app, ['add', '.']); git(app, ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'base'])
  stores.config.repos = [{ id: 'app', path: 'app', defaultBranch: 'main' }]
  await writeFile(join(root, 'takt.config.json'), JSON.stringify(stores.config))
  await mkdir(join(stores.paths.skills, 'demo')); await writeFile(join(stores.paths.skills, 'demo/SKILL.md'), '# skill')
  const req = await stores.workspaces.createRequirement({ title: '执行面接入' })
  const profiles = Object.fromEntries(['dev', 'reviewer'].map((role): [string, AgentProfile] => [role, { role, title: role, description: '', instructions: '', skills: [], writeScope: ['src/**', 'requirements/**/tasks/**'], harness: { harness: 'mock' } }]))
  const specs: SandboxSpec[] = []; let disposed = 0
  const provider = createLocalSandboxProvider()
  const sandbox: SandboxProvider = { ...provider, create: async (spec) => {
    specs.push(spec); const instance = await provider.create(spec)
    return { ...instance, dispose: async () => { disposed++; await instance.dispose() } }
  } }
  const calls: HarnessRequest[] = []
  const deps = { stores, profiles, knowledge: [], skillsDir: stores.paths.skills, sandbox, repos: createRepoManager({ projectDir: root, taktDir: stores.taktDir, repos: stores.config.repos }),
    harnesses: { mock: { id: 'mock', displayName: 'mock', capabilities: { structuredOutput: true }, available: async () => ({ ok: true }), run: async (request: HarnessRequest) => { calls.push(request); return { ok: true, finalText: '', structured: await handler(request) } } } } }
  const workflow = (nodes: WorkflowDefinition['nodes']): WorkflowDefinition => ({ id: 'integration-test', title: '接入', version: '1', stages: [], nodes })
  return { root, app, stores, req, deps, calls, specs, disposed: () => disposed, workflow }
}

it('agent 在工作树调用沙箱，挂载工作区与只读资产，技能预同步且真实 diff 被登记', async () => {
  const f = await fixture(async (req) => {
    expect(req.sandbox).toBeDefined()
    expect(await readFile(join(req.cwd, '.agents/skills/demo/SKILL.md'), 'utf8')).toBe('# skill')
    await writeFile(join(req.cwd, 'src/a.ts'), 'changed\n')
    return { done: true }
  })
  const state = await createEngine(f.deps).start({ requirementId: f.req.id, workflow: f.workflow([{ id: 'code', kind: 'agent', title: '代码', role: 'dev', repo: 'app', prompt: (ctx) => `cwd=${ctx.projectDir}` }]) })
  expect(state.status).toBe('succeeded'); expect(f.disposed()).toBe(1)
  const tree = state.nodes.code!.worktree!
  expect(tree.repo).toBe('app'); expect(f.calls[0]!.cwd).toBe(tree.path)
  expect(f.calls[0]!.prompt).toContain(`cwd=${tree.path}`)
  expect(f.specs[0]!.mounts).toEqual(expect.arrayContaining([
    { source: tree.path, target: tree.path, mode: 'rw' },
    { source: f.stores.workspaces.dir(f.req.id), target: f.stores.workspaces.dir(f.req.id), mode: 'rw' },
    { source: f.stores.paths.skills, target: f.stores.paths.skills, mode: 'ro' },
    { source: f.stores.paths.knowledge, target: f.stores.paths.knowledge, mode: 'ro' },
  ]))
  expect(await readFile(join(f.app, 'src/a.ts'), 'utf8')).toBe('base\n')
  const artifact = (await f.stores.workspaces.listArtifacts(f.req.id)).find((artifact) => artifact.path === 'tasks/code.diff')!
  expect(artifact.kind).toBe('code-change')
  const patch = (await f.stores.workspaces.readArtifact({ workspace: f.req.id, path: artifact.path }))!.toString()
  expect(patch).toContain('+changed'); expect(patch).not.toContain('SKILL.md')
  expect(state.nodes.code!.outputs.some((ref) => ref.path === artifact.path)).toBe(true)
  expect((await f.stores.events.read(state.runId, { types: ['worktree.created'] }))[0]!.data).toEqual(tree)
  expect(await f.stores.events.verify(state.runId)).toEqual({ ok: true })
})

it.each(['harness-error', 'guard'])('调用失败 %s 仍释放沙箱，工作树写权限照常生效并保留失败 diff', async (mode) => {
  const f = await fixture(async (req) => {
    await writeFile(join(req.cwd, mode === 'guard' ? 'tests/test.ts' : 'src/a.ts'), 'changed\n')
    if (mode === 'harness-error') throw new Error('失败示例')
    return 'done'
  })
  const state = await createEngine(f.deps).start({ requirementId: f.req.id, workflow: f.workflow([{ id: 'code', kind: 'agent', title: '代码', role: 'dev', repo: 'app', prompt: '改代码' }]) })
  expect(state.status).toBe('failed'); expect(f.disposed()).toBe(1)
  expect(state.nodes.code!.status).toBe(mode === 'guard' ? 'blocked' : 'failed')
  expect((await f.stores.workspaces.readArtifact({ workspace: f.req.id, path: 'tasks/code.diff' }))!.toString()).toContain('+changed')
  if (mode === 'guard') expect((await f.stores.events.read(state.runId, { types: ['guard.violation'] }))[0]!.data).toMatchObject({ paths: ['tests/test.ts'] })
})

it('评审者和作者每次独立沙箱，作者修改实际工作树后下一轮读取真实新 diff', async () => {
  let reviews = 0
  const f = await fixture(async (req) => {
    if (req.env!.TAKT_NODE === 'code') { await writeFile(join(req.cwd, 'src/a.ts'), 'first\n'); return 'done' }
    expect(req.cwd).toBe(f.calls[0]!.cwd)
    if (req.env!.TAKT_ROLE === 'reviewer') {
      reviews++
      expect(req.tools?.writeScope).toEqual([])
      expect(await readFile(join(req.cwd, 'src/a.ts'), 'utf8')).toBe(reviews === 1 ? 'first\n' : 'revised\n')
      return reviews === 1 ? { verdict: 'request_changes', summary: '修改', issues: [{ id: 'I1', severity: 'major', description: '改成 revised' }] } : { verdict: 'approve', summary: '通过', issues: [] }
    }
    await writeFile(join(req.cwd, 'src/a.ts'), 'revised\n')
    return { responses: [{ round: 1, reviewer: 'reviewer', issueId: 'I1', action: 'fixed', note: '已修改' }] }
  })
  const state = await createEngine(f.deps).start({ requirementId: f.req.id, workflow: f.workflow([
    { id: 'code', kind: 'agent', title: '实现', role: 'dev', repo: 'app', prompt: '实现' },
    { id: 'cr', kind: 'review', title: '代码评审', needs: ['code'], target: { code: { repo: 'app' } }, author: { role: 'dev' }, reviewers: [{ role: 'reviewer' }], maxRounds: 2, onExhausted: 'fail' },
  ]) })
  expect(state.status, JSON.stringify(state.nodes)).toBe('succeeded')
  expect(f.disposed()).toBe(4); expect(reviews).toBe(2)
  const patch = (await f.stores.workspaces.readArtifact({ workspace: f.req.id, path: 'tasks/code.diff' }))!.toString()
  expect(patch).toContain('+revised')
  expect(state.nodes.cr!.inputs).toMatchObject([{ path: 'tasks/code.diff' }])
  expect(await f.stores.events.verify(state.runId)).toEqual({ ok: true })
})

it('无 RepoManager 时明确失败；未知 sandbox 配置不能降级绕过隔离', async () => {
  const f = await fixture(async () => 'done')
  const workflow = f.workflow([{ id: 'code', kind: 'agent', title: '实现', role: 'dev', repo: 'app', prompt: '实现' }])
  const missing = await createEngine({ ...f.deps, repos: undefined }).start({ requirementId: f.req.id, workflow })
  expect(missing.nodes.code!.error).toContain('RepoManager')
  f.stores.config.sandbox = { provider: 'unknown' }
  const invalid = await createEngine({ ...f.deps, sandbox: undefined }).start({ requirementId: f.req.id, workflow: f.workflow([{ ...workflow.nodes[0]!, id: 'other', kind: 'agent', role: 'dev', prompt: '实现', repo: undefined }]) })
  expect(invalid.nodes.other!.error).toContain('Unknown sandbox provider')
})

it('集成节点合并真实任务分支，冲突时保存冲突文件并使节点失败', async () => {
  const f = await fixture(async (req) => {
    await writeFile(join(req.cwd, 'src/a.ts'), req.env!.TAKT_NODE + '\n')
    return 'done'
  })
  const state = await createEngine(f.deps, { concurrency: 1 }).start({ requirementId: f.req.id, workflow: f.workflow([
    { id: 'one', kind: 'agent', title: '实现一', role: 'dev', repo: 'app', prompt: '实现' },
    { id: 'two', kind: 'agent', title: '实现二', role: 'dev', repo: 'app', prompt: '实现' },
    { id: 'integration', kind: 'script', title: '集成', needs: ['one', 'two'], run: integrate, outputs: [{ path: 'tasks/integration.json', kind: 'code-change' }] },
  ]) })
  expect(state.nodes.integration!.status).toBe('failed')
  expect(state.nodes.integration!.result).toMatchObject({ conflicts: ['src/a.ts'], branch: `takt/${state.runId}/integration` })
  const artifact = await f.stores.workspaces.readArtifact({ workspace: f.req.id, path: 'tasks/integration.json' })
  expect(JSON.parse(artifact!.toString()).conflicts).toEqual(['src/a.ts'])
  expect(await readFile(join(f.app, 'src/a.ts'), 'utf8')).toBe('base\n')
  expect(await f.stores.events.verify(state.runId)).toEqual({ ok: true })
})

it('有依赖的任务叠在上游的改动上：后一个任务看得到前一个的代码，diff 只含自己的改动，集成不冲突；修复节点可指定从集成分支开', async () => {
  const f = await fixture(async (req) => {
    const file = join(req.cwd, 'src/a.ts')
    await writeFile(file, (await readFile(file, 'utf8')) + req.env!.TAKT_NODE + '\n')
    return 'done'
  })
  const state = await createEngine(f.deps, { concurrency: 1 }).start({ requirementId: f.req.id, workflow: f.workflow([
    { id: 'one', kind: 'agent', title: '实现一', role: 'dev', repo: 'app', prompt: '实现' },
    { id: 'two', kind: 'agent', title: '实现二', role: 'dev', repo: 'app', prompt: '实现', needs: ['one'] },
    { id: 'integration', kind: 'script', title: '集成', needs: ['two'], run: integrate, outputs: [{ path: 'tasks/integration.json', kind: 'code-change' }] },
    { id: 'fix', kind: 'agent', title: '修复', role: 'dev', repo: 'app', prompt: '修复', needs: ['integration'],
      base: (ctx) => (ctx.resultOf('integration') as { branch?: string } | undefined)?.branch },
  ]) })
  expect(state.status).toBe('succeeded')
  const one = state.nodes.one!.worktree!, two = state.nodes.two!.worktree!
  expect(two.base).toBe(git(one.path, ['rev-parse', 'HEAD']))
  expect(git(one.path, ['log', '-1', '--format=%s'])).toBe('任务 one')
  expect(await readFile(join(two.path, 'src/a.ts'), 'utf8')).toBe('base\none\ntwo\n')
  const diff = (await f.stores.workspaces.readArtifact({ workspace: f.req.id, path: diffPath('two') }))!.toString()
  expect(diff).toContain('+two'); expect(diff).not.toContain('+one')
  const integration = state.nodes.integration!.result as { path: string; conflicts: string[] }
  expect(integration.conflicts).toEqual([])
  expect(await readFile(join(integration.path, 'src/a.ts'), 'utf8')).toBe('base\none\ntwo\n')
  expect(await readFile(join(state.nodes.fix!.worktree!.path, 'src/a.ts'), 'utf8')).toBe('base\none\ntwo\nfix\n')
  expect(await f.stores.events.verify(state.runId)).toEqual({ ok: true })
})

it('执行用例：先清掉各用例上一轮的证据（基线等根目录文件保留），整个测试目录带进集成 worktree；人工与阻塞用例不算失败', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-run-cases-')); roots.push(root)
  const project = join(root, 'project'), workspace = join(root, 'ws'), integration = join(root, 'integration')
  const runner = `import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { answer } from './lib/answer.mjs'
const evidence = join(process.env.TAKT_WORKSPACE, 'evidence')
mkdirSync(join(evidence, 'TC-1'), { recursive: true })
writeFileSync(join(evidence, 'TC-1', 'log.txt'), String(answer))
writeFileSync(join(evidence, 'summary.json'), JSON.stringify({ cases: [{ id: 'TC-1', status: 'passed', evidence: 'evidence/TC-1/log.txt' }, { id: 'TC-2', status: 'manual' }, { id: 'TC-3', status: 'blocked' }, { id: 'TC-4', status: 'failed' }] }))
`
  await mkdir(join(project, 'tests/lib'), { recursive: true }); await mkdir(join(workspace, 'cases'), { recursive: true }); await mkdir(join(workspace, 'evidence/TC-1'), { recursive: true }); await mkdir(integration)
  await writeFile(join(project, 'tests/run-cases.mjs'), runner); await writeFile(join(project, 'tests/lib/answer.mjs'), 'export const answer = 42\n')
  await writeFile(join(workspace, 'scripts.mjs'), runner)
  for (const id of ['TC-1', 'TC-2', 'TC-3', 'TC-4']) await writeFile(join(workspace, `cases/${id}.json`), JSON.stringify({ id, covers: ['AC-1'] }))
  await writeFile(join(workspace, 'evidence/TC-1/result.json'), '{"actual":"上一轮的结果"}'); await writeFile(join(workspace, 'evidence/baseline.txt'), '基线')
  const read = async (path: string) => { try { return await readFile(join(workspace, path === 'scripts/run-cases.mjs' ? 'scripts.mjs' : path), 'utf8') } catch { return undefined } }
  const ctx = { projectDir: project, workspaceDir: workspace, args: { caseCommand: 'node tests/run-cases.mjs' }, readArtifact: read,
    resultOf: (id: string) => id === 'integration' ? { path: integration } : undefined, log: () => {} } as unknown as Parameters<typeof runCases>[0]
  // 人工执行、等裁决的用例不进修复循环，单独列出留给准出
  expect(await runCases(ctx)).toEqual({ data: { total: 4, failures: [{ subject: 'TC-4', status: 'failed' }],
    pending: [{ subject: 'TC-2', status: 'manual' }, { subject: 'TC-3', status: 'blocked' }] } })
  await expect(readFile(join(workspace, 'evidence/TC-1/result.json'), 'utf8')).rejects.toThrow()
  expect(await readFile(join(workspace, 'evidence/TC-1/log.txt'), 'utf8')).toBe('42')
  expect(await readFile(join(workspace, 'evidence/baseline.txt'), 'utf8')).toBe('基线')
  expect(await readFile(join(integration, 'tests/lib/answer.mjs'), 'utf8')).toBe('export const answer = 42\n')
})

it('动态节点的安全 diff 名称稳定且互不碰撞', () => {
  expect(diffPath('planner/item/code')).not.toBe(diffPath('planner_item_code'))
  expect(diffPath('planner/item/code')).toMatch(/^tasks\/[A-Za-z0-9_-]+\.diff$/)
})

it('loop 的后续轮次从审计记录复用任务工作树，不重复创建分支', async () => {
  let count = 0
  const f = await fixture(async (request) => { await writeFile(join(request.cwd, 'src/a.ts'), `round ${++count}\n`); return { count } })
  const workflow = f.workflow([{ id: 'loop', kind: 'loop', title: '重复任务', maxIterations: 2, until: (ctx) => (ctx.resultOf('code') as { count: number }).count === 2,
    body: [{ id: 'code', kind: 'agent', title: '实现', role: 'dev', repo: 'app', prompt: '实现' }] }])
  const state = await createEngine(f.deps).start({ requirementId: f.req.id, workflow })
  expect(state.status, JSON.stringify(state.nodes)).toBe('succeeded')
  expect(f.calls[0]!.cwd).toBe(f.calls[1]!.cwd)
  expect((await f.stores.events.read(state.runId, { types: ['worktree.created'] }))).toHaveLength(1)
  expect((await f.stores.workspaces.readArtifact({ workspace: f.req.id, path: diffPath('loop/code') }))!.toString()).toContain('+round 2')
})

it('harness fallback 为两次实际调用分别创建和释放沙箱', async () => {
  let count = 0
  const f = await fixture(async () => { if (++count === 1) throw new Error('503 temporary'); return 'recovered' })
  const alternative = { ...f.deps.harnesses.mock, id: 'alternative' }
  const deps = { ...f.deps, harnesses: { ...f.deps.harnesses, alternative } }
  const state = await createEngine(deps).start({ requirementId: f.req.id, workflow: f.workflow([{ id: 'code', kind: 'agent', title: '实现', role: 'dev', repo: 'app', prompt: '实现', harness: { harness: 'mock', fallback: [{ harness: 'alternative' }] } }]) })
  expect(state.status).toBe('succeeded')
  expect(f.disposed()).toBe(2); expect(f.specs).toHaveLength(2)
})

it('代码评审打回后保留工作树，换引擎实例恢复不会重建同名分支', async () => {
  let writes = 0
  const f = await fixture(async (request) => {
    if (request.env!.TAKT_NODE === 'code') { await writeFile(join(request.cwd, 'src/a.ts'), `version ${++writes}\n`); return 'done' }
    return writes === 1 ? { verdict: 'reject', summary: '重写', issues: [{ id: 'I1', severity: 'major', description: '重写实现' }] } : { verdict: 'approve', summary: '通过', issues: [] }
  })
  const workflow = f.workflow([
    { id: 'code', kind: 'agent', title: '实现', role: 'dev', repo: 'app', prompt: '实现' },
    { id: 'review', kind: 'review', title: '评审', needs: ['code'], target: { code: { repo: 'app' } }, author: { role: 'dev' }, reviewers: [{ role: 'reviewer' }], maxRounds: 1, humanSignoff: true, onExhausted: { rework: 'code', maxReworks: 1 } },
  ])
  const first = await createEngine(f.deps).start({ requirementId: f.req.id, workflow })
  expect(first.status, JSON.stringify(first.nodes)).toBe('waiting_human')
  expect(writes).toBe(2)
  const attention = (await f.stores.attention.list({ pending: true }))[0]!
  await f.stores.attention.answer(attention.requestId, { decision: 'approve', by: { type: 'human', id: 'tester' } })
  const resumed = await createEngine(f.deps).resume(first.runId, workflow)
  expect(resumed.status).toBe('succeeded')
  expect(resumed.nodes.code!.worktree).toEqual(first.nodes.code!.worktree)
  expect((await f.stores.events.read(first.runId, { types: ['worktree.created'] }))).toHaveLength(1)
  expect(await f.stores.events.verify(first.runId)).toEqual({ ok: true })
})

it('集成多个绑定仓库，在每个仓库创建同名集成分支，保留主仓库测试目录', async () => {
  const f = await fixture(async (req) => { await writeFile(join(req.cwd, 'src/a.ts'), req.env!.TAKT_NODE + '\n'); return 'done' })
  const library = join(f.root, 'library'); await mkdir(join(library, 'src'), { recursive: true }); await writeFile(join(library, 'src/a.ts'), 'library\n')
  git(library, ['init', '-b', 'main']); git(library, ['add', '.']); git(library, ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'library base'])
  const repos = [...f.stores.config.repos!, { id: 'library', path: 'library', defaultBranch: 'main' }]
  f.stores.config.repos = repos
  await writeFile(join(f.root, 'takt.config.json'), JSON.stringify(f.stores.config))
  const deps = { ...f.deps, repos: createRepoManager({ projectDir: f.root, taktDir: f.stores.taktDir, repos }) }
  const state = await createEngine(deps).start({ requirementId: f.req.id, workflow: f.workflow([
    { id: 'app-code', kind: 'agent', title: '应用', role: 'dev', repo: 'app', prompt: '实现' },
    { id: 'lib-code', kind: 'agent', title: '类库', role: 'dev', repo: 'library', prompt: '实现' },
    { id: 'integration', kind: 'script', title: '集成', needs: ['app-code', 'lib-code'], run: integrate, outputs: [{ path: 'tasks/integration.json', kind: 'code-change' }] },
  ]) })
  expect(state.status, JSON.stringify(state.nodes)).toBe('succeeded')
  const result = state.nodes.integration!.result as { path: string; repositories: Record<string, { path: string; branch: string }> }
  for (const [repo, nodeId] of [['app', 'app-code'], ['library', 'lib-code']]) {
    const tree = result.repositories[repo!]!
    expect(tree.branch).toBe(`takt/${state.runId}/integration`)
    expect(git(tree.path, ['branch', '--show-current'])).toBe(tree.branch)
    expect(await readFile(join(tree.path, 'src/a.ts'), 'utf8')).toBe(`${nodeId}\n`)
  }
  expect(result.path).toBe(result.repositories.app!.path)
})
