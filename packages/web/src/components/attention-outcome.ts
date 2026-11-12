import type { AttentionItem } from '@taktflow/core'
import type { Tone } from '../lib/status'

export type AnswerOutcome = { body: string; tone: Tone; stopped?: true }

/**
 * 提交待办之后运行会怎样（提交成功提示的正文）。服务端 answer 只回待办本身，这里按所选选项写，
 * 与引擎对各类回答的处理一致：engine/runtime.ts consume（重复失败）、engine/budget.ts（预算）、engine/nodes/review.ts answerReview（评审裁决）。
 * 终止类选项不能再写"运行将自动继续"。
 */
export function answerOutcome(item: Pick<AttentionItem, 'nodeId' | 'runId' | 'kind' | 'choices'>, body: { decision?: string; answer?: string }): AnswerOutcome {
  const node = item.nodeId
  if ((item.kind === 'retry' || item.kind === 'budget') && (body.decision === 'cancelled' || body.decision === 'choice' && body.answer === (item.kind === 'retry' ? '终止运行' : '停止运行')))
    return { body: `已提交终止运行 ${item.runId}，运行将停止；可在需求页查看进展。`, tone: 'skipped', stopped: true }
  if (body.decision === 'cancelled') return { body: `已提交取消节点 ${node}，不会继续执行这个节点。`, tone: 'skipped', stopped: true }
  if (body.decision === 'choice' && item.kind === 'retry')
    switch (body.answer) {
      case '再试一次':
        return { body: `${node} 会重新执行，运行将自动继续。`, tone: 'success' }
      case '交给人处理':
        return { body: `${node} 已标为阻塞、交给人处理，不会自动重跑；处理好后在运行页重试这个节点。`, tone: 'waiting' }
    }
  if (body.decision === 'choice' && (!item.kind || item.kind === 'node') && ['放行', '打回', '终止'].every(choice => item.choices?.includes(choice))) {
    if (body.answer === '终止') return { body: `已提交终止评审 ${node}，这个节点会记为失败。`, tone: 'skipped', stopped: true }
    if (body.answer === '打回') return { body: `${node} 已打回重做，运行将自动继续。`, tone: 'success' }
  }
  if (body.decision === 'reject') return { body: `已打回 ${node}，运行按流程处理打回，不会按原样往下走。`, tone: 'waiting' }
  return { body: '已提交，运行将自动继续。', tone: 'success' }
}
