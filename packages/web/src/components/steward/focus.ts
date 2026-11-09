import { createContext, useContext } from 'react'
import type { StewardContextRef } from '@taktflow/core'

/**
 * Solo 的焦点面板（docs/design/28 §1）：会话里的实体视图把自己"递"给面板。
 * 跟随时面板换成最新出现的那个；人点"在右侧展开"就换过去并固定。停靠面板里没有焦点面板，视图改为跳页。
 */
export interface FocusTarget {
  /** 需求、运行或空间（节点用运行 + node 表示）。 */
  ref: StewardContextRef
  node?: string
}

export interface EntityFocusApi {
  offer(t: FocusTarget): void
  open(t: FocusTarget): void
  current?: FocusTarget
}

export const EntityFocusContext = createContext<EntityFocusApi | null>(null)
export const useEntityFocus = () => useContext(EntityFocusContext)

/** 节点引用换成"运行 + 选中节点"，其余原样。 */
export function focusOf(ref: StewardContextRef, node?: string): FocusTarget {
  if (ref.type === 'node' && ref.parent) return { ref: { type: 'run', spaceId: ref.spaceId, id: ref.parent, label: ref.parent }, node: ref.id }
  return { ref, node }
}

/** 地址里的写法：requirement:<space>/<id> | run:<space>/<runId>[/<nodeId>] | space:<id>。 */
export function encodeFocus(t: FocusTarget): string {
  if (t.ref.type === 'space') return `space:${t.ref.id}`
  return `${t.ref.type}:${t.ref.spaceId ?? ''}/${t.ref.id}${t.node ? `/${t.node}` : ''}`
}

export function decodeFocus(s: string | null | undefined): FocusTarget | undefined {
  const m = s ? /^(space|requirement|run):(.+)$/.exec(s) : null
  if (!m) return undefined
  const type = m[1] as 'space' | 'requirement' | 'run'
  if (type === 'space') return { ref: { type, id: m[2]! } }
  const [spaceId, id, ...node] = m[2]!.split('/')
  if (!spaceId || !id) return undefined
  return { ref: { type, spaceId, id, label: id }, node: type === 'run' && node.length ? node.join('/') : undefined }
}

export const sameFocus = (a?: FocusTarget, b?: FocusTarget) => (a && b ? encodeFocus(a) === encodeFocus(b) : a === b)
