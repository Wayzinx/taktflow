import type { StewardContextRef, StewardMessage, StewardThread } from '../api.js'

export function threadMetadata(thread: StewardThread, messages: StewardMessage[]): Pick<StewardThread, 'messageCount' | 'spaceId' | 'requirementId' | 'requirementTitle'> {
  const refs: StewardContextRef[] = [...(thread.context ?? [])]
  for (const message of messages) {
    refs.push(...(message.context ?? []))
    for (const block of message.blocks ?? []) {
      if (block.type === 'entity') refs.push({ ...block.ref, label: block.snapshot.title ?? block.ref.label })
    }
  }
  const requirements = new Map<string, { ref: StewardContextRef; count: number }>()
  const spaces = new Map<string, number>()
  for (const ref of refs) {
    const space = ref.spaceId ?? (ref.type === 'space' ? ref.id : undefined)
    if (!space) continue
    spaces.set(space, (spaces.get(space) ?? 0) + 1)
    if (ref.type !== 'requirement') continue
    const key = JSON.stringify([space, ref.id]), previous = requirements.get(key)
    // 页面自动带的上下文标签就是编号本身（REQ-001），不能当标题：留空让存储层去查真实标题
    const label = ref.label && ref.label !== ref.id ? ref.label : undefined
    requirements.set(key, { ref: { ...ref, spaceId: space, label: label ?? previous?.ref.label }, count: (previous?.count ?? 0) + 1 })
  }
  const top = [...requirements.values()].sort((a, b) => b.count - a.count)[0]?.ref
  return { messageCount: messages.length,
    spaceId: top?.spaceId ?? [...spaces].sort((a, b) => b[1] - a[1])[0]?.[0],
    requirementId: top?.id, requirementTitle: top?.label }
}
