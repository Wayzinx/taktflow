import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { initProject } from '../store/project.js'
import type { AgentProfile, HarnessAdapter } from '../types.js'
import { attributeDefect, confirmDefect, getDefect, reportDefect } from './index.js'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
it('auditor 参与产出时拒绝归因；非法候选不会写 attributed；确认不能跳过归因', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-defects-')); roots.push(root)
  const stores = await initProject(root), req = await stores.workspaces.createRequirement({ title: '审计隔离' })
  const by = { type: 'human' as const, id: 'tester' }
  const profile: AgentProfile = { role: 'auditor', title: 'auditor', description: '', instructions: '', harness: { harness: 'mock' }, skills: [], writeScope: [] }
  let calls = 0
  const mock: HarnessAdapter = { id: 'mock', displayName: 'mock', available: async () => ({ ok: true }), run: async () => { calls++; return { ok: true, finalText: '{}', structured: {} } } }
  const deps = { stores, profiles: { auditor: profile }, knowledge: [], harnesses: { mock } }
  const defect = await reportDefect(stores, req.id, { title: '问题', description: 'AC-2', severity: 'minor', acs: ['AC-2'] }, by)
  await expect(attributeDefect(deps, req.id, defect.id)).rejects.toThrow('缺少必填字段')
  expect((await getDefect(stores, req.id, defect.id)).status).toBe('open')
  await expect(confirmDefect(stores, req.id, defect.id, {}, by)).rejects.toThrow('先完成归因')
  await stores.workspaces.writeArtifact({ ref: { workspace: req.id, path: 'spec/test.md' }, kind: 'spec', author: { type: 'agent', role: 'auditor', harness: 'mock' }, content: 'AC-2' })
  await expect(attributeDefect(deps, req.id, defect.id)).rejects.toThrow('不同于任何产出角色')
  expect(calls).toBe(3)
  await expect(getDefect(stores, req.id, '../D-1')).rejects.toThrow('非法')
  await expect(reportDefect(stores, 'missing', { title: 'x', description: 'x', severity: 'major' }, by)).rejects.toThrow('不存在')
})
