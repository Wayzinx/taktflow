import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { initProject } from '../store/project.js'
import { createEngine } from '../engine/index.js'
import { precheckDefect } from './precheck.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
it('Loop 当前状态未保留工作树时，用创建事件及真实 git 历史恢复引入节点', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-precheck-history-')); roots.push(root)
  const stores = await initProject(root)
  const req = await stores.workspaces.createRequirement({ title: '历史代码归属' })
  const run = await createEngine({ stores, profiles: {}, harnesses: {}, knowledge: [] }).start({ requirementId: req.id, workflow: {
    id: 'loop-history', title: '历史', version: '1', stages: [], nodes: [{ kind: 'script', id: 'fix', title: '修复', run: async () => {} }],
  } })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  git('init', '-b', 'main')
  await writeFile(join(root, 'app.ts'), 'before\n')
  git('add', 'app.ts'); git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'base')
  const base = git('rev-parse', 'HEAD')
  await writeFile(join(root, 'app.ts'), 'after\n')
  git('add', 'app.ts'); git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'change')
  const commit = git('rev-parse', 'HEAD')
  await stores.events.append(run.runId, { type: 'worktree.created', nodeId: 'fix', actor: { type: 'system', id: 'engine' }, data: { repo: 'app', path: root, branch: 'main', base } })
  run.nodes.fix!.status = 'skipped'; await stores.runs.save(run)
  const result = await precheckDefect(stores, { id: 'D-1', requirementId: req.id, title: '问题', description: 'app.ts 存在错误', severity: 'major', foundAt: new Date().toISOString(), reportedBy: { type: 'human', id: 'test' }, status: 'open' })
  expect(result.codeNodes).toEqual(['fix'])
  expect(result.codeChanges).toEqual([{ file: 'app.ts', nodeId: 'fix', runId: run.runId, commit }])
})
