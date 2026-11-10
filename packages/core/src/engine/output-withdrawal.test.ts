import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { gate, script } from '../dsl.js'
import { readArtifactData } from '../insights/artifacts.js'
import { buildTraceGraph } from '../insights/trace.js'
import { initProject } from '../store/project.js'
import { listArtifactHistory } from '../store/fs-workspace.js'
import { createEngine } from './index.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it('script 重跑撤回消失的输出，当前证据和交付校验不再读取历史对象', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-withdraw-')); roots.push(root)
  const stores = await initProject(root)
  const requirementId = (await stores.workspaces.createRequirement({ title: '撤回' })).id
  const author = { type: 'system', id: 'fixture' } as const
  for (const [path, content, kind] of [
    ['spec/spec.md', '- AC-1：有证据', 'spec'],
    ['cases/a.json', JSON.stringify({ id: 'a', covers: ['AC-1'] }), 'case'],
    ['evidence/summary.json', JSON.stringify({ cases: [{ id: 'a', status: 'passed' }] }), 'evidence'],
  ] as const) await stores.workspaces.writeArtifact({ ref: { workspace: requirementId, path }, content, kind, author })
  let round = 0
  const workflow = { id: 'withdraw', title: '', version: '1', stages: [], nodes: [
    script({ id: 'run', title: '执行用例', outputs: [{ path: 'evidence/a/*.json', kind: 'evidence' }], run: async ctx => {
      const dir = join(ctx.workspaceDir, 'evidence/a')
      await rm(dir, { recursive: true, force: true }); await mkdir(dir, { recursive: true })
      if (round++ === 0) await writeFile(join(dir, 'x.json'), '{}')
      await writeFile(join(dir, 'y.json'), '')
    } }),
    gate({ id: 'accept', title: '', needs: ['run'], checks: [{ id: 'ac', kind: 'acceptance' }], onFail: 'stop' }),
  ] }
  const engine = createEngine({ stores, profiles: {}, harnesses: {}, knowledge: [] })
  const first = await engine.start({ requirementId, workflow })
  expect(first.nodes.accept?.status).toBe('succeeded')
  const second = await engine.start({ requirementId, workflow })
  const ref = { workspace: requirementId, path: 'evidence/a/x.json' }
  expect(await stores.workspaces.readArtifact(ref)).toBeUndefined()
  expect((await stores.workspaces.readArtifact({ ...ref, version: 1 }))?.toString()).toBe('{}')
  const data = await readArtifactData(stores.workspaces, requirementId)
  expect(data.artifacts.map(a => a.path)).not.toContain(ref.path)
  expect(buildTraceGraph(requirementId, '', data).nodes.some(n => n.ref?.path === ref.path)).toBe(false)
  expect(second.nodes.accept?.status).not.toBe('succeeded')
  expect((await listArtifactHistory(stores, requirementId)).find(a => a.path === ref.path)?.versions.at(-1)).toMatchObject({
    version: 2, sha256: '', reason: '产出节点重跑后文件已不存在', producedBy: { runId: second.runId, nodeId: 'run' },
  })
})
