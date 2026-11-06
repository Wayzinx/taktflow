import type { Actor, ProjectStores } from '@taktflow/core'
import { currentUser } from './commands/ws.js'

export function cliActor(stores: ProjectStores): Actor {
  const user = currentUser(stores.projectDir)
  return { type: 'human', id: stores.config.members?.find((member) => member.id === user)?.id
    ?? stores.config.members?.find((member) => member.role === 'owner')?.id ?? user }
}
