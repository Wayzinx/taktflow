/**
 * WorkflowEdit 的纯函数实现：演示数据源按它修改内存里的 EditableWorkflow，
 * 编辑器（pages/workflow/state.ts）用它做乐观更新和撤销（求逆操作）。语义与 server 的 applyEdits 对齐：
 * - addNode 的 id 取 props.id；after 为 undefined 时追加到末尾，null 时插到最前；parent 是 loop 的 id；
 * - removeNode 同时从其他节点的 needs 里去掉它；
 * - moveNode 的 parent 为 undefined 表示留在原容器，null 表示移到顶层。
 */
import type { EditableNode, EditableValue, EditableWorkflow, WorkflowEdit } from '@taktflow/core'

export const lit = (value: unknown): EditableValue => ({ kind: 'literal', value })
export const code = (text: string): EditableValue => ({ kind: 'code', code: text })

/** 字面量的值；代码值或缺省返回 undefined。 */
export function literalOf<T = unknown>(v: EditableValue | undefined): T | undefined {
  return v?.kind === 'literal' ? (v.value as T) : undefined
}

export function needsOf(node: EditableNode): string[] {
  return literalOf<string[]>(node.props.needs) ?? []
}

export interface NodeLocation {
  node: EditableNode
  list: EditableNode[]
  index: number
  /** 所在 loop；顶层为 undefined。 */
  parent?: EditableNode
}

export function findNode(nodes: EditableNode[], id: string, parent?: EditableNode): NodeLocation | undefined {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!
    if (node.id === id) return { node, list: nodes, index: i, parent }
    const inner = node.body && findNode(node.body, id, node)
    if (inner) return inner
  }
  return undefined
}

/** 深度优先遍历全部节点（含 loop 体）。 */
export function allNodes(nodes: EditableNode[]): EditableNode[] {
  return nodes.flatMap((n) => [n, ...(n.body ? allNodes(n.body) : [])])
}

function container(model: EditableWorkflow, parent: string | undefined): EditableNode[] {
  if (!parent) return model.nodes
  const p = findNode(model.nodes, parent)
  if (!p) throw new Error(`父节点 ${parent} 不存在`)
  if (p.node.kind !== 'loop') throw new Error(`${parent} 不是 loop，不能容纳子节点`)
  return (p.node.body ??= [])
}

function insert(list: EditableNode[], node: EditableNode, after: string | null | undefined) {
  if (after === undefined) return void list.push(node)
  if (after === null) return void list.unshift(node)
  const i = list.findIndex((n) => n.id === after)
  if (i < 0) throw new Error(`节点 ${after} 不在同一容器里`)
  list.splice(i + 1, 0, node)
}

/** 保留 needs 键（即使为空），撤销时属性顺序不变。 */
function setNeeds(node: EditableNode, needs: string[]) {
  if (needs.length || node.props.needs) node.props.needs = lit(needs)
}

function applyOne(m: EditableWorkflow, e: WorkflowEdit): void {
  switch (e.op) {
    case 'addNode': {
      const id = literalOf<string>(e.props.id)
      if (!id) throw new Error('addNode 需要字面量 props.id')
      if (findNode(m.nodes, id)) throw new Error(`节点 id ${id} 已存在`)
      insert(container(m, e.parent), { id, kind: e.kind, props: structuredClone(e.props), body: e.kind === 'loop' ? [] : undefined }, e.after)
      return
    }
    case 'removeNode': {
      const loc = findNode(m.nodes, e.id)
      if (!loc) throw new Error(`节点 ${e.id} 不存在`)
      loc.list.splice(loc.index, 1)
      for (const n of allNodes(m.nodes)) if (needsOf(n).includes(e.id)) setNeeds(n, needsOf(n).filter((x) => x !== e.id))
      return
    }
    case 'setProp': {
      const loc = findNode(m.nodes, e.id)
      if (!loc) throw new Error(`节点 ${e.id} 不存在`)
      if (e.key === 'id') {
        const next = literalOf<string>(e.value ?? undefined)
        if (!next) throw new Error('id 必须是非空字符串字面量')
        if (next !== e.id && findNode(m.nodes, next)) throw new Error(`节点 id ${next} 已存在`)
        loc.node.id = next
        for (const n of allNodes(m.nodes)) if (needsOf(n).includes(e.id)) setNeeds(n, needsOf(n).map((x) => (x === e.id ? next : x)))
      }
      if (e.value === null) delete loc.node.props[e.key]
      else loc.node.props[e.key] = structuredClone(e.value)
      return
    }
    case 'setNeeds': {
      const loc = findNode(m.nodes, e.id)
      if (!loc) throw new Error(`节点 ${e.id} 不存在`)
      setNeeds(loc.node, [...e.needs])
      return
    }
    case 'moveNode': {
      const loc = findNode(m.nodes, e.id)
      if (!loc) throw new Error(`节点 ${e.id} 不存在`)
      loc.list.splice(loc.index, 1)
      const target = e.parent === undefined ? loc.list : container(m, e.parent ?? undefined)
      insert(target, loc.node, e.after)
      return
    }
    case 'setStages':
      m.stages = lit(e.stages.map((s) => ({ ...s })))
      return
    case 'setMeta':
      m.meta[e.key] = lit(e.value)
      return
    case 'setMetaValue':
      if (e.value) m.meta[e.key] = e.value
      else delete m.meta[e.key]
      return
  }
}

/** 返回应用编辑后的新模型（不修改入参）；任何一步非法都抛错，整批不生效。 */
export function applyWorkflowEdits(model: EditableWorkflow, edits: WorkflowEdit[]): EditableWorkflow {
  if (!model.editable) throw new Error('该 workflow 不满足可视化编辑的受限子集，只读')
  const m = structuredClone(model)
  for (const e of edits) applyOne(m, e)
  return m
}

function inverseOne(m: EditableWorkflow, e: WorkflowEdit): WorkflowEdit[] {
  switch (e.op) {
    case 'addNode':
      return [{ op: 'removeNode', id: literalOf<string>(e.props.id)! }]
    case 'removeNode': {
      const loc = findNode(m.nodes, e.id)!
      const after = loc.index > 0 ? loc.list[loc.index - 1]!.id : null
      // loop 的循环体不随 addNode 恢复（协议里 addNode 不带 body），撤销删除 loop 时体内节点会丢失
      const restoreNeeds = allNodes(m.nodes)
        .filter((n) => needsOf(n).includes(e.id))
        .map((n): WorkflowEdit => ({ op: 'setNeeds', id: n.id, needs: needsOf(n) }))
      return [{ op: 'addNode', kind: loc.node.kind, props: structuredClone(loc.node.props), after, parent: loc.parent?.id }, ...restoreNeeds]
    }
    case 'setProp': {
      const loc = findNode(m.nodes, e.id)!
      const old = loc.node.props[e.key]
      const id = e.key === 'id' ? literalOf<string>(e.value ?? undefined)! : e.id
      return [{ op: 'setProp', id, key: e.key, value: old ? structuredClone(old) : null }]
    }
    case 'setNeeds':
      return [{ op: 'setNeeds', id: e.id, needs: needsOf(findNode(m.nodes, e.id)!.node) }]
    case 'moveNode': {
      const loc = findNode(m.nodes, e.id)!
      return [{ op: 'moveNode', id: e.id, after: loc.index > 0 ? loc.list[loc.index - 1]!.id : null, parent: loc.parent?.id ?? null }]
    }
    case 'setStages': {
      const old = literalOf<Array<{ id: string; title: string }>>(m.stages)
      return old ? [{ op: 'setStages', stages: old }] : []
    }
    case 'setMeta':
      return [{ op: 'setMeta', key: e.key, value: literalOf<string>(m.meta[e.key]) ?? '' }]
    case 'setMetaValue': {
      const old = m.meta[e.key]
      return [{ op: 'setMetaValue', key: e.key, value: old ? structuredClone(old) : null }]
    }
  }
}

/** 求一批编辑的逆操作（按相反顺序排列），用于撤销；同时校验编辑是否可应用。 */
export function invertWorkflowEdits(model: EditableWorkflow, edits: WorkflowEdit[]): WorkflowEdit[] {
  const m = structuredClone(model)
  const inv: WorkflowEdit[][] = []
  for (const e of edits) {
    inv.push(inverseOne(m, e))
    applyOne(m, e)
  }
  return inv.reverse().flat()
}

/** 编辑直接涉及的节点 id（冲突检测、画布高亮用）。 */
export function touchedNodes(edits: WorkflowEdit[]): string[] {
  const ids = edits.flatMap((e) => ('id' in e ? [e.id] : e.op === 'addNode' ? [literalOf<string>(e.props.id) ?? ''] : []))
  return [...new Set(ids.filter(Boolean))]
}

/** 修订摘要，例如"新增节点 review-prd；修改 spec.prompt"。 */
export function summarizeEdits(edits: WorkflowEdit[]): string {
  const part = (e: WorkflowEdit): string => {
    switch (e.op) {
      case 'addNode': return `新增节点 ${literalOf<string>(e.props.id) ?? ''}`
      case 'removeNode': return `删除节点 ${e.id}`
      case 'setProp': return `修改 ${e.id}.${e.key}`
      case 'setNeeds': return `修改 ${e.id} 的依赖`
      case 'moveNode': return `移动 ${e.id}`
      case 'setStages': return '修改阶段'
      case 'setMeta':
      case 'setMetaValue': return `修改 ${e.key}`
    }
  }
  return [...new Set(edits.map(part))].join('；')
}
