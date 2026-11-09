import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initProject, openProject, StewardAgent, type StewardBlock } from '@taktflow/core'
import { createStewardDeps } from '@taktflow/server'

/** 确定性场景走真实存储、离线工具和消息持久化，不配置也不调用模型。 */
export async function evalSoloOffline(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'takt-solo-eval-'))
  const agent = new StewardAgent(createStewardDeps({ spacesDir: root }, 'solo-eval'), 'solo-eval')
  try {
    for (const id of ['shop', 'other']) {
      const stores = await initProject(join(root, id), { name: id })
      await stores.workspaces.createRequirement({ id: 'REQ-002', title: id === 'shop' ? '订单导出报表支持 CSV' : '修改地址' })
      await stores.runs.create({ runId: 'run-0002', workflowId: 'delivery', workflowVersion: '1', requirementId: 'REQ-002', status: 'running', startedAt: new Date().toISOString(), nodes: { judge: { id: 'judge', status: 'running', attempts: 1, outputs: [] } }, args: {}, expansions: [] },
        { id: 'delivery', title: '交付流程', version: '1', stages: [{ id: 'dev', title: '研发测试' }], nodes: [{ id: 'judge', title: '失败判决', kind: 'judge', needs: [], stage: 'dev' }] })
    }
    const scenario = async (name: string, text: string, check: (blocks: StewardBlock[]) => void) => {
      const message = await agent.ask({ text })
      assert.equal(message.status, 'done', message.error)
      assert.equal(message.offline, true)
      const saved = (await agent.store.messages(message.threadId)).find(item => item.id === message.id)!
      assert.deepEqual(saved.blocks, message.blocks)
      check(saved.blocks ?? [])
      console.log(`PASS 离线 ${name}`)
    }
    const card = (blocks: StewardBlock[]) => {
      assert.equal(blocks.length, 1)
      const block = blocks[0]!
      assert(block.type === 'entity' && block.view === 'card')
      assert.deepEqual(block.ref, { type: 'requirement', spaceId: 'shop', id: 'REQ-002' })
      assert.equal(block.snapshot.status, '研发测试 · 失败判决在跑')
    }
    await scenario('中文标题片段返回需求卡', '导出报表那个到哪了', card)
    await scenario('编号错一位仍命中', 'shop REQ-003 到哪了', card)
    await scenario('需求运行图', 'shop REQ-002 的运行图', blocks => {
      assert.equal(blocks.length, 1)
      assert(blocks[0]!.type === 'entity' && blocks[0]!.view === 'dag')
      assert.deepEqual(blocks[0]!.ref, { type: 'run', spaceId: 'shop', id: 'run-0002' })
    })
    const other = await openProject(join(root, 'other'))
    await other.workspaces.updateRequirement('REQ-002', { title: '订单导出报表支持 CSV' })
    await scenario('同名跨空间要求选择', '导出报表那个到哪了', blocks => {
      assert.equal(blocks.length, 1)
      const pick = blocks[0]!
      assert(pick.type === 'pick')
      assert.deepEqual(pick.items.map(item => item.ref.spaceId).sort(), ['other', 'shop'])
    })
  } finally {
    await agent.drain(); agent.close()
    await rm(root, { recursive: true, force: true })
  }
}
