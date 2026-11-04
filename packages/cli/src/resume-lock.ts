const chains = new Map<string, Promise<unknown>>()

/**
 * 同一运行上的 resume 必须串行：两次 resume 并发会让引擎的 state 互相覆盖。
 * 进程内按 runId 排队；不同运行互不影响。
 */
export function serializeRun<T>(runId: string, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(runId) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(task)
  chains.set(runId, next)
  void next.finally(() => {
    if (chains.get(runId) === next) chains.delete(runId)
  }).catch(() => undefined)
  return next
}
