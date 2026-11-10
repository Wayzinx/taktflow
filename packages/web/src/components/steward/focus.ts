import { createContext, useContext } from 'react'
import type { StewardContextRef } from '@taktflow/core'

/**
 * Solo 的焦点面板（docs/design/28 §1）：会话里的实体视图把自己"递"给面板。
 * 跟随时面板换成最新出现的那个；人点"在右侧展开"就换过去并固定。停靠面板里没有焦点面板，视图改为跳页。
 */
export interface FocusTarget {
  /** 需求、运行、空间或需求里的产物文件（节点用运行 + node 表示；文件是 file，id 为需求内路径，parent 为需求）。 */
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

/** 地址里的写法：requirement:<space>/<id> | run:<space>/<runId>[/<nodeId>] | space:<id> | file:<space>/<需求>/<路径>。 */
export function encodeFocus(t: FocusTarget): string {
  if (t.ref.type === 'space') return `space:${t.ref.id}`
  if (t.ref.type === 'file') return `file:${t.ref.spaceId ?? ''}/${t.ref.parent ?? ''}/${t.ref.id}`
  return `${t.ref.type}:${t.ref.spaceId ?? ''}/${t.ref.id}${t.node ? `/${t.node}` : ''}`
}

export function decodeFocus(s: string | null | undefined): FocusTarget | undefined {
  const m = s ? /^(space|requirement|run|file):(.+)$/.exec(s) : null
  if (!m) return undefined
  const type = m[1] as 'space' | 'requirement' | 'run' | 'file'
  if (type === 'space') return { ref: { type, id: m[2]! } }
  if (type === 'file') {
    const [spaceId, req, ...path] = m[2]!.split('/')
    return spaceId && req && path.length ? fileFocus(spaceId, req, path.join('/')) : undefined
  }
  const [spaceId, id, ...node] = m[2]!.split('/')
  if (!spaceId || !id) return undefined
  return { ref: { type, spaceId, id, label: id }, node: type === 'run' && node.length ? node.join('/') : undefined }
}

export const sameFocus = (a?: FocusTarget, b?: FocusTarget) => (a && b ? encodeFocus(a) === encodeFocus(b) : a === b)

export const fileFocus = (spaceId: string, requirementId: string, path: string): FocusTarget => ({
  ref: { type: 'file', spaceId, id: path, parent: requirementId, label: path.split('/').pop() },
})

/**
 * 链接指向需求里的产物时换成文件焦点：产物页地址（/req/<需求>?tab=artifacts&path=…，可带 /s/<空间> 前缀），
 * 或管家写出的文件路径（…/spaces/<空间>/requirements/<需求>/…、requirements/<需求>/…、.takt/workspaces/<需求>/…）。
 */
export function fileFocusOf(href: string, space?: string): FocusTarget | undefined {
  let url: URL
  try {
    url = new URL(href, 'http://local')
  } catch {
    return undefined
  }
  const page = /^(?:\/s\/([^/]+))?\/req\/([^/]+)\/?$/.exec(url.pathname)
  const path = url.searchParams.get('path')
  if (page && path && (url.searchParams.get('tab') ?? 'artifacts') === 'artifacts') {
    const sid = page[1] ? decodeURIComponent(page[1]) : space
    return sid ? fileFocus(sid, decodeURIComponent(page[2]!), path) : undefined
  }
  const file = decodeURIComponent(url.pathname)
  const abs = /\/spaces\/([^/]+)\/(?:requirements|\.takt\/workspaces)\/([^/]+)\/(.+)$/.exec(file)
  if (abs) return fileFocus(abs[1]!, abs[2]!, abs[3]!)
  const rel = /^\/?(?:requirements|\.takt\/workspaces)\/([^/]+)\/(.+)$/.exec(file)
  return rel && space ? fileFocus(space, rel[1]!, rel[2]!) : undefined
}

/** 文件焦点对应的完整页面地址（不带空间前缀）。 */
export const filePagePath = (t: FocusTarget) => `/req/${encodeURIComponent(t.ref.parent ?? '')}?tab=artifacts&path=${encodeURIComponent(t.ref.id)}`
