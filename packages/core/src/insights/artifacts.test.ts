import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { FsWorkspaceStore } from '../store/fs-workspace.js'
import type { Actor } from '../types.js'
import { readArtifactData } from './artifacts.js'

const system: Actor = { type: 'system', id: 'test' }
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

it('AC 标题取定义处而不是修订说明里的顺带提及，并按编号自然排序', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'takt-acs-'))
  roots.push(root)
  const store = new FsWorkspaceStore(path.join(root, 'workspaces'))
  await store.createRequirement({ id: 'REQ-1', title: '需求' })
  // 真实 PRD 的形状：开头的修订说明先提到 AC，定义在后面的标题、表格和列表里
  const prd = [
    '# PRD',
    '> v3 增量：AC-4 拆成 AC-4 / AC-5，原 AC-5 → AC-12；新增约束 C-18。',
    '',
    '### AC-1 断言步骤标题显示断言文字',
    '| AC-2 | golden 表逐字相同 |',
    '- **AC-4**：HTTP 受理与重放',
    '- 引用 AC-3 的说明（只是提及）',
    '## AC-12 准出材料齐全',
  ].join('\n')
  await store.writeArtifact({ ref: { workspace: 'REQ-1', path: 'spec/prd.md' }, content: prd, kind: 'spec', author: system })
  const { acs } = await readArtifactData(store, 'REQ-1')
  expect([...acs.keys()]).toEqual(['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-12'])
  expect(acs.get('AC-1')).toBe('断言步骤标题显示断言文字')
  expect(acs.get('AC-2')).toBe('golden 表逐字相同')
  expect(acs.get('AC-4')).toBe('HTTP 受理与重放')
  expect(acs.get('AC-12')).toBe('准出材料齐全')
  // 没有定义的 AC 仍按第一次提及兜底
  expect(acs.get('AC-3')).toBe('的说明（只是提及）')
  expect(acs.get('AC-5')).toBe('，原 AC-5 → AC-12；新增约束 C-18。')
})
