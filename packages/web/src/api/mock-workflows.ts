/**
 * workflow 协同编辑演示数据源：内存里维护每个 workflow 的 EditableWorkflow、源码、修订历史和画布坐标。
 * PATCH 按 WorkflowEdit 修改模型并重新打印源码；baseRev 过期时，若改动的节点在对方修订里没动过就自动合并，否则 409。
 * 第一次订阅 sdlc 的变更流后，约 9 秒时模拟一次"Lead 修改了 workflow"。
 */
import type { Actor, EditableWorkflow, WorkflowChangedEvent, WorkflowDiagnostic, WorkflowDocument, WorkflowEdit, WorkflowLayout, WorkflowRevision, WorkflowSummary } from '@taktflow/core'
import { conflictText, hashSource, printWorkflow, snapshotOf, unifiedDiff, validateWorkflow } from './mock-workflow-print'
import { workflowSeeds, type WorkflowSeed } from './mock-workflow-seed'
import { WorkflowConflictError, type DataSource } from './source'
import { allNodes, applyWorkflowEdits, findNode, literalOf, summarizeEdits, touchedNodes } from './workflow-edit'

export type WorkflowApi = Pick<DataSource, 'workflows' | 'workflow' | 'editWorkflow' | 'replaceWorkflowSource' | 'saveWorkflowLayout' | 'workflowRevisions' | 'workflowRevision' | 'rollbackWorkflow' | 'subscribeWorkflow'>

const MIN = 60_000
const ago = (min: number) => new Date(Date.now() - min * MIN).toISOString()
const clone = <T,>(v: T): T => structuredClone(v)
const delay = <T,>(v: T, ms = 90): Promise<T> => new Promise((r) => setTimeout(() => r(clone(v)), ms))
const fail = (msg: string) => Promise.reject(new Error(msg))
const ME: Actor = { type: 'human', id: 'web' }
const LEAD: Actor = { type: 'agent', role: 'lead', harness: 'claude-code', model: 'sonnet' }

interface Revision {
  meta: WorkflowRevision
  source: string
  model: EditableWorkflow
}

interface Entry {
  id: string
  seed: WorkflowSeed
  model: EditableWorkflow
  source: string
  diagnostics: WorkflowDiagnostic[]
  revs: Revision[]
  layout: WorkflowLayout
  subs: Set<(e: WorkflowChangedEvent) => void>
  scripted: boolean
}

function render(seed: WorkflowSeed, model: EditableWorkflow): { source: string; diagnostics: WorkflowDiagnostic[] } {
  if (!model.editable) return { source: seed.source ?? '', diagnostics: seed.diagnostics ?? [] }
  const { source, lines } = printWorkflow(model, seed.preamble)
  return { source, diagnostics: validateWorkflow(model, lines) }
}

/** 初始坐标：按阶段分列，列内按出现顺序排；loop 体内节点跟随 loop 所在列。 */
function autoLayout(model: EditableWorkflow): WorkflowLayout {
  const stages = (literalOf<Array<{ id: string }>>(model.stages) ?? []).map((s) => s.id)
  const rows = new Map<number, number>()
  const nodes: WorkflowLayout['nodes'] = {}
  const place = (list: EditableWorkflow['nodes'], inherited?: string) => {
    for (const n of list) {
      const col = Math.max(0, stages.indexOf(literalOf<string>(n.props.stage) ?? inherited ?? ''))
      const row = rows.get(col) ?? 0
      rows.set(col, row + 1)
      nodes[n.id] = { x: 40 + col * 280, y: 60 + row * 120 }
      if (n.body) place(n.body, literalOf<string>(n.props.stage) ?? inherited)
    }
  }
  place(model.nodes)
  return { nodes, viewport: { x: 0, y: 0, zoom: 0.8 } }
}

/** sdlc 的历史：从模板创建（无脚本评审、PRD 评审 2 轮）→ 改成 3 轮 → Lead 新增脚本评审 = 当前版本。 */
function history(id: string, seed: WorkflowSeed): Array<{ model: EditableWorkflow; author: Actor; reason: string; summary: string; ageMin: number }> {
  const head = { model: seed.model, author: ME, reason: '初始版本', summary: '创建 workflow', ageMin: seed.ageMin }
  if (id !== 'sdlc') return [head]
  const m1 = applyWorkflowEdits(seed.model, [{ op: 'removeNode', id: 'review-scripts' }])
  const m0 = applyWorkflowEdits(m1, [{ op: 'setProp', id: 'review-prd', key: 'maxRounds', value: { kind: 'literal', value: 2 } }])
  return [
    { model: m0, author: { type: 'human', id: 'wayne' }, reason: '从模板 taktflow-standard 创建', summary: '创建 workflow', ageMin: seed.ageMin + 3 * 24 * 60 },
    { model: m1, author: { type: 'human', id: 'lin' }, reason: 'PRD 两轮经常不够，放宽到三轮', summary: '修改 review-prd.maxRounds', ageMin: seed.ageMin + 26 * 60 },
    { model: seed.model, author: LEAD, reason: '自动化脚本也要经测分评审，防止弱化断言（群聊里 wayne 的要求）', summary: '新增节点 review-scripts；修改 dev-test-loop 的依赖', ageMin: seed.ageMin },
  ]
}

export function createMockWorkflows(seeded: boolean): WorkflowApi {
  const entries = new Map<string, Entry>()
  if (seeded) {
    for (const [id, seed] of Object.entries(workflowSeeds())) {
      const revs: Revision[] = []
      for (const h of history(id, seed)) {
        const { source } = render(seed, h.model)
        revs.push({ source, model: h.model, meta: { rev: hashSource(source), parent: revs[revs.length - 1]?.meta.rev, author: h.author, reason: h.reason, summary: h.summary, at: ago(h.ageMin) } })
      }
      const last = revs[revs.length - 1]!
      entries.set(id, { id, seed, model: clone(last.model), ...render(seed, last.model), revs, layout: autoLayout(last.model), subs: new Set(), scripted: false })
    }
  }

  const get = (id: string) => entries.get(id)
  const head = (e: Entry) => e.revs[e.revs.length - 1]!
  const doc = (e: Entry): WorkflowDocument => ({ id: e.id, file: e.seed.file, source: e.source, rev: head(e).meta.rev, model: e.model, layout: e.layout, snapshot: e.model.editable ? snapshotOf(e.model, e.diagnostics) : undefined, diagnostics: e.diagnostics })
  const summary = (e: Entry): WorkflowSummary => ({ id: e.id, title: literalOf<string>(e.model.meta.title) ?? e.id, file: e.seed.file, rev: head(e).meta.rev, editable: e.model.editable, updatedAt: head(e).meta.at, nodes: allNodes(e.model.nodes).length, runs: e.seed.runs })

  function commit(e: Entry, model: EditableWorkflow, author: Actor, reason: string | undefined, summaryText: string, source?: string) {
    const r = render(e.seed, model)
    e.model = clone(model)
    e.source = source ?? r.source
    e.diagnostics = source !== undefined && source !== r.source ? [...r.diagnostics, { severity: 'warning', message: '演示数据不解析手写源码：画布仍显示上一版模型。' }] : r.diagnostics
    for (const n of allNodes(model.nodes)) e.layout.nodes[n.id] ??= { x: 40, y: 40 }
    const meta: WorkflowRevision = { rev: hashSource(e.source + e.revs.length), parent: head(e).meta.rev, author, reason, summary: summaryText, at: new Date().toISOString() }
    e.revs.push({ meta, source: e.source, model: clone(model) })
    const event: WorkflowChangedEvent = { workflowId: e.id, revision: meta }
    e.subs.forEach((f) => f(clone(event)))
  }

  const conflict = (e: Entry, base: Revision, ours: string): never => {
    throw new WorkflowConflictError({ error: 'conflict', base: base.source, ours, theirs: e.source, merged: conflictText(ours, e.source), currentRev: head(e).meta.rev })
  }

  function edit(e: Entry, baseRev: string, edits: WorkflowEdit[], reason?: string): WorkflowDocument {
    if (!e.model.editable) throw new Error('该 workflow 不满足受限子集，只读')
    if (baseRev !== head(e).meta.rev) {
      const base = e.revs.find((r) => r.meta.rev === baseRev)
      if (!base) throw new Error(`修订 ${baseRev.slice(0, 8)} 不存在`)
      // 自动合并：本次改动涉及的节点在对方修订里都没变过；阶段和元信息的改动一律算冲突
      const same = (id: string) => JSON.stringify(findNode(base.model.nodes, id)?.node) === JSON.stringify(findNode(e.model.nodes, id)?.node)
      const clean = edits.every((x) => x.op !== 'setStages' && x.op !== 'setMeta') && touchedNodes(edits).every(same)
      if (!clean) {
        let ours = base.source
        try {
          ours = render(e.seed, applyWorkflowEdits(base.model, edits)).source
        } catch {
          // 编辑在基线上都不成立（例如改的是对方新增的节点）：按基线原文给出"你的"一侧
        }
        conflict(e, base, ours)
      }
    }
    commit(e, applyWorkflowEdits(e.model, edits), ME, reason, summarizeEdits(edits))
    return doc(e)
  }

  /** Lead 修改：给系分评审加一位安全评审者，并收紧影响面评估的 prompt。 */
  function scriptAgentEdit(e: Entry) {
    const rd = findNode(e.model.nodes, 'review-design')
    const im = findNode(e.model.nodes, 'impact')
    if (!rd || !im) return
    const reviewers = [...(literalOf<unknown[]>(rd.node.props.reviewers) ?? []), { role: 'security', focus: '鉴权、敏感数据与审计' }]
    const edits: WorkflowEdit[] = [
      { op: 'setProp', id: 'review-design', key: 'reviewers', value: { kind: 'literal', value: reviewers } },
      { op: 'setProp', id: 'impact', key: 'prompt', value: { kind: 'literal', value: '评估改动影响：列出受影响的存量功能、回归范围、未覆盖风险，并标注每项的证据（调用链或用例）。' } },
    ]
    commit(e, applyWorkflowEdits(e.model, edits), LEAD, '群聊里 lin 要求：涉及导出和鉴权的需求，系分评审要有安全视角', summarizeEdits(edits))
  }

  return {
    workflows: () => delay([...entries.values()].map(summary)),
    workflow: (id) => {
      const e = get(id)
      return e ? delay(doc(e), 120) : fail(`workflow ${id} 不存在`)
    },
    editWorkflow: (id, body) => {
      const e = get(id)
      if (!e) return fail(`workflow ${id} 不存在`)
      try {
        return delay(edit(e, body.baseRev, body.edits, body.reason), 180)
      } catch (err) {
        return new Promise((_, rej) => setTimeout(() => rej(err), 180))
      }
    },
    replaceWorkflowSource: (id, body) => {
      const e = get(id)
      if (!e) return fail(`workflow ${id} 不存在`)
      const base = e.revs.find((r) => r.meta.rev === body.baseRev)
      if (!base) return fail(`修订 ${body.baseRev.slice(0, 8)} 不存在`)
      if (base !== head(e)) {
        try {
          conflict(e, base, body.source)
        } catch (err) {
          return Promise.reject(err)
        }
      }
      // 源码与某个历史修订一致时恢复它的模型（覆盖冲突、粘贴旧版本都走这里）
      const known = [...e.revs].reverse().find((r) => r.source === body.source)
      commit(e, known?.model ?? e.model, ME, body.reason, '整文件编辑', body.source)
      return delay(doc(e), 220)
    },
    saveWorkflowLayout: (id, layout) => {
      const e = get(id)
      if (!e) return fail(`workflow ${id} 不存在`)
      e.layout = clone(layout)
      return delay(e.layout, 60)
    },
    workflowRevisions: (id) => {
      const e = get(id)
      return e ? delay([...e.revs].reverse().map((r) => r.meta)) : fail(`workflow ${id} 不存在`)
    },
    workflowRevision: (id, rev) => {
      const e = get(id)
      const i = e?.revs.findIndex((r) => r.meta.rev === rev) ?? -1
      if (!e || i < 0) return fail(`修订 ${rev.slice(0, 8)} 不存在`)
      const r = e.revs[i]!
      return delay({ revision: r.meta, source: r.source, diff: i > 0 ? unifiedDiff(e.revs[i - 1]!.source, r.source, e.seed.file) : '' })
    },
    rollbackWorkflow: (id, body) => {
      const e = get(id)
      const r = e?.revs.find((x) => x.meta.rev === body.rev)
      if (!e || !r) return fail(`修订 ${body.rev.slice(0, 8)} 不存在`)
      if (!body.reason.trim()) return fail('回滚原因必填')
      commit(e, r.model, ME, body.reason, `回滚到 ${body.rev.slice(0, 8)}`)
      return delay(doc(e), 200)
    },
    subscribeWorkflow: (id, on) => {
      const e = get(id)
      if (!e) return () => {}
      e.subs.add(on)
      if (id === 'sdlc' && !e.scripted) {
        e.scripted = true
        setTimeout(() => scriptAgentEdit(e), 9000)
      }
      return () => e.subs.delete(on)
    },
  }
}
