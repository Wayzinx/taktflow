export function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new Error(signal.reason instanceof Error ? signal.reason.message : 'Native request cancelled')
}

export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => {}); checkAbort(signal) }
  let abort!: () => void
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new Error(signal.reason instanceof Error ? signal.reason.message : 'Native request cancelled'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
  try {
    return await Promise.race([work, cancelled])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

export function requestSignal(parent?: AbortSignal, timeoutMs = 300_000): { signal: AbortSignal; dispose(): void } {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error('timeoutMs must be positive, finite and at most 2147483647')
  const controller = new AbortController()
  const cancel = () => controller.abort(new Error('Native request cancelled'))
  parent?.addEventListener('abort', cancel, { once: true })
  if (parent?.aborted) cancel()
  const timer = setTimeout(() => controller.abort(new Error(`Native request timed out after ${timeoutMs}ms`)), timeoutMs)
  timer.unref()
  return { signal: controller.signal, dispose() { clearTimeout(timer); parent?.removeEventListener('abort', cancel) } }
}
