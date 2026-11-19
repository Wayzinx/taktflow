import { useCallback, useEffect, useRef, useState } from 'react'
import type { DataSource, SpaceDevices } from '../../api/index.js'
import { authDenied, deviceError } from './model.js'

const POLL_MS = 5_000
export const REQUEST_MS = 10_000

export function useDevices(source: DataSource, spaceId: string | undefined, isCurrent: () => boolean) {
  const [data, setData] = useState<SpaceDevices>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const inflight = useRef<AbortController | undefined>(undefined)

  const refresh = useCallback(async (replace = false) => {
    if (!isCurrent() || (inflight.current && !replace)) return
    inflight.current?.abort()
    const controller = new AbortController()
    inflight.current = controller
    setLoading(true)
    try {
      const snapshot = await source.devices(AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_MS)]))
      if (controller.signal.aborted || !isCurrent()) return
      if (spaceId && snapshot.spaceId !== spaceId) throw new Error('设备列表空间不匹配')
      setData(snapshot)
      setError(undefined)
    } catch (error) {
      if (controller.signal.aborted || !isCurrent()) return
      if (authDenied(error)) setData(undefined)
      setError(deviceError(error, 'read'))
    } finally {
      if (inflight.current === controller) {
        inflight.current = undefined
        if (isCurrent()) setLoading(false)
      }
    }
  }, [source, spaceId, isCurrent])

  useEffect(() => {
    void refresh()
    const whenVisible = () => { if (!document.hidden) void refresh() }
    const timer = source.mock ? undefined : window.setInterval(whenVisible, POLL_MS)
    if (!source.mock) document.addEventListener('visibilitychange', whenVisible)
    return () => {
      inflight.current?.abort()
      inflight.current = undefined
      clearInterval(timer)
      document.removeEventListener('visibilitychange', whenVisible)
    }
  }, [source, refresh])

  return { data, error, loading, refresh }
}
