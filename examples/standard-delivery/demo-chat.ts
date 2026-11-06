import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initProject, openProject, type RoomMessage, type RunSummary } from '@taktflow/core'
import { createServer } from '@taktflow/server'
import { createProjectLead } from '../../packages/cli/src/lead.js'
import { loadRuntime } from '../../packages/cli/src/project.js'
import { main } from '../../packages/cli/src/index.js'

const example = dirname(fileURLToPath(import.meta.url))
// TAKT_DEMO_DIR：把演示数据留在指定目录（需不存在或为空），便于用 takt serve 查看
const root = process.env.TAKT_DEMO_DIR ? await mkdir(process.env.TAKT_DEMO_DIR, { recursive: true }).then(() => process.env.TAKT_DEMO_DIR as string) : await mkdtemp(join(tmpdir(), 'takt-chat-demo-'))
const stores = await initProject(root)
await writeFile(join(root, 'package.json'), '{"type":"module"}')
for (const role of ['lead', 'pm', 'reviewer']) {
  const source = await readFile(join(example, 'agents', `${role}.md`), 'utf8')
  await writeFile(join(stores.paths.agents, `${role}.md`), source.replace(/^harness:.*$/m, 'harness: mock'))
}
stores.config.workflows = []
stores.config.lead = { harness: { harness: 'mock' }, progressUpdates: true }
stores.config.members = [{ id: 'demo-owner', name: 'Demo', role: 'owner' }]
await writeFile(join(root, 'takt.config.json'), JSON.stringify(stores.config, null, 2))
await cp(join(example, 'chat-mock.json'), join(stores.taktDir, 'mock.json'))
const requirement = await stores.workspaces.createRequirement({ title: '群聊驱动 PRD 修改', owner: 'demo-owner' })
assert.equal(requirement.id, 'REQ-001')
await stores.workspaces.writeArtifact({ ref: { workspace: requirement.id, path: 'spec/prd.md' }, kind: 'spec',
  content: '# 问候语 PRD\n\n- AC-1：有名字时返回 Hello, <name>!\n- AC-2：空名字行为待明确。\n', author: { type: 'human', id: 'demo-owner' }, reason: '演示基线' })
for (const text of ['@lead 现在进展如何', '@lead 把 PRD 里 AC-2 的描述改成：空名字返回 Hello, stranger!。']) {
  assert.equal(await main(['chat', 'post', requirement.id, text, '--project', root, '--json']), 0, `群聊命令失败：${text}`)
}
// 从磁盘重新打开，验证持久化结果及 HTTP 读模型，而非依赖内存返回值。
const reopened = await openProject(root)
const messages: RoomMessage[] = await reopened.chat.list(requirement.id)
const triggers = messages.filter((message) => message.author.type === 'human')
assert.equal(triggers.length, 2)
assert(messages.some((message) => message.author.type === 'agent' && message.author.role === 'lead' && message.replyTo === triggers[0]!.id && message.text.includes('第 1 版')))
const presence: string[] = []
const lead = await createProjectLead(await loadRuntime(root), (_id, value) => { presence.push(value.state) })
const server = await createServer({ projectDir: root, port: 0, getCommands: () => lead.commands,
  getLeadPresence: (_dir, id) => lead.getPresence(id), onLeadMention: async (id, message) => { await lead.onMessage(id, message) } })
try {
  const response = await fetch(`${server.url}/api/runs`)
  assert.equal(response.status, 200)
  const runs = await response.json() as RunSummary[]
  const task = runs.find((run) => run.workflowId === 'task:pm')!
  assert(task, '缺少临时任务运行')
  assert.equal(task.kind, 'task'); assert.equal(task.status, 'succeeded')
  assert.equal(task.origin?.messageId, triggers[1]!.id)
  assert.deepEqual(task.origin?.by, triggers[1]!.author)
  const rounds = runs.filter((run) => run.workflowId === 'lead')
  assert.equal(rounds.length, 2)
  for (const [index, run] of rounds.entries()) {
    assert.equal(run.kind, 'task'); assert.equal(run.origin?.messageId, triggers[index]!.id)
    assert.deepEqual(Object.keys((await reopened.runs.get(run.runId))!.nodes), ['lead'])
  }
  const cards = messages.filter((message) => message.kind === 'task' && message.refs?.taskRunId === task.runId)
  assert(cards.some((card) => card.text.includes('已派发')))
  assert(cards.length >= 2)
  assert(cards.some((card) => card.text.includes('succeeded') && card.refs?.artifacts?.some((ref) => ref.path === 'spec/prd.md' && ref.version === 2)))
  assert(messages.some((message) => message.author.type === 'agent' && message.author.role === 'lead' && message.kind === 'progress' && message.refs?.runId === task.runId && message.text.includes('运行结束：succeeded')))
  const prd = (await reopened.workspaces.listArtifacts(requirement.id)).find((artifact) => artifact.path === 'spec/prd.md')!
  assert.equal(prd.versions.length, 2)
  assert((await reopened.workspaces.readArtifact({ workspace: requirement.id, path: prd.path, version: 2 }))!.toString().includes('AC-2：空名字返回 Hello, stranger!。'))
  assert.equal(prd.versions[1]!.producedBy?.runId, task.runId)
  for (const run of runs) assert.deepEqual(await reopened.events.verify(run.runId), { ok: true })
  assert.deepEqual(await reopened.workspaces.detectUntracked(requirement.id), [])
  // 单独的小流程验证 auto 路由接入，不把 mock 路由冒充产品验收。
  await writeFile(join(stores.paths.workflows, 'chat-auto.workflow.ts'), `export default { id: 'chat-auto', title: '群聊路由演示', tiers: ['T0','T1'], version: '1', stages: [], nodes: [{ id: 'ready', kind: 'script', title: '路由接入', run: async () => {} }] }`)
  const autoLead = await createProjectLead(await loadRuntime(root), (_id, value) => { presence.push(value.state) })
  const trigger = await reopened.chat.post(requirement.id, { author: { type: 'human', id: 'demo-owner' }, kind: 'text', text: '@lead 自动启动', mentions: ['lead'] })
  await autoLead.onMessage(requirement.id, trigger); await autoLead.drain()
  const routeCard = (await reopened.chat.list(requirement.id)).find((message) => message.kind === 'route')
  assert.equal(routeCard?.route?.workflowId, 'chat-auto')
  const routed = (await reopened.runs.list()).find((run) => run.workflowId === 'chat-auto')!
  assert.equal(routed.route?.tier, 'T1')
  assert((await reopened.events.read(routed.runId)).some((event) => event.type === 'route.decided'))
  assert(presence.includes('thinking') && presence.includes('working') && presence.includes('idle'))
  console.log(`PASS 离线群聊：${messages.length} 条消息、${runs.length} 个 task 运行、PRD v2、独立评审、任务卡片更新、Lead 回报和全部审计链。\n证据目录：${root}`)
} finally { await server.close() }
