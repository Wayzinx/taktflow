import { syncObservations, type ProjectStores } from '@taktflow/core'
import type { WriteLease } from './api-core.js'

/** 订阅已有运行；轮询只负责发现新运行与重试，游标始终以质量日志为准。 */
export async function watchQualityEvents(stores: ProjectStores, options: {
  withWriteLease: WriteLease
  onError: (error: unknown, runId?: string) => void
  pollMs?: number
}): Promise<() => Promise<void>> {
  const subscriptions = new Map<string, () => void>()
  const dirty = new Set<string>()
  let stopped = false
  let pending: Promise<void> | undefined
  const flush = async () => {
    for (const runId of [...dirty]) {
      if (stopped) return
      dirty.delete(runId)
      try { await options.withWriteLease(stores, () => syncObservations(stores, runId)) }
      catch (error) { dirty.add(runId); options.onError(error, runId) }
    }
  }
  const scan = async () => {
    for (const run of await stores.runs.list()) {
      if (stopped) return
      if (subscriptions.has(run.runId)) continue
      subscriptions.set(run.runId, stores.events.subscribe(run.runId, () => { dirty.add(run.runId); schedule(false) }))
      dirty.add(run.runId)
    }
  }
  const schedule = (discover: boolean) => {
    if (stopped || pending) return
    pending = (async () => { if (discover) await scan(); await flush() })()
      .catch((error: unknown) => options.onError(error)).finally(() => { pending = undefined })
  }
  await scan()
  schedule(false)
  const timer = setInterval(() => schedule(true), options.pollMs ?? 250)
  timer.unref()
  return async () => {
    stopped = true
    clearInterval(timer)
    for (const stop of subscriptions.values()) stop()
    subscriptions.clear()
    await pending
  }
}
