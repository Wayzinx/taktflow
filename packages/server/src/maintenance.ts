import { expireTaskReceipts, recoverTaskReceipts, syncQuality, tickAttention, type AttentionItem, type ProjectStores } from '@taktflow/core'

/** 同步、回执和限时交还分别按空间串行；恢复长运行时，事件入账和回执过期仍可推进。关闭时等待落盘。 */
export function startMaintenance(spaces: () => ProjectStores[], onAnswer?: (stores: ProjectStores, item: AttentionItem) => Promise<void> | void,
  onError: (error: unknown) => void = error => { process.stderr.write(`质量、待办与回执维护失败：${String(error)}；请检查空间文件与写入权限后重试\n`) }) {
  const queues = new Map<string, Promise<void>>(), tickQueues = new Map<string, Promise<void>>(), receiptQueues = new Map<string, Promise<void>>()
  const subscriptions = new Map<string, { dir: string; stop: () => void; seq: number; finished: boolean }>()
  const completed = new Map<string, string>()
  const ended = (status: string) => status === 'succeeded' || status === 'failed' || status === 'cancelled'
  const syncing = new Set<string>()
  const recovered = new Map<string, Promise<void>>()
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
      // 引擎先保存终态再写结束事件；已订阅运行必须等结束事件落盘后才取消。
      const state = await stores.runs.get(runId)
      const sub = subscriptions.get(key)
      if (state && ended(state.status) && sub && !sub.finished) {
        const events = await stores.events.read(runId, { afterSeq: sub.seq })
        sub.finished ||= events.some(event => event.type === 'run.finished' && ended((event.data as { status: string }).status))
        sub.seq = events.reduce((seq, event) => Math.max(seq, event.seq), sub.seq)
      }
      const finalSync = state && ended(state.status) && (!sub || sub.finished)
      await syncQuality(stores, runId)
      if (finalSync) {
        completed.set(key, stores.projectDir)
        subscriptions.get(key)?.stop()
        subscriptions.delete(key)
      }
    })
  }
  const recover = (stores: ProjectStores) => {
    let pending = recovered.get(stores.projectDir)
    if (!pending) {
      pending = recoverTaskReceipts(stores).then(() => {}).catch(error => { recovered.delete(stores.projectDir); throw error })
      recovered.set(stores.projectDir, pending)
    }
    return pending
  }
  const discover = async () => {
    const current = spaces(), dirs = new Set(current.map(s => s.projectDir))
    for (const [key, sub] of subscriptions) if (!dirs.has(sub.dir)) { sub.stop(); subscriptions.delete(key) }
    for (const [key, dir] of completed) if (!dirs.has(dir)) completed.delete(key)
    for (const stores of current) {
      await recover(stores)
      for (const state of await stores.runs.list()) {
        if (closed) return
        const key = `${stores.projectDir}:${state.runId}`
        if (ended(state.status)) {
          if (!completed.has(key)) sync(stores, state.runId)
          continue
        }
        completed.delete(key)
        if (subscriptions.has(key)) continue
        const sub = { dir: stores.projectDir, stop: () => {}, seq: 0, finished: false }
        sub.stop = stores.events.subscribe(state.runId, event => {
          sub.seq = Math.max(sub.seq, event.seq)
          if (event.type === 'run.finished' && ended((event.data as { status: string }).status)) sub.finished = true
          sync(stores, state.runId)
        })
        subscriptions.set(key, sub)
        sync(stores, state.runId)
      }
    }
  }
  const scan = () => {
    if (closed || discovering) return
    discovering = discover().catch(onError).finally(() => { discovering = undefined })
  }
  const tick = async () => {
    await Promise.all(spaces().flatMap(stores => [
      enqueue(stores, async () => {
        await recover(stores)
        await expireTaskReceipts(stores)
      }, receiptQueues),
      enqueue(stores, async () => {
        const result = await tickAttention(stores)
        for (const runId of result.resume) {
          const item = (await stores.attention.list()).find(item => item.runId === runId && item.handedBack)
          if (item) await onAnswer?.(stores, item)
        }
      }, tickQueues),
    ]))
  }
  scan()
  const scanner = setInterval(scan, 1000), timer = setInterval(() => { void tick() }, 60_000)
  scanner.unref(); timer.unref()
  return { tick, async close() {
    closed = true; clearInterval(scanner); clearInterval(timer)
    await discovering
    for (const sub of subscriptions.values()) sub.stop()
    await Promise.all([...queues.values(), ...tickQueues.values(), ...receiptQueues.values()])
  } }
}
