import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { initProject, listSkills, listWorkflowFiles, loadProfiles, openProject, resolvePaths } from './project.js'
import { FsChatStore } from './fs-chat.js'
import type { RoomMessage } from '../types.js'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function root() { const root = await mkdtemp(join(tmpdir(), 'takt-space-')); roots.push(root); return root }

it('新旧布局与显式路径覆盖，重新打开不漂移', async () => {
  const space = await initProject(await root())
  expect(space.workspaces.dir('REQ-001')).toBe(join(space.projectDir, 'requirements/REQ-001'))
  const legacy = await initProject(await root(), { layout: 'legacy' })
  expect(legacy.paths.agents).toBe(join(legacy.taktDir, 'agents'))
  expect((await initProject(legacy.projectDir)).paths).toEqual(legacy.paths)
  for (const name of ['agents', 'workflows', 'workspaces']) {
    const dir = await root()
    await mkdir(join(dir, '.takt', name), { recursive: true })
    const paths = await resolvePaths(dir, { project: { name: 'x' }, workflows: [], paths: { skills: 'custom/skills' } })
    expect(paths.requirements).toBe(join(dir, '.takt/workspaces'))
    expect(paths.skills).toBe(join(dir, 'custom/skills'))
  }
  await writeFile(join(space.projectDir, 'takt.config.json'), JSON.stringify({ ...space.config, paths: { agents: 'team/roles', workflows: 'flows', requirements: 'materials' } }))
  const custom = await initProject(space.projectDir)
  await writeFile(join(custom.paths.agents, 'pm.md'), '---\nrole: pm\nharness: mock\n---\n产品')
  expect((await loadProfiles(custom.paths)).pm?.role).toBe('pm')
  expect((await loadProfiles(custom.taktDir)).pm?.role).toBe('pm')
  await writeFile(join(custom.paths.workflows, 'demo.workflow.ts'), '// demo')
  expect(await listWorkflowFiles(custom.paths)).toEqual([join(custom.paths.workflows, 'demo.workflow.ts')])
  await mkdir(join(custom.paths.skills, 'hello'))
  await writeFile(join(custom.paths.skills, 'hello/SKILL.md'), '---\nname: greeting\ndescription: 问候技能\n---\n正文')
  expect(await listSkills(custom.paths.skills)).toEqual([{ name: 'greeting', description: '问候技能', path: 'skills/hello/SKILL.md' }])
})

it('需求创建自动开群，成员去重且消息跨实例 seq 连续', async () => {
  const stores = await initProject(await root())
  const req = await stores.workspaces.createRequirement({ title: '问候', owner: 'alice' })
  expect((await stores.chat.getRoom(req.id))?.members).toEqual([{ id: 'alice', kind: 'human', name: 'alice' }, { id: 'lead', kind: 'lead', name: 'Lead' }])
  expect((await stores.chat.list(req.id))[0]).toMatchObject({ seq: 1, kind: 'system', text: '需求已创建' })
  const second = (await openProject(stores.projectDir)).chat
  await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? second : stores.chat).post(req.id, { author: { type: 'human', id: 'alice' }, kind: 'text', text: `${i}` })))
  expect((await second.list(req.id)).map((message) => message.seq)).toEqual(Array.from({ length: 21 }, (_, i) => i + 1))
  expect(await second.list(req.id, { afterSeq: 19, limit: 1 })).toHaveLength(1)
  await second.addMembers(req.id, [{ id: 'alice', kind: 'human', name: 'Alice' }])
  expect((await stores.chat.getRoom(req.id))?.members).toHaveLength(2)
  await expect(stores.chat.post('../escape', { author: { type: 'system', id: 'x' }, kind: 'text', text: 'x' })).rejects.toThrow('非法')
})

it('订阅接收跨进程消息，取消后停止通知；并行进程追加不重复 seq', async () => {
  const dir = await root()
  const chat = new FsChatStore(join(dir, '.takt'))
  await chat.ensureRoom('REQ-001')
  const received: RoomMessage[] = []
  const stop = chat.subscribe('REQ-001', (message) => received.push(message))
  const script = `import { FsChatStore } from ${JSON.stringify(new URL('./fs-chat.ts', import.meta.url).href)};
    const chat = new FsChatStore(process.argv[1]);
    for (let i=0;i<3;i++) await chat.post('REQ-001', {author:{type:'system',id:'child'},kind:'text',text:'中文消息'});`
  try {
    await Promise.all([1, 2].map(() => promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, join(dir, '.takt')])))
    await new Promise((resolve) => setTimeout(resolve, 650))
    expect(received.map((message) => message.seq)).toEqual([1, 2, 3, 4, 5, 6])
  } finally { stop() }
  await chat.post('REQ-001', { author: { type: 'system', id: 'x' }, kind: 'text', text: '取消后' })
  await new Promise((resolve) => setTimeout(resolve, 350))
  expect(received).toHaveLength(6)
})

it('显式 space 布局覆盖初始化前已有旧目录，随后新增旧目录也不改变已初始化空间', async () => {
  const dir = await root()
  await mkdir(join(dir, '.takt/agents'), { recursive: true })
  const stores = await initProject(dir, { layout: 'space' })
  expect(stores.paths.agents).toBe(join(dir, 'agents'))
  expect((await openProject(dir)).paths).toEqual(stores.paths)
})
