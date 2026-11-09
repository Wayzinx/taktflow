interface ResumeBackgroundOptions<T> {
  onError(error: unknown): void | Promise<void>
  onSettled?(result: T | undefined): void | Promise<void>
  jobs?: Set<Promise<unknown>>
}

/** 启动回执与执行寿命分离；jobs 跟踪包含错误处理和收尾的完整任务。 */
export function resumeInBackground<T>(resume: (onStarted: () => void) => Promise<T>, options: ResumeBackgroundOptions<T>): Promise<void> {
  let started = false
  let resolveReady!: () => void, rejectReady!: (error: unknown) => void
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const report = async (error: unknown) => {
    try { await options.onError(error) }
    catch (reportError) { process.stderr.write(`后台续跑错误通知失败：${String(reportError)}\n`) }
  }
  const job = Promise.resolve().then(async () => {
    let result: T | undefined
    let failed = false, failure: unknown
    try {
      result = await resume(() => { started = true; resolveReady() })
    } catch (error) {
      failed = true; failure = error
      if (started) await report(error)
    } finally {
      try { await options.onSettled?.(result) }
      catch (error) { await report(error) }
      options.jobs?.delete(job)
    }
    // 已取消等无需执行的运行可能没有启动通知，也必须结束等待。
    if (!started) { if (failed) rejectReady(failure); else resolveReady() }
  })
  options.jobs?.add(job)
  return ready
}
