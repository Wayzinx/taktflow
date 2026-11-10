import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { initProject } from '../store/project.js'
import { readArtifactData } from './artifacts.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it('AC 标题优先定义行和表格标题列，修订记录只作回退', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-ac-title-')); roots.push(root)
  const stores = await initProject(root)
  const req = await stores.workspaces.createRequirement({ title: '标题' })
  await stores.workspaces.writeArtifact({ ref: { workspace: req.id, path: 'spec/spec.md' }, kind: 'spec', author: { type: 'system', id: 'test' },
    content: '修订：AC-11 改为新的发射规则\n补充 AC-3 的移动行为\n- **AC-11**：敌方子弹上限\n| AC-3 | 玩家移动 | 其他说明 |\n### **AC-4** — 全角标题\n记录中提及 AC-5：回退标题' })
  expect([...((await readArtifactData(stores.workspaces, req.id)).acs)]).toEqual([
    ['AC-11', '敌方子弹上限'], ['AC-3', '玩家移动'], ['AC-4', '全角标题'], ['AC-5', '回退标题'],
  ])
})
