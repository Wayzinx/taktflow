import type { StewardContextRef } from '@taktflow/core'
import { spacePath } from '../../lib/space'

/** 管家块 / 泳道里的对象引用 → 站内路径；file 这类没有页面的返回 undefined。 */
export function refPath(ref: StewardContextRef): string | undefined {
  const rest =
    ref.type === 'space' ? '/'
    : ref.type === 'requirement' ? `/req/${ref.id}`
    : ref.type === 'run' ? `/run/${ref.id}`
    : ref.type === 'workflow' ? `/workflows/${ref.id}`
    : ref.type === 'knowledge' ? `/knowledge/${ref.id}`
    : ref.type === 'node' && ref.parent ? `${ref.parent.startsWith('run-') ? '/run/' : '/workflows/'}${ref.parent}?node=${encodeURIComponent(ref.id)}`
    : undefined
  if (!rest) return undefined
  const space = ref.type === 'space' ? ref.id : ref.spaceId
  return space ? spacePath(space, rest) : rest
}
