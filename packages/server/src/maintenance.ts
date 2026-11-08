import { syncQuality, tickAttention, type AttentionItem, type ProjectStores } from '@taktflow/core'

/** 同步和限时交还分别按空间串行；恢复长运行时，事件入账仍可推进。关闭时等待落盘。 */
export function startMaintenance(spaces: () => ProjectStores[], onAnswer?: (stores: ProjectStores, item: AttentionItem) => Promise<void> | void,
  onError: (error: unknown) => void = error => { process.stderr.write(`质量与待办维护失败：${String(error)}\n`) }) {
  const queues = new Map<string, Promise<void>>(), tickQueues = new Map<string, Promise<void>>()
  const subscriptions = new Map<string, { dir: string; stop: () => void }>()
  const syncing = new Set<string>()
  let closed = false, discovering: Promise<void> | undefined
  const enqueue = (stores: ProjectStores, work: () => Promise<void>, queue = queues) => {
    const previous = queue.get(stores.projectDir) ?? Promise.resolve()
    const next = previous.then(work).catch(onError)
    queue.set(stores.projectDir, next)
    return next
  }
  const sync = (stores: ProjectStores, runId: string) => {
    const key = `${stores.projectDir}:${runId}`
    if (closed || syncing.has(key)) return
    syncing.add(key)
    void enqueue(stores, async () => {
      // 在执行前解除合并标记，执行期间的新事件可排下一次同步，避免丢尾部。
      syncing.delete(key)
      await syncQuality(stores, runId)
    })
  }
  const discover = async () => {
    const current = spaces(), dirs = new Set(current.map(s => s.projectDir))
    for (const [key, sub] of subscriptions) if (!dirs.has(sub.dir)) { sub.stop(); subscriptions.delete(key) }
    for (const stores of current) for (const state of await stores.runs.list()) {
      if (closed) return
      const key = `${stores.projectDir}:${state.runId}`
      if (subscriptions.has(key)) continue
      subscriptions.set(key, { dir: stores.projectDir, stop: stores.events.subscribe(state.runId, () => sync(stores, state.runId)) })
      sync(stores, state.runId)
    }
  }
  const scan = () => {
    if (closed || discovering) return
    discovering = discover().catch(onError).finally(() => { discovering = undefined })
  }
  const tick = async () => {
    await Promise.all(spaces().map(stores => enqueue(stores, async () => {
      const result = await tickAttention(stores)
      for (const runId of result.resume) {
        const item = (await stores.attention.list()).find(item => item.runId === runId && item.handedBack)
        if (item) await onAnswer?.(stores, item)
      }
    }, tickQueues)))
  }
  scan()
  const scanner = setInterval(scan, 1000), timer = setInterval(() => { void tick() }, 60_000)
  scanner.unref(); timer.unref()
  return { tick, async close() {
    closed = true; clearInterval(scanner); clearInterval(timer)
    await discovering
    for (const sub of subscriptions.values()) sub.stop()
    await Promise.all([...queues.values(), ...tickQueues.values()])
  } }
}
