/**
 * workflow 编辑器的共享状态：画布（canvas / palette / properties）和协同（collab）都只通过 useWorkflowDocument 读写。
 * - applyEdits：乐观更新本地模型，再按顺序 PATCH（带 baseRev）；
 * - undo / redo：本地操作栈，存每批编辑及其逆操作，撤销就是把逆操作当作新编辑提交；
 * - 409 进入 conflict 状态，之后排队的写入全部丢弃，等 resolveConflict；
 * - SSE 收到别人的修订（不是自己保存产生的）时重新拉取，并在 remoteChange 里给出变更前后的模型；
 * - 校验诊断按 nodeId 分组（diagnosticsByNode），画布据此在节点上就地标红。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EditableWorkflow, WorkflowChangedEvent, WorkflowConflict, WorkflowDiagnostic, WorkflowDocument, WorkflowEdit, WorkflowLayout } from '@taktflow/core'
import { useSource, WorkflowConflictError } from '../../api'
import { applyWorkflowEdits, invertWorkflowEdits } from '../../api/workflow-edit'

export type SaveStatus = 'loading' | 'saved' | 'saving' | 'conflict' | 'error'

export interface WorkflowConflictState {
  conflict: WorkflowConflict
  /** 被拒绝的本地编辑（基于旧基线）；整文件替换被拒时为空，source 为提交的源码。 */
  edits: WorkflowEdit[]
  source?: string
  reason?: string
}

export interface RemoteChange {
  event: WorkflowChangedEvent
  /** 变更前后的模型（画布据此高亮变化的节点）。 */
  before?: EditableWorkflow
  after?: EditableWorkflow
}

export type ConflictResolution =
  | { kind: 'overwrite' } // 用"你的"版本覆盖最新修订
  | { kind: 'rebase' } // 拉取最新修订，在其上重新应用被拒绝的编辑
  | { kind: 'discard' } // 放弃本地编辑，拉取最新修订
  | { kind: 'source'; source: string } // 提交手工合并后的源码

export interface WorkflowDocState {
  /** 最近一次服务端确认的文档。 */
  doc?: WorkflowDocument
  /** 当前显示的模型：服务端模型 + 尚未确认的乐观编辑。 */
  model?: EditableWorkflow
  layout?: WorkflowLayout
  status: SaveStatus
  error?: Error
  readOnly: boolean
  readOnlyReason?: string
  conflict?: WorkflowConflictState
  remoteChange?: RemoteChange
  canUndo: boolean
  canRedo: boolean
  /** 最近一次写入被服务端确认的时间（ISO）。 */
  savedAt?: string
  /** 已乐观应用、尚未确认的编辑批数。 */
  pendingWrites: number
  /** 带 nodeId 的诊断，按节点分组。 */
  diagnosticsByNode: Record<string, WorkflowDiagnostic[]>
  /** 不属于某个节点的诊断（语法错误、阶段配置等）。 */
  generalDiagnostics: WorkflowDiagnostic[]
  applyEdits(edits: WorkflowEdit[], opts?: { reason?: string }): Promise<boolean>
  undo(): Promise<boolean>
  redo(): Promise<boolean>
  /** 整文件替换。baseRev 传开始编辑时的修订，期间有人改过就走 409；省略时用当前修订。 */
  replaceSource(source: string, reason?: string, baseRev?: string): Promise<boolean>
  rollback(rev: string, reason: string): Promise<boolean>
  /** 拖动位置后调用；600ms 防抖后 PUT layout（不产生修订）。 */
  saveLayout(layout: WorkflowLayout): void
  resolveConflict(r: ConflictResolution): Promise<boolean>
  dismissRemoteChange(): void
  reload(): Promise<void>
}

interface Step {
  edits: WorkflowEdit[]
  inverse: WorkflowEdit[]
}

interface Local {
  doc?: WorkflowDocument
  model?: EditableWorkflow
  layout?: WorkflowLayout
  status: SaveStatus
  error?: Error
  conflict?: WorkflowConflictState
  remoteChange?: RemoteChange
  savedAt?: string
  undo: Step[]
  redo: Step[]
}

/** 当前状态能否提交模型编辑（撤销 / 重做出栈前也要先判断，免得白白丢掉一步）。 */
const writable = (c: Local) => !!c.model?.editable && c.status !== 'conflict'

/** 服务端模型 + 仍在排队的乐观编辑；叠不上（基线变了）时以服务端为准。 */
function withPending(base: EditableWorkflow, pending: WorkflowEdit[][]): EditableWorkflow {
  try {
    return pending.reduce((m, edits) => applyWorkflowEdits(m, edits), base)
  } catch {
    return base
  }
}

function groupDiagnostics(diags: WorkflowDiagnostic[] | undefined) {
  const byNode: Record<string, WorkflowDiagnostic[]> = {}
  const general: WorkflowDiagnostic[] = []
  for (const d of diags ?? []) {
    if (d.nodeId) (byNode[d.nodeId] ??= []).push(d)
    else general.push(d)
  }
  return { byNode, general }
}

export function useWorkflowDocument(id: string): WorkflowDocState {
  const ds = useSource()
  const [s, setS] = useState<Local>({ status: 'loading', undo: [], redo: [] })
  // 写入链需要同步读到最新值，状态同时放一份在 ref 里
  const ref = useRef(s)
  const set = useCallback((patch: Partial<Local> | ((cur: Local) => Partial<Local>)) => {
    const next = { ...ref.current, ...(typeof patch === 'function' ? patch(ref.current) : patch) }
    ref.current = next
    setS(next)
  }, [])
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const pending = useRef<WorkflowEdit[][]>([])
  const blocked = useRef(false)
  const ownRevs = useRef(new Set<string>())
  const layoutTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const enqueue = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const p = queue.current.then(task, task)
    queue.current = p.catch(() => undefined)
    return p
  }, [])

  /** 服务端确认后：模型 = 服务端模型 + 仍在排队的乐观编辑。 */
  const accept = useCallback((doc: WorkflowDocument, extra: Partial<Local> = {}) => {
    ownRevs.current.add(doc.rev)
    set({ doc, model: withPending(doc.model, pending.current), layout: ref.current.layout ?? doc.layout, status: pending.current.length ? 'saving' : 'saved', error: undefined, savedAt: new Date().toISOString(), ...extra })
  }, [set])

  /** 写入失败：丢掉排队的乐观编辑，模型回到服务端版本；没落地的那一步也从操作栈里拿掉。 */
  const fail = useCallback((err: unknown, rejected: Omit<WorkflowConflictState, 'conflict'>, drop?: Step) => {
    pending.current = []
    const doc = ref.current.doc
    const stacks = (c: Local) => (drop ? { undo: c.undo.filter((x) => x !== drop), redo: c.redo.filter((x) => x !== drop) } : {})
    if (err instanceof WorkflowConflictError) {
      blocked.current = true
      set((c) => ({ model: doc?.model, status: 'conflict', conflict: { conflict: err.conflict, ...rejected }, ...stacks(c) }))
    } else {
      set((c) => ({ model: doc?.model, status: 'error', error: err instanceof Error ? err : new Error(String(err)), ...stacks(c) }))
    }
    return false
  }, [set])

  const reload = useCallback(async () => {
    try {
      const doc = await ds.workflow(id)
      pending.current = []
      ownRevs.current.add(doc.rev)
      set({ doc, model: doc.model, layout: doc.layout, status: 'saved', error: undefined })
    } catch (err) {
      set({ status: 'error', error: err as Error })
    }
  }, [ds, id, set])

  useEffect(() => {
    ref.current = { status: 'loading', undo: [], redo: [] }
    setS(ref.current)
    blocked.current = false
    void reload()
    const off = ds.subscribeWorkflow(id, (event) => {
      // 等本地写入落定再判断：自己保存产生的修订不算远端变更
      void queue.current.then(async () => {
        if (ownRevs.current.has(event.revision.rev) || ref.current.doc?.rev === event.revision.rev) return
        const before = ref.current.model
        if (ref.current.status === 'conflict') return set({ remoteChange: { event, before } })
        const doc = await ds.workflow(id).catch(() => undefined)
        if (!doc) return
        ownRevs.current.add(doc.rev)
        // 等待期间又排进来的乐观编辑叠在新基线上，画布不回跳
        set({ doc, model: withPending(doc.model, pending.current), status: pending.current.length ? 'saving' : 'saved', remoteChange: { event, before, after: doc.model } })
      })
    })
    return () => {
      off()
      clearTimeout(layoutTimer.current)
    }
  }, [ds, id, reload, set])

  const submit = useCallback((edits: WorkflowEdit[], record: 'push' | 'undo' | 'redo', reason?: string): Promise<boolean> => {
    const cur = ref.current
    if (!cur.model || !writable(cur) || edits.length === 0) return Promise.resolve(false)
    let step: Step
    let next: EditableWorkflow
    try {
      step = { edits, inverse: invertWorkflowEdits(cur.model, edits) }
      next = applyWorkflowEdits(cur.model, edits)
    } catch (err) {
      set({ error: err as Error })
      return Promise.resolve(false)
    }
    pending.current.push(edits)
    // 撤销产生的 step 是逆操作本身：它的 inverse 就是原编辑，放进 redo；重做反之
    const pushed: Step = record === 'undo' ? { edits: step.inverse, inverse: edits } : step
    set((c) => ({
      model: next,
      status: 'saving',
      error: undefined,
      undo: record === 'undo' ? c.undo : [...c.undo, pushed],
      redo: record === 'push' ? [] : record === 'undo' ? [...c.redo, pushed] : c.redo,
    }))
    return enqueue(async () => {
      if (blocked.current) return false
      try {
        const doc = await ds.editWorkflow(id, { baseRev: ref.current.doc!.rev, edits, reason })
        pending.current.shift()
        accept(doc)
        return true
      } catch (err) {
        return fail(err, { edits, reason }, pushed)
      }
    })
  }, [accept, ds, enqueue, fail, id, set])

  const applyEdits = useCallback((edits: WorkflowEdit[], opts: { reason?: string } = {}) => submit(edits, 'push', opts.reason), [submit])

  const undo = useCallback(() => {
    const last = ref.current.undo[ref.current.undo.length - 1]
    if (!last || !writable(ref.current)) return Promise.resolve(false)
    set((c) => ({ undo: c.undo.slice(0, -1) }))
    return submit(last.inverse, 'undo', '撤销')
  }, [set, submit])

  const redo = useCallback(() => {
    const last = ref.current.redo[ref.current.redo.length - 1]
    if (!last || !writable(ref.current)) return Promise.resolve(false)
    set((c) => ({ redo: c.redo.slice(0, -1) }))
    return submit(last.edits, 'redo', '重做')
  }, [set, submit])

  /** 整文件写入（源码视图、回滚、覆盖冲突）：模型以服务端为准，本地操作栈清空。 */
  const writeSource = useCallback((baseRev: string | undefined, source: string, reason?: string) =>
    enqueue(async () => {
      try {
        const doc = await ds.replaceWorkflowSource(id, { baseRev: baseRev ?? ref.current.doc!.rev, source, reason })
        accept(doc, { undo: [], redo: [] })
        return true
      } catch (err) {
        return fail(err, { edits: [], source, reason })
      }
    }), [accept, ds, enqueue, fail, id])

  const replaceSource = useCallback((source: string, reason?: string, baseRev?: string) => {
    if (ref.current.status === 'conflict') return Promise.resolve(false)
    set({ status: 'saving' })
    return writeSource(baseRev, source, reason)
  }, [set, writeSource])

  const rollback = useCallback((rev: string, reason: string) =>
    enqueue(async () => {
      try {
        set({ status: 'saving' })
        accept(await ds.rollbackWorkflow(id, { rev, reason }), { undo: [], redo: [] })
        return true
      } catch (err) {
        return fail(err, { edits: [], reason })
      }
    }), [accept, ds, enqueue, fail, id, set])

  const resolveConflict = useCallback(async (r: ConflictResolution) => {
    const c = ref.current.conflict
    if (!c) return false
    blocked.current = false
    set({ conflict: undefined, status: 'saving' })
    if (r.kind === 'overwrite' || r.kind === 'source') return writeSource(c.conflict.currentRev, r.kind === 'source' ? r.source : c.conflict.ours, c.reason ?? '解决冲突')
    await reload()
    if (r.kind === 'rebase' && c.edits.length) return applyEdits(c.edits, { reason: c.reason })
    return true
  }, [applyEdits, reload, set, writeSource])

  const saveLayout = useCallback((layout: WorkflowLayout) => {
    set({ layout })
    clearTimeout(layoutTimer.current)
    layoutTimer.current = setTimeout(() => {
      ds.saveWorkflowLayout(id, layout).catch((err: Error) => set({ error: err }))
    }, 600)
  }, [ds, id, set])

  const dismissRemoteChange = useCallback(() => set({ remoteChange: undefined }), [set])

  const diags = useMemo(() => groupDiagnostics(s.doc?.diagnostics), [s.doc?.diagnostics])

  return useMemo(() => {
    const readOnly = !!s.doc && !s.doc.model.editable
    return {
      doc: s.doc,
      model: s.model,
      layout: s.layout,
      status: s.status,
      error: s.error,
      readOnly,
      readOnlyReason: readOnly ? (s.doc!.diagnostics[0]?.message ?? '该 workflow 不满足可视化编辑的受限子集') : undefined,
      conflict: s.conflict,
      remoteChange: s.remoteChange,
      canUndo: !readOnly && s.undo.length > 0 && s.status !== 'conflict',
      canRedo: !readOnly && s.redo.length > 0 && s.status !== 'conflict',
      savedAt: s.savedAt,
      pendingWrites: s.status === 'saving' ? Math.max(1, pending.current.length) : 0,
      diagnosticsByNode: diags.byNode,
      generalDiagnostics: diags.general,
      applyEdits,
      undo,
      redo,
      replaceSource,
      rollback,
      saveLayout,
      resolveConflict,
      dismissRemoteChange,
      reload,
    }
  }, [s, diags, applyEdits, undo, redo, replaceSource, rollback, saveLayout, resolveConflict, dismissRemoteChange, reload])
}
