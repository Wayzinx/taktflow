import { projectCommands as createCommands } from '@taktflow/server'
import { cliWriteLease } from './lease.js'

export const projectCommands: typeof createCommands = (stores, handlers, runtime, withWriteLease = cliWriteLease) =>
  createCommands(stores, handlers, runtime, withWriteLease)
