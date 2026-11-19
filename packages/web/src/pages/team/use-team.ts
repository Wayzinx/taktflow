import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiRequestError } from '../../api/client'
import type { DataSource } from '../../api/source'
import type { TeamSnapshot } from '../../api/team'

const POLL_MS = 5_000
const READ_TIMEOUT_MS = 10_000

export function denied(error: unknown): boolean {
  return error instanceof ApiRequestError && (error.status === 401 || error.status === 403)
}

export function useTeam(source: DataSource, isCurrent: () => boolean) {
  const [data, setData] = useState<TeamSnapshot>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const inflight = useRef<AbortController | undefined>(undefined)

  const refresh = useCallback(async () => {
    if (inflight.current || !isCurrent()) return
    const controller = new AbortController()
    inflight.current = controller
    setLoading(true)
    const timeout = AbortSignal.timeout(READ_TIMEOUT_MS)
    try {
      const snapshot = await source.team(AbortSignal.any([controller.signal, timeout]))
      if (controller.signal.aborted || !isCurrent()) return
      setData(snapshot)
      setError(undefined)
    } catch (error) {
      if (controller.signal.aborted || !isCurrent()) return
      if (denied(error)) setData(undefined)
      setError(timeout.aborted ? '读取空间对话超时。' : error instanceof Error ? error.message : String(error))
    } finally {
      if (inflight.current === controller) {
        inflight.current = undefined
        if (isCurrent()) setLoading(false)
      }
    }
  }, [source, isCurrent])

  const accept = (snapshot: TeamSnapshot) => {
    if (!isCurrent()) return
    inflight.current?.abort()
    inflight.current = undefined
    setData(snapshot)
    setError(undefined)
    void refresh()
  }

  useEffect(() => {
    void refresh()
    const whenVisible = () => { if (!document.hidden) void refresh() }
    const timer = source.mock ? undefined : window.setInterval(whenVisible, POLL_MS)
    if (!source.mock) {
      document.addEventListener('visibilitychange', whenVisible)
      window.addEventListener('focus', whenVisible)
    }
    return () => {
      inflight.current?.abort()
      inflight.current = undefined
      clearInterval(timer)
      document.removeEventListener('visibilitychange', whenVisible)
      window.removeEventListener('focus', whenVisible)
    }
  }, [source, refresh])

  return { data, error, loading, refresh, accept }
}
