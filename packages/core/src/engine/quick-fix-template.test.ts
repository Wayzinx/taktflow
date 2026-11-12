import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createLocalSandboxProvider, createRepoManager } from '@taktflow/sandbox'
import { initProject } from '../store/project.js'
import type { AgentProfile, HarnessRequest, HarnessResult } from '../types.js'
import { createEngine } from './index.js'
import workflow from '../../../../templates/workflows/quick-fix.workflow.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const example = new URL('../../../../examples/standard-delivery/', import.meta.url)
const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' })
const spec = 'AC-1：空名字返回 Hello, stranger!'
const testCase = JSON.stringify({ id: 'TC-1', input: '', expected: 'Hello, stranger!', covers: ['AC-1'] })

/** 用示例应用（src/greet.js + tests/run-cases.mjs）真实跑 quick-fix 模板；各角色都是 mock harness。 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'takt-quick-fix-')); roots.push(root)
  const stores = await initProject(root)
  const app = join(root, 'app'); await mkdir(app)
  for (const name of ['src', 'tests', 'package.json']) await cp(new URL(name, example), join(app, name), { recursive: true })
  git(app, ['init', '-b', 'main']); git(app, ['add', '.']); git(app, ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'base'])
  stores.config.repos = [{ id: 'app', path: 'app', defaultBranch: 'main' }]
  await writeFile(join(root, 'takt.config.json'), JSON.stringify(stores.config))
  const req = await stores.workspaces.createRequirement({ title: '空名字回退 stranger' })
  await stores.workspaces.writeArtifact({ ref: { workspace: req.id, path: 'inputs/prd.md' }, kind: 'input', author: { type: 'human', id: 'alice' },
    content: '空名字回退 stranger\n```diff\n--- a/src/greet.js\n+++ b/src/greet.js\n-  return `Hello, ${name}!`\n+  return `Hello, ${name || \'stranger\'}!`\n```', reason: '需求' })
  const calls: string[] = []
  const run = async (request: HarnessRequest): Promise<HarnessResult> => {
    const node = request.env!.TAKT_NODE!, workspace = request.env!.TAKT_WORKSPACE!
    calls.push(`${node}:${request.env!.TAKT_ROLE}`)
    if (node === 'spec') {
      await mkdir(join(workspace, 'spec'), { recursive: true }); await mkdir(join(workspace, 'cases'), { recursive: true })
      await writeFile(join(workspace, 'spec/quick.md'), spec); await writeFile(join(workspace, 'cases/TC-1.json'), testCase)
      return { ok: true, finalText: '已登记 AC 与用例' }
    }
    if (node === 'implement') {
      await writeFile(join(request.cwd, 'src/greet.js'), await readFile(new URL('fixtures/greet.fixed.js', example), 'utf8'))
      await mkdir(join(workspace, 'tasks'), { recursive: true }); await writeFile(join(workspace, 'tasks/change.md'), '空名字回退 stranger')
      return { ok: true, finalText: '', structured: { summary: '已实现', checks: [{ id: 'c1', criterion: '改动符合验收标准且自测结果有证据', pass: true, evidence: 'tasks/change.md' }] } }
    }
    if (node === 'review-code') return { ok: true, finalText: '', structured: { verdict: 'approve', summary: '无问题', issues: [] } }
    return { ok: true, finalText: '', structured: { pass: true, score: 100, message: '逐条证据齐全' } }
  }
  const profiles = Object.fromEntries(['pm', 'dev', 'reviewer', 'verifier'].map((role): [string, AgentProfile] =>
    [role, { role, title: role, description: '', instructions: '', skills: [], writeScope: ['**'], harness: { harness: 'mock' } }]))
  const deps = { stores, profiles, knowledge: [], sandbox: createLocalSandboxProvider(), repos: createRepoManager({ projectDir: root, taktDir: stores.taktDir, repos: stores.config.repos }),
    harnesses: { mock: { id: 'mock', displayName: 'mock', capabilities: { structuredOutput: true }, available: async () => ({ ok: true }), run } } }
  return { stores, req, deps, calls }
}

it('T0 没有给定 spec 与用例时照常写简短需求说明，跳过代码评审，实现与交付校验跑通', async () => {
  const f = await fixture()
  const state = await createEngine(f.deps).start({ workflow, requirementId: f.req.id, args: { tier: 'T0' } })
  expect(state.status, JSON.stringify(state.nodes)).toBe('succeeded')
  expect(Object.fromEntries(Object.entries(state.nodes).map(([id, node]) => [id, node.status])))
    .toEqual({ spec: 'succeeded', implement: 'succeeded', 'review-code': 'skipped', 'delivery-check': 'succeeded' })
  expect(f.calls).toEqual(['spec:pm', 'implement:dev', 'delivery-check:verifier'])
}, 120_000)

it('T0 已给定 spec 与用例时跳过需求说明和代码评审', async () => {
  const f = await fixture()
  const by = { type: 'human', id: 'alice' } as const
  await f.stores.workspaces.writeArtifact({ ref: { workspace: f.req.id, path: 'spec/quick.md' }, kind: 'spec', author: by, content: spec, reason: '给定验收' })
  await f.stores.workspaces.writeArtifact({ ref: { workspace: f.req.id, path: 'cases/TC-1.json' }, kind: 'case', author: by, content: testCase, reason: '给定用例' })
  const t0 = await createEngine(f.deps).start({ workflow, requirementId: f.req.id, args: { tier: 'T0' } })
  expect(t0.status, JSON.stringify(t0.nodes)).toBe('succeeded')
  expect([t0.nodes.spec!.status, t0.nodes['review-code']!.status]).toEqual(['skipped', 'skipped'])
}, 120_000)

it('T1 保留需求说明和独立代码评审', async () => {
  const f = await fixture()
  const t1 = await createEngine(f.deps).start({ workflow, requirementId: f.req.id, args: { tier: 'T1' } })
  expect(t1.status, JSON.stringify(t1.nodes)).toBe('succeeded')
  expect([t1.nodes.spec!.status, t1.nodes['review-code']!.status]).toEqual(['succeeded', 'succeeded'])
}, 120_000)

it.each(['spec', 'case'])('T0 只给定 %s 时补齐验收材料，实现和交付校验不因缺输入而阻塞', async (given) => {
  const f = await fixture()
  await f.stores.workspaces.writeArtifact({ ref: { workspace: f.req.id, path: given === 'spec' ? 'spec/quick.md' : 'cases/TC-1.json' },
    kind: given === 'spec' ? 'spec' : 'case', author: { type: 'human', id: 'alice' }, content: given === 'spec' ? spec : testCase, reason: '给定部分验收' })
  const state = await createEngine(f.deps).start({ workflow, requirementId: f.req.id, args: { tier: 'T0' } })
  expect(state.status, JSON.stringify(state.nodes)).toBe('succeeded')
  expect(state.nodes.spec!.status).toBe('succeeded')
}, 120_000)

it('示例空间的 quick-fix 与模板一致', async () => {
  for (const name of ['quick-fix.workflow.ts', 'quick-fix.hooks.ts']) {
    expect(await readFile(new URL(`workflows/${name}`, example), 'utf8')).toBe(await readFile(new URL(`../../../../templates/workflows/${name}`, import.meta.url), 'utf8'))
  }
})
