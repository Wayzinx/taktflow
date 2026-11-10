import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { sha256, withLock } from '@taktflow/core'
import type { Actor, WorkflowChangedEvent, WorkflowConflict, WorkflowDiagnostic, WorkflowDocument, WorkflowEditRequest, WorkflowLayout, WorkflowRevision, WorkflowSourceRequest, WorkflowSummary } from '@taktflow/core'
import { applyEdits, WorkflowSourceError } from './edit.js'
import { assertId, readOptional, writeAtomic } from './files.js'
import { commitWorkflow, mergeSources, sourceDiff } from './git.js'
import { pruneWorkflowLayout, readWorkflowLayout, writeWorkflowLayout } from './layout.js'
import { parseWorkflowSource } from './parse.js'
import { validateWorkflowSource } from './validate.js'

export interface WorkflowStoreOptions {
  dir: string; historyDir: string; gitCommit?: boolean
  /** 包住订阅轮询的写入（修订记录、布局清理）；服务端传受控写入，避免把外部修改记到正在运行的 agent 头上。 */
  guard?: <T>(fn: () => Promise<T>) => Promise<T>
}
export type WorkflowWriteResult = WorkflowDocument | WorkflowConflict | { error: 'validation'; diagnostics: WorkflowDiagnostic[] }
type FileState = { file: string; source: string; id: string; rev: string; mtime: number; stamp?: string }
const external: Actor = { type: 'agent', role: 'unknown', harness: 'external' }

export function createWorkflowStore(options: WorkflowStoreOptions) {
  const dir = resolve(options.dir)
  const historyDir = resolve(options.historyDir)
  const guard = options.guard ?? (<T>(fn: () => Promise<T>) => fn())
  const expected = new Map<string, Actor>()
  const listeners = new Set<(event: WorkflowChangedEvent) => void>()
  const errorListeners = new Set<(error: unknown) => void>()
  let timer: ReturnType<typeof setInterval> | undefined
  let polling = false
  const watched = new Map<string, FileState>()
  const reportError = (error: unknown) => {
    if (!errorListeners.size) console.error('workflow watch 失败：', error)
    for (const listener of errorListeners) listener(error)
  }
  // 每个 workflow 最近一次通知过的修订：同一修订只通知一次（本实例保存时已发，轮询再看到就不重发）
  const announced = new Map<string, string>()
  const emit = (event: WorkflowChangedEvent) => {
    announced.set(event.workflowId, event.revision.rev)
    for (const listener of listeners) { try { listener(event) } catch (error) { reportError(error) } }
  }
  function state(file: string, source: string, mtime: number, stamp?: string): FileState {
    const id = parseWorkflowSource(source, file).model.meta.id || basename(file, '.workflow.ts')
    assertId(id)
    return { file, source, id, rev: sha256(source), mtime, stamp }
  }
  async function files(cache?: Map<string, FileState>): Promise<FileState[]> {
    let names: string[]
    try { names = await readdir(dir) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const result = await Promise.all(names.filter((name) => name.endsWith('.workflow.ts')).sort().map(async (name) => {
      const file = join(dir, name)
      const metadata = await stat(file)
      const stamp = `${metadata.mtimeMs}:${metadata.ctimeMs}:${metadata.size}`
      const cached = cache?.get(file)
      if (cached?.stamp === stamp) return cached
      return state(file, await readFile(file, 'utf8'), metadata.mtimeMs, stamp)
    }))
    const ids = new Set<string>()
    for (const file of result) {
      if (ids.has(file.id)) throw new Error(`workflow id 重复：${file.id}`)
      ids.add(file.id)
    }
    return result
  }
  async function locate(id: string): Promise<FileState> {
    assertId(id)
    const file = (await files()).find((item) => item.id === id)
    if (!file) throw new Error(`workflow 不存在：${id}`)
    return file
  }
  async function revisions(id: string): Promise<WorkflowRevision[]> {
    assertId(id)
    const text = await readOptional(join(historyDir, id, 'log.jsonl'))
    return (text ?? '').split('\n').filter(Boolean).map((line) => JSON.parse(line) as WorkflowRevision)
  }
  async function record(file: FileState, author: Actor, reason?: string, summary?: string, notify = true): Promise<WorkflowRevision | undefined> {
    const previous = (await revisions(file.id)).at(-1)
    if (previous?.rev === file.rev) return undefined
    const revision: WorkflowRevision = { rev: file.rev, parent: previous?.rev, author, reason, summary, at: new Date(previous ? Date.now() : file.mtime).toISOString() }
    const directory = join(historyDir, file.id)
    await mkdir(directory, { recursive: true })
    await writeAtomic(join(directory, `${file.rev}.ts`), file.source)
    await appendFile(join(directory, 'log.jsonl'), JSON.stringify(revision) + '\n')
    if (notify) emit({ workflowId: file.id, revision })
    return revision
  }
  async function observe(file: FileState, notify = true): Promise<void> {
    const previous = (await revisions(file.id)).at(-1)
    if (previous?.rev === file.rev) return
    const author = previous ? expected.get(file.id) ?? external : { type: 'system' as const, id: 'workflow-source' }
    await record(file, author, previous ? '外部修改' : '记录初始源码', previous ? '外部修改源码' : '初始修订', notify && !!previous)
    if (previous) expected.delete(file.id)
  }
  async function document(file: FileState): Promise<WorkflowDocument> {
    const parsed = parseWorkflowSource(file.source, file.file)
    const validation = await validateWorkflowSource(file.file)
    return {
      id: file.id, file: relative(dirname(dir), file.file), source: file.source, rev: file.rev, model: parsed.model,
      layout: await readWorkflowLayout(dir, file.id), snapshot: validation.snapshot,
      diagnostics: [...parsed.diagnostics, ...validation.diagnostics],
    }
  }
  async function get(id: string, options: { record?: boolean } = {}): Promise<WorkflowDocument> {
    return withLock(dir, async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const file = await locate(id)
        if (options.record !== false) await observe(file)
        const result = await document(file)
        if (sha256(await readFile(file.file, 'utf8')) === file.rev) return result
      }
      throw new Error('workflow 在读取期间持续变化，请重试')
    })
  }
  async function list(options: { record?: boolean } = {}): Promise<WorkflowSummary[]> {
    return withLock(dir, async () => {
      const entries = await files()
      const summaries: WorkflowSummary[] = []
      for (const file of entries) {
        // 编辑列表保留源码用于三方合并；修订查询只读。
        if (options.record !== false) await observe(file)
        const { model, spans } = parseWorkflowSource(file.source, file.file)
        summaries.push({ id: file.id, title: model.meta.title.kind === 'literal' && typeof model.meta.title.value === 'string' ? model.meta.title.value : file.id,
          file: relative(dirname(dir), file.file), rev: file.rev, editable: model.editable, updatedAt: new Date(file.mtime).toISOString(), nodes: spans.byId.size, runs: 0 })
      }
      return summaries
    })
  }
  async function revision(id: string, rev: string): Promise<{ revision: WorkflowRevision; source: string; diff: string }> {
    assertId(id)
    if (!/^[a-f0-9]{64}$/.test(rev)) throw new Error('非法修订 sha256')
    const record = (await revisions(id)).reverse().find((item) => item.rev === rev)
    if (!record) {
      const current = await locate(id)
      if (current.rev !== rev) throw new Error(`修订不存在：${id}@${rev}`)
      return { revision: { rev, at: new Date(current.mtime).toISOString(), author: { type: 'system', id: 'workflow-source' }, reason: '记录初始源码', summary: '初始修订' }, source: current.source, diff: '' }
    }
    const source = await readFile(join(historyDir, id, `${rev}.ts`), 'utf8')
    const base = record.parent ? await readFile(join(historyDir, id, `${record.parent}.ts`), 'utf8') : ''
    return { revision: record, source, diff: await sourceDiff(base, source) }
  }
  async function save(id: string, request: (WorkflowEditRequest | WorkflowSourceRequest) & { author: Actor }): Promise<WorkflowWriteResult> {
    return withLock(dir, async () => {
      let current = await locate(id)
      await observe(current)
      const base = request.baseRev === current.rev ? current.source : (await revision(id, request.baseRev)).source
      let proposed: string
      let summary = '替换源码'
      let warnings: WorkflowDiagnostic[] = []
      try {
        if ('edits' in request) {
          const result = applyEdits(base, request.edits)
          proposed = result.source; summary = result.summary; warnings = result.diagnostics
        } else proposed = request.source
      } catch (error) {
        if (error instanceof WorkflowSourceError) return { error: 'validation', diagnostics: error.diagnostics }
        throw error
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        let candidate = proposed
        if (current.rev !== request.baseRev) {
          const merged = await mergeSources(base, current.source, proposed)
          if (merged.conflict) return { error: 'conflict', base, ours: current.source, theirs: proposed, merged: merged.source, currentRev: current.rev }
          candidate = merged.source
        }
        const parsed = parseWorkflowSource(candidate, current.file)
        const diagnostics = [...parsed.diagnostics, ...warnings]
        const candidateId = parsed.model.meta.id || basename(current.file, '.workflow.ts')
        if (candidateId !== id) diagnostics.push({ severity: 'error', message: '替换源码不能更改 workflow id，请另建文件' })
        if (diagnostics.some((d) => d.severity === 'error')) return { error: 'validation', diagnostics }
        // 放在原文件同目录，保留相对 import 和包解析上下文；不覆盖正在运行的原文件。
        const temp = join(dirname(current.file), `.workflow-validation-${randomUUID()}.mts`)
        let validation
        try {
          await writeFile(temp, candidate, { flag: 'wx' })
          validation = await validateWorkflowSource(temp)
        } finally { await rm(temp, { force: true }) }
        diagnostics.push(...validation.diagnostics)
        if (diagnostics.some((d) => d.severity === 'error')) return { error: 'validation', diagnostics }
        const latest = await readFile(current.file, 'utf8')
        if (sha256(latest) !== current.rev) {
          current = state(current.file, latest, (await stat(current.file)).mtimeMs)
          await observe(current)
          continue
        }
        const layout = pruneWorkflowLayout(await readWorkflowLayout(dir, id), parsed.spans.byId.keys())
        if (candidate !== current.source) {
          await writeAtomic(current.file, candidate)
          await writeWorkflowLayout(dir, id, layout)
          const saved = state(current.file, candidate, (await stat(current.file)).mtimeMs)
          await record(saved, request.author, request.reason, summary)
          if (options.gitCommit) await commitWorkflow(current.file, request.author, request.reason ?? summary)
        }
        return { id, file: relative(dirname(dir), current.file), source: candidate, rev: sha256(candidate), model: parsed.model, layout, snapshot: validation.snapshot, diagnostics }
      }
      throw new Error('workflow 持续被外部修改，请基于最新修订重试')
    })
  }
  function watch(onChange: (event: WorkflowChangedEvent) => void, onError?: (error: unknown) => void): () => Promise<void> {
    listeners.add(onChange)
    if (onError) errorListeners.add(onError)
    if (!timer) {
      // 同步捕获订阅时的基线，避免首次异步扫描吞掉紧随 watch 的写入。
      let baseline: FileState[] = []
      try {
        baseline = readdirSync(dir).filter((name) => name.endsWith('.workflow.ts')).map((name) => {
          const file = join(dir, name)
          const metadata = statSync(file)
          return state(file, readFileSync(file, 'utf8'), metadata.mtimeMs, `${metadata.mtimeMs}:${metadata.ctimeMs}:${metadata.size}`)
        })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') reportError(error)
      }
      void guard(() => withLock(dir, async () => {
        for (const file of baseline) { await observe(file, false); watched.set(file.file, file) }
      })).catch(reportError)
      timer = setInterval(() => {
        if (polling) return
        polling = true
        void (async () => {
          // 先不加锁比对；有变化才进受控写入，agent 运行时不必每秒扫一遍修订目录
          if ((await files(watched)).every((file) => watched.get(file.file) === file)) return
          await guard(() => withLock(dir, async () => {
            for (const file of await files(watched)) {
              if (watched.get(file.file) === file) continue
              const previous = (await revisions(file.id)).at(-1)
              if (previous?.rev === file.rev) {
                const before = watched.get(file.file)
                watched.set(file.file, file)
                // 修订已由同目录的另一个 store 实例记下（管家执行提案、CLI、另一个服务进程）：本实例的订阅者同样要收到
                if (previous && before && before.rev !== file.rev && announced.get(file.id) !== file.rev) emit({ workflowId: file.id, revision: previous })
                continue
              }
              const parsed = parseWorkflowSource(file.source, file.file)
              await validateWorkflowSource(file.file)
              if (parsed.model.editable) {
                const layout = await readWorkflowLayout(dir, file.id)
                const cleaned = pruneWorkflowLayout(layout, parsed.spans.byId.keys())
                if (JSON.stringify(layout) !== JSON.stringify(cleaned)) await writeWorkflowLayout(dir, file.id, cleaned)
              }
              const author = expected.get(file.id) ?? external
              await record(file, author, '外部修改', '外部修改源码')
              expected.delete(file.id)
              watched.set(file.file, file)
            }
          }))
        })().catch(reportError).finally(() => { polling = false })
      }, 1000)
      timer.unref()
    }
    return async () => {
      listeners.delete(onChange)
      if (onError) errorListeners.delete(onError)
      if (!listeners.size && timer) { clearInterval(timer); timer = undefined }
      await withLock(dir, async () => { if (!listeners.size) watched.clear() })
    }
  }
  return {
    list, get, revisions, revision, watch,
    edit: (id: string, request: WorkflowEditRequest & { author: Actor }) => save(id, request),
    replaceSource: (id: string, request: WorkflowSourceRequest & { author: Actor }) => save(id, request),
    rollback: async (id: string, rev: string, author: Actor, reason?: string) => {
      const target = await revision(id, rev)
      const current = await get(id, { record: false })
      if (current.rev === rev) return current
      return save(id, { baseRev: current.rev, source: target.source, reason, author })
    },
    getLayout: async (id: string) => { await locate(id); return readWorkflowLayout(dir, id) },
    setLayout: (id: string, layout: WorkflowLayout) => withLock(dir, async () => { await locate(id); return writeWorkflowLayout(dir, id, layout) }),
    expectExternalChange: (id: string, actor: Actor) => { assertId(id); expected.set(id, actor) },
  }
}

export type WorkflowStore = ReturnType<typeof createWorkflowStore>
