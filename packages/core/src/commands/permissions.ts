import type { Actor, SpaceMember } from '../types.js'
import type { ProjectStores } from '../interfaces.js'

const ranks: Record<SpaceMember['role'], number> = { viewer: 0, member: 1, maintainer: 2, owner: 3 }
export function requireRole(stores: ProjectStores, actor: Actor, minRole: SpaceMember['role'], operation: string): void {
  const humanRole = (id: string) => stores.config.members?.length ? stores.config.members.find((member) => member.id === id)?.role : 'owner'
  // 代人执行的 agent（dsh 里的 Lead）按被代表的人的角色算，不会超过那个人；其余 agent 只有 member。
  const role = actor.type === 'agent' ? actor.onBehalfOf ? humanRole(actor.onBehalfOf) : 'member'
    : actor.type === 'system' && actor.id === 'lead' ? 'member'
      : actor.type === 'human' ? humanRole(actor.id)
        : undefined
  if (!role || ranks[role] < ranks[minRole]) throw new Error(`权限不足：${operation} 需要 ${minRole}`)
}
