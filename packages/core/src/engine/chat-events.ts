import { join } from 'node:path'
import { withFileLock } from '../store/file-lock.js'
import type { ProjectStores } from '../interfaces.js'
import type { EventEnvelope, EventPayloads, NodeState, RoomMessage, RunState, RunStatus, WorkflowSnapshot } from '../types.js'
import { stageProgress } from '../insights/graph.js'
import { briefError, briefReviewFeedback } from '../util/brief.js'

const RUN_END: Record<string, string> = { succeeded: '成功', failed: '失败', cancelled: '已取消', waiting_human: '等人处理' }

/** 运行停下时的一句话：等人是暂停而不是结束；失败和暂停都带上卡住的节点与原因，不用点进运行页才知道。 */
export function runEndText(state: RunState, status: RunStatus): { text: string; nodeId?: string } {
  if (status !== 'failed' && status !== 'waiting_human') return { text: `运行结束：${RUN_END[status] ?? status}` }
  const nodes = Object.values(state.nodes)
  const pick = (value: NodeState['status']) => nodes.find((node) => node.status === value && node.error)
  const stuck = status === 'failed' ? pick('failed') ?? pick('blocked')
    : pick('blocked') ?? pick('failed') ?? nodes.find((node) => node.status === 'waiting_human')
  const why = stuck ? ` · ${stuck.id}${stuck.error ? `：${briefError(stuck.error, 160)}` : ''}` : ''
  return { text: status === 'failed' ? `运行结束：失败${why}` : `运行暂停：等人处理${why}`, nodeId: stuck?.id }
}

/** 引擎只在这里把关键事件投影为房间消息，refs 保留回到运行/待办的入口。 */
export async function postEventMessage(stores: ProjectStores, state: RunState, event: EventEnvelope, snapshot?: WorkflowSnapshot): Promise<void> {
  let text: string | undefined
  let kind: RoomMessage['kind'] = 'system'
  const refs: NonNullable<RoomMessage['refs']> = { runId: state.runId, nodeId: event.nodeId }
  // Lead 回合自己回复或报错；再投影它的"运行开始 / 结束"只会刷屏，失败时还把同一条报错重复一遍。
  if (state.workflowId === 'lead' && (event.type === 'run.started' || event.type === 'run.finished')) return
  switch (event.type) {
    case 'run.started': text = '运行开始'; break
    case 'run.finished': {
      const end = runEndText(state, (event.data as EventPayloads['run.finished']).status)
      text = end.text; refs.nodeId ??= end.nodeId; break
    }
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
      text = `打回重做：${data.from} → ${data.to}，第 ${data.count} 次。${briefReviewFeedback(data.feedback)}`; break
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
