import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { openProject } from '@taktflow/core'
import { main } from './index.js'
import { loadRuntime } from './project.js'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function temp() { const root = await mkdtemp(join(tmpdir(), 'takt-cli-space-')); roots.push(root); return root }
async function cli(root: string, args: string[], expected = 0) {
  const output: string[] = []
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((value) => { output.push(String(value)); return true })
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    const code = await main([...args, '--project', root, '--json'])
    const value = JSON.parse(output.join(''))
    expect(code, JSON.stringify(value)).toBe(expected)
    return value
  } finally { stdout.mockRestore(); stderr.mockRestore() }
}

it.each(['space', 'legacy'])('init %s 按 stores.paths 复制完整模板且运行时按自定义目录加载', async (layout) => {
  const root = await temp()
  const args = layout === 'space' ? ['init'] : ['init', '--layout', layout]
  await cli(root, args)
  let stores = await openProject(root)
  expect(stores.paths.agents).toBe(join(root, layout === 'space' ? 'agents' : '.takt/agents'))
  for (const name of ['sdlc.workflow.ts', 'taktflow-standard.workflow.ts', 'taktflow-standard.hooks.ts', 'taktflow-standard.integration.ts']) expect(await readFile(join(stores.paths.workflows, name), 'utf8')).toBeTruthy()
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await symlink(resolve('node_modules'), join(root, 'node_modules'), 'dir')
  expect((await loadRuntime(root)).workflows.map((workflow) => workflow.id).sort()).toEqual(['quick-fix', 'sdlc', 'taktflow-standard'])
  // 自定义路径是加载来源，不退回写死的 .takt/agents。
  const custom = join(root, 'custom-roles'); await mkdir(custom)
  await writeFile(join(custom, 'custom.md'), '---\nharness: mock\n---\n定制角色')
  stores.config.paths = { ...stores.config.paths, agents: 'custom-roles' }
  await writeFile(join(root, 'takt.config.json'), JSON.stringify(stores.config))
  expect(Object.keys((await loadRuntime(root)).profiles)).toEqual(['custom'])
  await writeFile(join(stores.paths.workflows, 'sdlc.workflow.ts'), '// 用户定制')
  await cli(root, ['init'])
  stores = await openProject(root)
  expect(await readFile(join(stores.paths.workflows, 'sdlc.workflow.ts'), 'utf8')).toBe('// 用户定制')
}, 15000)

it('repo/member/skill/chat 的全部新增命令持久化，并拒绝重复、无效输入', async () => {
  const root = await temp(); await cli(root, ['init'])
  expect(await cli(root, ['member', 'ls'])).toEqual([])
  expect((await cli(root, ['member', 'add', 'alice', '--name', 'Alice', '--role', 'owner'])).id).toBe('alice')
  expect((await cli(root, ['member', 'ls']))[0].role).toBe('owner')
  await cli(root, ['member', 'add', 'alice'], 2)
  await cli(root, ['member', 'add', 'bad', '--role', 'root'], 1)
  const app = join(root, 'app'); await mkdir(app)
  for (const args of [['init', '-b', 'main'], ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '--allow-empty', '-m', 'base']]) execFileSync('git', args, { cwd: app, stdio: 'pipe' })
  expect((await cli(root, ['repo', 'add', 'app', 'app'])).defaultBranch).toBe('main')
  expect((await cli(root, ['repo', 'ls']))[0].id).toBe('app')
  expect((await cli(root, ['repo', 'sync', 'app']))[0].head).toMatch(/^[a-f0-9]{40}$/)
  expect((await cli(root, ['repo', 'sync']))[0].id).toBe('app')
  await cli(root, ['repo', 'add', 'app', 'app'], 2)
  const source = join(await temp(), 'demo'); await mkdir(source)
  await writeFile(join(source, 'SKILL.md'), '---\nname: demo\ndescription: 测试技能\n---\n技能正文')
  expect(await cli(root, ['skill', 'ls'])).toEqual([])
  expect((await cli(root, ['skill', 'add', source]))[0].name).toBe('demo')
  expect((await cli(root, ['skill', 'ls']))[0].description).toBe('测试技能')
  await cli(root, ['req', 'new', '群聊需求'])
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await symlink(resolve('node_modules'), join(root, 'node_modules'), 'dir')
  const config = (await openProject(root)).config
  config.lead = { harness: { harness: 'mock' } }
  await writeFile(join(root, 'takt.config.json'), JSON.stringify(config))
  await writeFile(join(root, '.takt/mock.json'), JSON.stringify({ steps: [{ match: { role: 'lead' }, structured: { reply: '需求已创建', actions: [] } }] }))
  const message = await cli(root, ['chat', 'post', 'REQ-001', '@lead 现在进展如何'])
  expect(message.mentions).toEqual(['lead'])
  expect((await cli(root, ['chat', 'ls', 'REQ-001'])).some((entry: { id: string }) => entry.id === message.id)).toBe(true)
  expect((await (await openProject(root)).runs.list()).map((run) => run.workflowId)).toEqual(['lead'])
  const events = (await readFile(join(root, '.takt/space-events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  expect(events).toHaveLength(5)
  for (const args of [['skill', 'bad'], ['workflow', 'edit', 'x'], ['repo', 'add'], ['member', 'ls', 'extra'], ['chat', 'post', 'REQ-001']]) await cli(root, args, 2)
}, 15000)

it('workflow ls/lint/show/edit/revisions/rollback 通过 workflow-source 保留源码与修订', async () => {
  const root = await temp(); await cli(root, ['init'])
  const stores = await openProject(root)
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await symlink(resolve('node_modules'), join(root, 'node_modules'), 'dir')
  await writeFile(join(stores.paths.workflows, 'small.workflow.ts'), `import { defineWorkflow, script } from '@taktflow/core'\nexport default defineWorkflow({ id: 'small', title: '小流程', version: '1', stages: [], nodes: [script({ id: 'work', title: '工作', run: async () => {} })] })\n`)
  expect((await cli(root, ['workflow', 'ls'])).map((value: { id: string }) => value.id)).toContain('small')
  expect((await cli(root, ['workflow', 'lint', 'small'])).diagnostics).toEqual([])
  const first = await cli(root, ['workflow', 'show', 'small'])
  const edits = join(root, 'edits.json'); await writeFile(edits, JSON.stringify([{ op: 'setMeta', key: 'title', value: '改过的小流程' }]))
  const next = await cli(root, ['workflow', 'edit', 'small', '--edits', edits, '--reason', '改名'])
  expect(next.rev).not.toBe(first.rev)
  const revisions = await cli(root, ['workflow', 'revisions', 'small'])
  expect(revisions).toHaveLength(2); expect(revisions[1].author.type).toBe('human')
  expect((await cli(root, ['workflow', 'rollback', 'small', first.rev])).source).toBe(first.source)
  await writeFile(edits, JSON.stringify({ baseRev: first.rev, edits: [{ op: 'setNeeds', id: 'work', needs: ['unknown'] }] }))
  expect((await cli(root, ['workflow', 'edit', 'small', '--edits', edits], 1)).error).toBe('validation')
  await writeFile(join(stores.paths.workflows, 'broken.workflow.ts'), 'export default nope(')
  expect((await cli(root, ['workflow', 'lint', 'broken'], 1)).diagnostics.length).toBeGreaterThan(0)
}, 20000)

it('space ls 在多空间目录读取配置并列出两个空间；错误 layout 和 serve 参数拒绝', async () => {
  const parent = await temp()
  await cli(join(parent, 'hello-delivery'), ['init'])
  await cli(join(parent, 'standard-delivery'), ['init'])
  expect((await cli(parent, ['space', 'ls'])).map((space: { id: string }) => space.id)).toEqual(['hello-delivery', 'standard-delivery'])
  await cli(parent, ['init', '--layout', 'unknown'], 2)
  await cli(parent, ['serve', '--spaces', parent], 1)
})
