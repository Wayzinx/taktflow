import path from 'node:path'

const queues = new Map<string, Promise<unknown>>()

/**
 * 进程内按 key 串行化，同一进程里不同 store 实例共享同一个队列：
 * manifest / 事件日志这类"读-改-写"必须整体排队，否则并发写会互相覆盖。
 */
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  key = path.resolve(key)
  const prev = queues.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  queues.set(key, tail)
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  return run
}
