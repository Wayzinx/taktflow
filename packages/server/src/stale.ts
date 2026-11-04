import { withLock } from '@taktflow/core'

export function serialize<T>(projectDir: string, operation: () => Promise<T>): Promise<T> {
  return withLock(projectDir, operation)
}
