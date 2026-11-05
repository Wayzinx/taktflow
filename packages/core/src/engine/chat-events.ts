import { join } from 'node:path'
import { withFileLock } from '../store/file-lock.js'
import type { ProjectStores } from '../interfaces.js'
import type { EventEnvelope, EventPayloads, RoomMessage, RunState, WorkflowSnapshot } from '../types.js'
import { stageProgress } from '../insights/graph.js'

/** 引擎只在这里把关键事件投影为房间消息，refs 保留回到运行/待办的入口。 */
export async function postEventMessage(stores: ProjectStores, state: RunState, event: EventEnvelope, snapshot?: WorkflowSnapshot): Promise<void> {
  let text: string | undefined
  let kind: RoomMessage['kind'] = 'system'
  const refs: NonNullable<RoomMessage['refs']> = { runId: state.runId, nodeId: event.nodeId }
  switch (event.type) {
    case 'run.started': text = '运行开始'; break
    case 'run.finished': text = `运行结束：${(event.data as EventPayloads['run.finished']).status}`; break
    case 'human.requested': {
      const data = event.data as EventPayloads['human.requested']
      text = data.ask; kind = 'attention'; refs.requestId = data.requestId; break
    }
    case 'review.round': {
      const data = event.data as EventPayloads['review.round']
      text = `评审 ${event.nodeId} 第 ${data.round} 轮：${data.passed ? '通过' : '未通过'}；${data.verdicts.map((v) => `${v.reviewer}: ${v.verdict}`).join('；')}`
      kind = 'progress'; break
    }
    case 'rework.started': {
      const data = event.data as EventPayloads['rework.started']
      text = `打回重做：${data.from} → ${data.to}，第 ${data.count} 次。${data.feedback}`; break
    }
    case 'node.finished': {
      if (!snapshot) break
      await withFileLock(join(stores.taktDir, 'chat', state.requirementId, 'stage-messages'), async () => {
        const previous = await stores.chat.list(state.requirementId)
        for (const stage of stageProgress(snapshot, state).filter((stage) => stage.status === 'done')) {
          const text = `阶段完成：${stage.title}`
          if (!previous.some((message) => message.refs?.runId === state.runId && message.text === text)) {
            await stores.chat.post(state.requirementId, { author: { type: 'system', id: 'engine' }, kind: 'system', text, refs })
          }
        }
      })
      break
    }
  }
  if (text) await stores.chat.post(state.requirementId, { author: { type: 'system', id: 'engine' }, kind, text, refs })
}
