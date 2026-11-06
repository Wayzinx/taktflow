import type { Actor, SpaceMember } from '../types.js'
import type { ProjectStores } from '../interfaces.js'

const ranks: Record<SpaceMember['role'], number> = { viewer: 0, member: 1, maintainer: 2, owner: 3 }
export function requireRole(stores: ProjectStores, actor: Actor, minRole: SpaceMember['role'], operation: string): void {
  const role = actor.type === 'agent' || actor.type === 'system' && actor.id === 'lead' ? 'member'
    : actor.type === 'human' ? stores.config.members?.length
      ? stores.config.members.find((member) => member.id === actor.id)?.role : 'owner'
      : undefined
  if (!role || ranks[role] < ranks[minRole]) throw new Error(`权限不足：${operation} 需要 ${minRole}`)
}
