import type { CommandRegistry, ProjectStores } from '@taktflow/core'
import { cliActor } from './actor.js'

export async function executeCommand<T>(stores: ProjectStores, commands: CommandRegistry, id: string, input: Record<string, unknown>, reason?: string): Promise<T> {
  const result = await commands.run(id, JSON.parse(JSON.stringify(input)) as Record<string, unknown>, { actor: cliActor(stores), reason: reason ?? `CLI ${id}` })
  if (!result.ok) throw new Error(result.message)
  return result.result as T
}
