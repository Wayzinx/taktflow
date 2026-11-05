import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { initProject } from '../store/project.js'
import type { NodeDef, WorkflowDefinition } from '../types.js'
import { createEngine } from './index.js'
import { assertSupportedNodes, SUPPORTED_NODE_KINDS } from './kinds.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<Awaited<ReturnType<typeof initProject>>> {
  const root = await mkdtemp(join(tmpdir(), 'takt-kinds-'))
  roots.push(root)
  return initProject(root)
}

const unsupported = (id: string): NodeDef => ({ id, kind: 'unknown', title: '未知' } as unknown as NodeDef)

const workflow = (nodes: NodeDef[]): WorkflowDefinition => ({ id: 'kinds', title: '', version: '1', stages: [], nodes })

it('支持的节点类型包含 review，但不含 subflow / 未知类型', () => {
  expect(SUPPORTED_NODE_KINDS).toContain('review')
  expect(SUPPORTED_NODE_KINDS).not.toContain('subflow')
  expect(() => assertSupportedNodes([unsupported('r')])).toThrow('不支持的节点类型：unknown（节点 r）')
  expect(() => assertSupportedNodes([{ id: 'loop', kind: 'loop', title: '', maxIterations: 1, until: () => true, body: [unsupported('inner')] }])).toThrow('不支持的节点类型：unknown（节点 loop/inner）')
})

it('含未知节点的工作流启动即失败，不创建运行', async () => {
  const stores = await fixture()
  const requirement = await stores.workspaces.createRequirement({ title: '评审' })
  const engine = createEngine({ stores, profiles: {}, harnesses: {}, knowledge: [] })
  await expect(engine.start({ requirementId: requirement.id, workflow: workflow([unsupported('r')]) }))
    .rejects.toThrow('不支持的节点类型：unknown（节点 r）')
  expect(await stores.runs.list()).toEqual([])
})
