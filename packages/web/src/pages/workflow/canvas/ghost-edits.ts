import type { EditableValue, WorkflowEdit } from '@taktflow/core'
import { literalOf } from '../../../api/workflow-edit'
import type { WorkflowPreview } from '../../../lib/ui-store'

/** 幽灵预览要画的改动：提案步骤里的 edits。 */
export function ghostEdits(p: WorkflowPreview): WorkflowEdit[] {
  return p.step.edits
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export interface GhostLink {
  key: string
  path: string
  /** add：新增依赖（绿色虚线）；del：去掉的依赖（红色虚线 + ×）。 */
  tone: 'add' | 'del'
  mid: { x: number; y: number }
}

export interface GhostLayout {
  added: Array<{ key: string; id?: string; box: Box; title: string; kind: string }>
  removed: Array<{ id: string; box: Box }>
  changed: Map<string, { box: Box; keys: string[] }>
  links: GhostLink[]
}

const GAP = 56
const STACK = 24

/**
 * 两个框之间的连线（与 build-flow 的 handles 同一规则）：上下叠放走 底→顶，否则 右→左；
 * 目标在左边时从左边出、进目标右边，避免穿过节点。
 */
export function connect(a: Box, b: Box): { path: string; mid: { x: number; y: number } } {
  let s: [number, number], t: [number, number], d: [number, number]
  if (b.x >= a.x + a.w) {
    s = [a.x + a.w, a.y + a.h / 2]
    t = [b.x, b.y + b.h / 2]
    d = [1, 0]
  } else if (b.x + b.w <= a.x) {
    s = [a.x, a.y + a.h / 2]
    t = [b.x + b.w, b.y + b.h / 2]
    d = [-1, 0]
  } else if (b.y >= a.y) {
    s = [a.x + a.w / 2, a.y + a.h]
    t = [b.x + b.w / 2, b.y]
    d = [0, 1]
  } else {
    s = [a.x + a.w / 2, a.y]
    t = [b.x + b.w / 2, b.y + b.h]
    d = [0, -1]
  }
  const k = Math.max(24, (Math.abs(t[0] - s[0]) + Math.abs(t[1] - s[1])) * 0.35)
  const c1: [number, number] = [s[0] + d[0] * k, s[1] + d[1] * k]
  const c2: [number, number] = [t[0] - d[0] * k, t[1] - d[1] * k]
  const r = (n: number) => Math.round(n * 10) / 10
  return {
    path: `M${r(s[0])},${r(s[1])} C${r(c1[0])},${r(c1[1])} ${r(c2[0])},${r(c2[1])} ${r(t[0])},${r(t[1])}`,
    mid: { x: r((s[0] + 3 * c1[0] + 3 * c2[0] + t[0]) / 8), y: r((s[1] + 3 * c1[1] + 3 * c2[1] + t[1]) / 8) },
  }
}

const strings = (v: EditableValue | null | undefined): string[] | undefined => {
  const l = v ? literalOf<unknown>(v) : undefined
  return Array.isArray(l) ? l.filter((x): x is string => typeof x === 'string') : undefined
}

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/**
 * 把提案的 edits 摆到画布坐标上：
 * - 新节点放在"上游（needs / after）与下游（edits 里把 needs 改成指向它的节点）"之间、所在列的右侧，
 *   画出 上游 → 新节点 → 下游 的绿色虚线；没有下游时紧挨上游右侧；同一位置已有幽灵时往下叠；
 * - setNeeds / setProp(needs) 去掉的依赖画红色虚线（needsOf 给出现有依赖）；
 * - 其余改动打琥珀角标。
 * boxOf 取现有节点的绝对位置（找不到返回 undefined）；needsOf 取现有节点当前的依赖。
 */
export function layoutGhost(edits: WorkflowEdit[], boxOf: (id: string) => Box | undefined, needsOf: (id: string) => string[]): GhostLayout {
  const added: GhostLayout['added'] = []
  const removed: GhostLayout['removed'] = []
  const changed: GhostLayout['changed'] = new Map()
  const links: GhostLink[] = []
  const nextNeeds = new Map<string, string[]>()
  for (const e of edits) {
    if (e.op === 'setNeeds') nextNeeds.set(e.id, e.needs)
    else if (e.op === 'setProp' && e.key === 'needs') nextNeeds.set(e.id, strings(e.value) ?? [])
  }
  const ghostBox = new Map<string, Box>()
  const find = (id: string) => ghostBox.get(id) ?? boxOf(id)
  const touch = (id: string, key: string) => {
    const box = boxOf(id)
    if (!box) return
    const c = changed.get(id) ?? { box, keys: [] }
    if (!c.keys.includes(key)) c.keys.push(key)
    changed.set(id, c)
  }

  edits.forEach((e, i) => {
    if (e.op === 'addNode') {
      const id = literalOf<string>(e.props.id)
      const ups = (strings(e.props.needs) ?? (e.after ? [e.after] : [])).filter((u) => find(u))
      const downs = id ? [...nextNeeds].filter(([, n]) => n.includes(id)).map(([d]) => d).filter((d) => boxOf(d)) : []
      const up = ups.map(find).find(Boolean) ?? (e.after ? find(e.after) : undefined) ?? (e.parent ? boxOf(e.parent) : undefined)
      const down = downs.map(boxOf).find(Boolean)
      const w = up?.w ?? down?.w ?? 220
      const h = Math.max(56, up?.h ?? down?.h ?? 64)
      let box: Box
      if (up && down) {
        const right = Math.max(up.x + up.w, down.x + down.w)
        const top = up.y + up.h
        box = { x: right + GAP, y: down.y >= top ? (top + down.y) / 2 - h / 2 : up.y, w, h }
      } else if (up) box = { x: up.x + up.w + GAP, y: up.y, w, h }
      else if (down) box = { x: down.x - w - GAP, y: down.y, w, h }
      else box = { x: 0, y: -120, w, h }
      while (added.some((a) => overlaps(a.box, box))) box = { ...box, y: box.y + h + STACK }
      if (id) ghostBox.set(id, box)
      added.push({ key: `add-${i}`, id, box, title: literalOf<string>(e.props.title) ?? id ?? '新节点', kind: e.kind })
      ups.forEach((u) => {
        const from = find(u)
        if (from) links.push({ key: `in-${i}-${u}`, tone: 'add', ...connect(from, box) })
      })
      downs.forEach((d) => {
        const to = boxOf(d)
        if (to) links.push({ key: `out-${i}-${d}`, tone: 'add', ...connect(box, to) })
      })
    } else if (e.op === 'removeNode') {
      const box = boxOf(e.id)
      if (box) removed.push({ id: e.id, box })
    } else if (e.op === 'setProp' && e.key !== 'needs') touch(e.id, e.key)
    else if (e.op === 'setNeeds' || e.op === 'setProp') touch(e.id, '依赖')
    else if (e.op === 'moveNode') touch(e.id, '位置')
  })

  // 改依赖：去掉的画红线；新加的、且不是指向新节点的（上面已画）画绿线
  const fresh = new Set(added.map((a) => a.id).filter(Boolean))
  for (const [id, next] of nextNeeds) {
    const to = boxOf(id)
    if (!to) continue
    const before = needsOf(id)
    for (const u of before.filter((u) => !next.includes(u))) {
      const from = boxOf(u)
      if (from) links.push({ key: `del-${u}-${id}`, tone: 'del', ...connect(from, to) })
    }
    for (const u of next.filter((u) => !before.includes(u) && !fresh.has(u))) {
      const from = find(u)
      if (from) links.push({ key: `new-${u}-${id}`, tone: 'add', ...connect(from, to) })
    }
  }
  return { added, removed, changed, links }
}
