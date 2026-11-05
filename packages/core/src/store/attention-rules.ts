import type { AttentionItem } from '../interfaces.js'
import type { ArtifactRef, NodeState } from '../types.js'

export class AttentionAlreadyAnsweredError extends Error {
  constructor(requestId: string) {
    super(`待办已处理：${requestId}`)
    this.name = 'AttentionAlreadyAnsweredError'
  }
}

export type AnswerFreshness = { ok: true } | { ok: false; reason: string }

const refKey = (ref: ArtifactRef): string => `${ref.workspace}\0${ref.path}`

/**
 * 接受答复前检查待办冻结内容是否仍然新鲜：
 * - 节点尝试次数变了（重试/重建）→ 不新鲜；
 * - 任一冻结产物有更新版本（或无法确认最新版本）→ 不新鲜。
 * 历史待办没有 attempt/subjects 时跳过对应检查，保持兼容。
 */
export function checkAnswerFreshness(
  item: AttentionItem,
  nodeState: NodeState,
  latestVersions: readonly ArtifactRef[],
): AnswerFreshness {
  if (item.attempt !== undefined && item.attempt !== nodeState.attempts) {
    return { ok: false, reason: `节点尝试次数已变化：待办是第 ${item.attempt} 次，当前是第 ${nodeState.attempts} 次` }
  }
  if (item.subjects !== undefined) {
    const latest = new Map(latestVersions.map((ref) => [refKey(ref), ref.version]))
    for (const subject of item.subjects) {
      const version = latest.get(refKey(subject))
      if (version === undefined) return { ok: false, reason: `无法确认产物最新版本：${subject.path}` }
      if (subject.version === undefined) return { ok: false, reason: `待办没有冻结产物版本：${subject.path}` }
      if (version !== subject.version) {
        return { ok: false, reason: `产物已有更新版本：${subject.path}（待办 v${subject.version}，当前 v${version}）` }
      }
    }
  }
  return { ok: true }
}

export function validateAnswer(item: AttentionItem, input: { decision?: string; answer?: string }): void {
  if (item.answeredAt !== undefined) throw new AttentionAlreadyAnsweredError(item.requestId)
  if (input.decision === 'choice') {
    if (item.form !== 'choice') throw new Error(`待办表单 ${item.form} 不接受选项回答`)
    if (!item.choices?.includes(input.answer ?? '')) throw new Error(`回答必须是以下选项之一：${(item.choices ?? []).join(', ')}`)
    return
  }
  if (input.decision === 'approve' || input.decision === 'reject') {
    if (item.form !== 'approve') throw new Error(`待办表单 ${item.form} 不接受审批决定`)
    return
  }
  if (input.decision !== undefined) throw new Error(`不支持的回答决定：${input.decision}`)
  if (item.form !== 'answer') throw new Error(`待办表单 ${item.form} 不接受文本回答`)
  if (!input.answer?.trim()) throw new Error('回答不能为空')
}
