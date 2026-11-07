import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { openProject } from '@taktflow/core'
import { initSpace } from '@taktflow/server'
import { main } from '../index.js'
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function temp() { const dir = await mkdtemp(join(tmpdir(), 'takt-crud-cli-')); roots.push(dir); return dir }
async function cli(args: string[], expected = 0) {
  let output = ''
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output += chunk.toString(); return true })
  try { const code = await main([...args, '--json']); expect(code, output).toBe(expected); return JSON.parse(output) as any }
  finally { spy.mockRestore() }
}
it('需求描述文件、编辑日期清除、归档恢复删除均可从 CLI 回读', async () => {
  const root = await temp(); await initSpace(root, 'blank')
  await writeFile(join(root, 'prd.txt'), '背景与验收')
  const req = await cli(['req', 'new', '标题', '--project', root, '--desc-file', join(root, 'prd.txt'), '--due', '2027-01-01', '--workflow', 'demo'])
  expect(req.description).toBe('背景与验收')
  await cli(['req', 'edit', req.id, '--project', root, '--title', '新标题', '--due', 'null', '--owner', 'alice'])
  const edited = await (await openProject(root)).workspaces.getRequirement(req.id)
  expect(edited).toMatchObject({ title: '新标题', owner: 'alice' })
  expect(edited?.dueAt).toBeUndefined()
  await cli(['req', 'archive', req.id, '--project', root]); expect(await cli(['req', 'ls', '--project', root])).toEqual([])
  await cli(['req', 'restore', req.id, '--project', root]); expect(await cli(['req', 'ls', '--project', root])).toHaveLength(1)
  await cli(['req', 'rm', req.id, '--project', root]); expect(await cli(['req', 'ls', '--project', root])).toEqual([])
})
it('req --start 与 cmd requirement.create 启动真实脚本，PRD 在运行前可读', async () => {
  const root = await temp(), stores = await initSpace(root, 'blank')
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await symlink(resolve('node_modules'), join(root, 'node_modules'), 'dir')
  await writeFile(join(stores.paths.workflows, 'demo.workflow.ts'), `import { defineWorkflow, script } from '@taktflow/core'
export default defineWorkflow({id:'demo',title:'demo',version:'1',stages:[],nodes:[script({id:'check',title:'检查输入',run:async(ctx)=>{const fs=await import('node:fs/promises'); const content=await fs.readFile(ctx.workspaceDir+'/inputs/prd.md','utf8');if(content!=='验收')throw new Error('PRD 尚未写入')}})]})`)
  const req = await cli(['req', 'new', '启动', '--project', root, '--desc', '验收', '--workflow', 'demo', '--start'])
  expect(req.startError).toBeUndefined(); expect(req.runId).toBeTruthy()
  expect((await stores.runs.get(req.runId))?.status).toBe('succeeded')
  const cmd = await cli(['cmd', 'requirement.create', '--project', root, '--reason', '验证', '--input', JSON.stringify({ title: '命令启动', description: '验收', workflowId: 'demo' })])
  expect(cmd.result.startError).toBeUndefined(); expect((await stores.runs.get(cmd.result.runId))?.status).toBe('succeeded')
}, 15000)
it('空间 new/copy/archive/restore/rm 和 workflow convert 的 CLI 选项可用', async () => {
  const root = await temp()
  const made = await cli(['space', 'new', 'demo', '--name', '示例', '--spaces', root, '--template', 'blank', '--color', 'blue'])
  expect(made.color).toBe('blue')
  await cli(['space', 'new', 'copy', '--name', '复制', '--spaces', root, '--from', 'demo', '--parts', 'members'])
  const archived = await cli(['space', 'archive', 'demo', '--spaces', root])
  await cli(['space', 'restore', archived.id, '--spaces', root])
  const stores = await openProject(join(root, 'demo'))
  await writeFile(join(stores.paths.workflows, 'plain.workflow.ts'), "export default {id:'plain',title:'plain',version:'1',stages:[],nodes:[]}")
  expect((await cli(['workflow', 'convert', 'plain', '--project', stores.projectDir, '--dry-run'])).source).toContain('defineWorkflow')
  expect(await readFile(join(stores.paths.workflows, 'plain.workflow.ts'), 'utf8')).not.toContain('defineWorkflow')
  const again = await cli(['space', 'archive', 'demo', '--spaces', root])
  await cli(['space', 'rm', again.id, '--spaces', root, '--confirm', again.id])
  expect((await cli(['space', 'ls', '--spaces', root])).map((item: { id: string }) => item.id)).toEqual(['copy'])
}, 15000)
