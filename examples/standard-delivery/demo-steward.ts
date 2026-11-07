import assert from 'node:assert/strict'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StewardAgent, buildDigest, refreshRisks, openProject } from '@taktflow/core'
import { createStewardDeps, createSpace, attachKnowledge } from '@taktflow/server'
import { knowledgeRisks } from '@taktflow/knowledge'

const root = process.env.TAKT_DEMO_DIR ?? await mkdtemp(join(tmpdir(), 'takt-steward-'))
await mkdir(root, { recursive: true })
const by = { type: 'human', id: 'demo-owner' } as const
await createSpace({ spacesDir: root }, { id: 'steward-demo', name: '管家规则演示', template: 'blank', reason: '离线管家演示' }, by)
const deps = createStewardDeps({ spacesDir: root, prepareStores: async stores => attachKnowledge(stores, root), steward: { extraRisks: knowledgeRisks } }, by.id)
const agent = new StewardAgent(deps, by.id)
try {
  const context = [{ type: 'space', id: 'steward-demo', spaceId: 'steward-demo' }] as const
  const progress = await agent.ask({ text: '现在进度怎么样', context: [...context] })
  assert.equal(progress.status, 'done'); assert(progress.offline); assert(progress.citations!.length > 0); assert.match(progress.text, /\[1\]/)
  console.log(progress.text, progress.citations)
  const message = await agent.ask({ text: '新建需求 导出支持按月份筛选', context: [...context] }, progress.threadId)
  assert.equal(message.status, 'done')
  const proposal = await agent.store.proposal(message.proposalIds![0]!)
  const applied = await agent.proposals.approve(proposal.id, { hash: proposal.hash }, by)
  assert.equal(applied.status, 'applied', applied.error)
  const stores = await openProject(join(root, 'steward-demo'))
  const created = (await stores.workspaces.listRequirements()).find(req => req.title === '导出支持按月份筛选')!
  assert(created); assert.equal(created.status, 'draft')
  assert((await stores.workspaces.readArtifact({ workspace: created.id, path: 'inputs/prd.md' }))!.toString().includes(created.title))
  assert.equal((await agent.proposals.undo(proposal.id, by)).status, 'reverted')
  assert.equal((await (await openProject(stores.projectDir)).workspaces.getRequirement(created.id))!.status, 'archived')
  console.log('PASS 新建需求提案 → 批准 → 执行 → 撤销（已回读归档状态）')
  console.log('风险：', await refreshRisks(deps, agent.store))
  console.log('汇报：', await buildDigest(deps, agent.store))
  console.log(`演示证据：${root}`)
} finally { agent.close() }
