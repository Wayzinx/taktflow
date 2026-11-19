import type { SpaceMember } from '@taktflow/core'
import type { FeishuBinding, FeishuBindingUpdate, FeishuMemberMapping } from '../../api/feishu.js'

export interface MappingRow extends FeishuMemberMapping {
  key: number
}

export interface FeishuDraft {
  chatId: string
  members: MappingRow[]
}

export function feishuDraft(binding: FeishuBinding | null): FeishuDraft {
  return {
    chatId: binding?.chatId ?? '',
    members: binding?.members.map(({ openId, memberId }, key) => ({ openId, memberId, key })) ?? [],
  }
}

export function bindingUpdate(draft: FeishuDraft, base: FeishuBinding | null, spaceMembers: SpaceMember[]):
  { update: FeishuBindingUpdate } | { error: string } {
  const chatId = draft.chatId.trim()
  if (!/^oc_[\w-]+$/.test(chatId)) return { error: '请输入以 oc_ 开头的飞书群 ID，不要填群链接。' }

  const members = draft.members.map(({ openId, memberId }) => ({ openId: openId.trim(), memberId }))
  const known = new Set(spaceMembers.map(({ id }) => id))
  const seen = new Set<string>()
  for (const [index, { openId, memberId }] of members.entries()) {
    const row = `第 ${index + 1} 条映射`
    if (!/^ou_[\w-]+$/.test(openId)) return { error: `${row}：请输入以 ou_ 开头的飞书 Open ID。` }
    if (!known.has(memberId)) return { error: `${row}：请从当前空间成员中选择一人，或移除此条映射。` }
    if (seen.has(openId)) return { error: `${row}：此飞书 Open ID 已有映射。` }
    seen.add(openId)
  }
  return { update: { chatId, members, baseRevision: base?.revision ?? null } }
}
