import type { StewardThread } from '@taktflow/core'

/** Solo 会话列表的分组（docs/design/30 §2）。纯函数，单测在 thread-groups.test.ts。 */
export type GroupBy = 'time' | 'space' | 'requirement' | 'status'

const needsYou = (t: StewardThread) => (t.pendingProposals ?? 0) > 0 || t.status === 'error' || t.status === 'interrupted'

function dayBucket(iso: string): { key: string; label: string } {
  const d = new Date(iso)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const days = Math.floor((today.getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000)
  if (days <= 0) return { key: '0', label: '今天' }
  if (days === 1) return { key: '1', label: '昨天' }
  if (days < 7) return { key: '2', label: '7 天内' }
  return { key: '3', label: '更早' }
}

interface Group {
  key: string
  label: string
  items: StewardThread[]
}

/** 置顶的总在最上面一组；其余按选的方式分组，组按最近一次更新排。 */
export function groupThreads(list: StewardThread[], by: GroupBy, spaceName: (id: string) => string | undefined): Group[] {
  const pinned = list.filter((t) => t.pinnedAt)
  const rest = list.filter((t) => !t.pinnedAt)
  const groups = new Map<string, Group>()
  const add = (key: string, label: string, t: StewardThread) => {
    const g = groups.get(key) ?? { key, label, items: [] }
    g.items.push(t)
    groups.set(key, g)
  }
  for (const t of rest) {
    if (by === 'time') {
      const b = dayBucket(t.updatedAt)
      add(b.key, b.label, t)
    } else if (by === 'space') add(t.spaceId ? `s:${t.spaceId}` : '~', t.spaceId ? (spaceName(t.spaceId) ?? t.spaceId) : '没关联空间', t)
    else if (by === 'requirement') add(t.requirementId ? `r:${t.spaceId}/${t.requirementId}` : '~', t.requirementId ? `${t.requirementId} ${t.requirementTitle ?? ''}`.trim() : '没关联需求', t)
    else add(needsYou(t) ? '0' : t.status === 'replying' ? '1' : '2', needsYou(t) ? '需要你处理' : t.status === 'replying' ? '回复中' : '其他', t)
  }
  const order = [...groups.values()].sort((a, b) => {
    if (by === 'time' || by === 'status') return a.key.localeCompare(b.key)
    // "没关联"的放最后，其余按组里最近的会话排
    if (a.key === '~' || b.key === '~') return a.key === '~' ? 1 : -1
    return b.items[0]!.updatedAt.localeCompare(a.items[0]!.updatedAt)
  })
  return [...(pinned.length ? [{ key: 'pinned', label: '置顶', items: pinned }] : []), ...order]
}
