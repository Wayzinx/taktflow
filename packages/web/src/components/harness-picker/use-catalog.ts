import { useEffect, useRef } from 'react'
import type { RuntimeCatalog } from '@taktflow/core'
import { useAsync } from '../../api'
import type { DataSource } from '../../api/source'
import { catalogPending } from '../../lib/catalog-picker'

// 一屏里常有好几个选择器（主路由 + 备选），同一时刻只发一次
let last: { ds: DataSource; at: number; p: Promise<RuntimeCatalog> } | undefined
function fetchCatalog(ds: DataSource): Promise<RuntimeCatalog> {
  if (last && last.ds === ds && Date.now() - last.at < 1500) return last.p
  const p = ds.runtimeCatalog()
  last = { ds, at: Date.now(), p }
  p.catch(() => { if (last?.p === p) last = undefined })
  return p
}

/** 模型目录（docs/design/32 §7）。服务端几秒内没拉完的项先返回「正在获取…」，这里隔一会儿再取，最多补 5 次。 */
export function useRuntimeCatalog() {
  const q = useAsync((ds) => fetchCatalog(ds), [])
  const pending = catalogPending(q.data)
  const tries = useRef(0)
  const { reload } = q
  useEffect(() => {
    if (!pending || tries.current >= 5) return
    const t = setTimeout(() => {
      tries.current += 1
      reload()
    }, 2500)
    return () => clearTimeout(t)
  }, [pending, q.data]) // eslint-disable-line react-hooks/exhaustive-deps
  return q
}
