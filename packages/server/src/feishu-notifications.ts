import { join } from 'node:path'
import { assertNoSymlinks, readJsonFile, writeFileAtomic, type ProjectStores } from '@taktflow/core'
import { feishuAttentionCard } from './feishu-actions.js'
import type { FeishuBinding } from './feishu-bindings.js'
import type { FeishuEnvelope, FeishuQueue } from './feishu-queue.js'
import { spaceId } from './space.js'
import { teamRoomStore } from './team-room-store.js'

type Message = NonNullable<FeishuEnvelope['message']>
interface Cursor {
  revision: string
  position: number
  // 只跟踪本次绑定期间在团队会话中发起的运行。
  watching: Record<string, string[]>
}

export async function scanFeishuSpace(stores: ProjectStores, binding: FeishuBinding, publicUrl: string, queue: FeishuQueue) {
  const file = join(stores.taktDir, 'runs', '.feishu-sync', 'cursor.json')
  await assertNoSymlinks(stores.taktDir, file)
  const previous = await readJsonFile<Cursor>(file)
  const cursor: Cursor = previous?.revision === binding.revision ? previous : { revision: binding.revision, position: 0, watching: {} }
  const messages = await teamRoomStore(stores.taktDir).messages()
  const id = spaceId(stores)
  const emit = (key: string, message: Message) => queue.put({
    key: `notice:${binding.revision}:${key}`, spaceId: id, revision: binding.revision, chatId: binding.chatId, message,
  })
  let changed = previous !== cursor
  for (const message of messages.slice(cursor.position)) {
    if (message.at >= binding.updatedAt) {
      if (message.source !== 'feishu') {
        const name = message.role === 'steward' ? '管家' : stores.config.members?.find(m => m.id === message.author)?.name ?? message.author
        await emit('room:' + message.id, { type: 'text', content: { text: `【${name} · 空间对话】\n${message.text.slice(0, 4500)}` } })
      }
      if (message.runId) cursor.watching[message.runId] ??= []
    }
    cursor.position++
    changed = true
  }
  const runs = Object.keys(cursor.watching)
  const pending = runs.length ? await stores.attention.list({ pending: true }) : []
  for (const runId of runs) {
    for (const item of pending.filter(item => item.runId === runId)) {
      if (cursor.watching[runId]!.includes(item.requestId)) continue
      const url = `${publicUrl}/s/${encodeURIComponent(id)}/run/${encodeURIComponent(runId)}`
      const card = item.form === 'approve'
        ? await feishuAttentionCard(stores, binding.revision, publicUrl, item.requestId, binding.chatId) : undefined
      if (item.form === 'approve' && !card) continue
      await emit('attention:' + item.requestId, card ?? { type: 'text', content: { text: `需要人工处理：${item.ask.slice(0, 1000)}\n${url}` } })
      cursor.watching[runId]!.push(item.requestId)
      changed = true
    }
    const run = await stores.runs.get(runId)
    if (!run || !['succeeded', 'failed', 'cancelled'].includes(run.status)) continue
    const label = run.status === 'succeeded' ? '已完成' : run.status === 'failed' ? '失败' : '已取消'
    await emit('run:' + runId, { type: 'text', content: {
      text: `需求 ${run.requirementId} 的流程${label}。\n${publicUrl}/s/${encodeURIComponent(id)}/run/${encodeURIComponent(runId)}`,
    } })
    delete cursor.watching[runId]
    changed = true
  }
  if (changed) await writeFileAtomic(file, JSON.stringify(cursor))
}
