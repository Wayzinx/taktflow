import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { sha256, withLock, type ProjectStores, type WorkflowChangedEvent } from '@taktflow/core'
import { parseWorkflowSource, pruneWorkflowLayout, type WorkflowStore } from '@taktflow/workflow-source'
import type { WriteLease } from './api-core.js'
import { workflowStore } from './space.js'

/** workflow-source 的 get/list 会登记外部修订；只有确实需要登记时才获取写租约。 */
export function workflowAccess(stores: ProjectStores, withWriteLease: WriteLease): WorkflowStore {
  const store = workflowStore(stores)
  const observed = new Map<string, string>()
  const access = <T>(fn: () => Promise<T>): Promise<T> => withLock(`${stores.paths.workflows}:access`, async () => {
    let dirty = false
    const names = await readdir(stores.paths.workflows).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    for (const name of names.filter((name) => name.endsWith('.workflow.ts'))) {
      const file = join(stores.paths.workflows, name)
      const source = await readFile(file, 'utf8')
      const id = parseWorkflowSource(source, file).model.meta.id || name.slice(0, -'.workflow.ts'.length)
      if ((await store.revisions(id)).at(-1)?.rev !== sha256(source)) { dirty = true; break }
    }
    return dirty ? withWriteLease(stores, fn) : fn()
  })
  const get: WorkflowStore['get'] = (id) => access(async () => {
    const document = await store.get(id)
    observed.set(id, document.rev)
    return document
  })
  const list: WorkflowStore['list'] = () => access(async () => {
    const entries = await store.list()
    for (const entry of entries) observed.set(entry.id, entry.rev)
    return entries
  })
  // 不启动原 store 的无租约后台写入；轮询保留外部修订通知和布局清理。
  const watch: WorkflowStore['watch'] = (receive, onError) => {
    const previous = new Map(observed)
    let stopped = false
    let pending: Promise<void> | undefined
    const poll = async () => {
      for (const entry of await list()) {
        if (previous.get(entry.id) === entry.rev) continue
        const revision = (await store.revisions(entry.id)).at(-1)!
        if (revision.author.type === 'agent' && revision.author.harness === 'external') {
          await withWriteLease(stores, async () => {
            const document = await store.get(entry.id)
            const parsed = parseWorkflowSource(document.source, document.file)
            if (!parsed.model.editable) return
            const cleaned = pruneWorkflowLayout(document.layout, parsed.spans.byId.keys())
            if (JSON.stringify(cleaned) !== JSON.stringify(document.layout)) await store.setLayout(entry.id, cleaned)
          })
        }
        previous.set(entry.id, entry.rev)
        if (!stopped) receive({ workflowId: entry.id, revision } satisfies WorkflowChangedEvent)
      }
    }
    const timer = setInterval(() => {
      if (pending) return
      pending = poll().catch((error: unknown) => {
        // 其它执行者占用时保留游标，下次轮询重试，SSE 不因此断开。
        if (error && typeof error === 'object' && 'status' in error && error.status === 409) return
        onError?.(error)
      }).finally(() => { pending = undefined })
    }, 1000)
    timer.unref()
    return async () => { stopped = true; clearInterval(timer); await pending }
  }
  return { ...store, get, list, watch }
}
