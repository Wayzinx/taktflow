import type { Digest } from '@taktflow/core'
import type { DataSource } from '../../api/source'

/**
 * 本页会话内的"自上次以来"汇报（评审发现 #11）。
 * 服务端 GET /steward/digest 默认会标已读（seen.json 推到此刻、生成新 id、记一次 digest.open），
 * 所以页面只用 ?peek=1 只读取一次并缓存（invalidate 不重取，横幅不会因为答复待办等操作被"消费"掉），
 * 等用户真的看了（展开横幅 / 点"知道了" / 打开管家页）再不带 peek 请求一次来标已读，digest.open 由服务端记，页面不再重复上报。
 * space：空间总览只取本空间的汇报，已读也只记在这个空间上（看过 A 空间的横幅不会让 B 空间的汇报消失）；不给是管家页的全局汇报。
 */
const cache = new WeakMap<DataSource, Map<string, Promise<Digest | undefined>>>()
const marked = new WeakMap<DataSource, Set<string>>()

export function peekDigest(ds: DataSource, space?: string): Promise<Digest | undefined> {
  let byScope = cache.get(ds)
  if (!byScope) cache.set(ds, (byScope = new Map()))
  const scope = space ?? ''
  let p = byScope.get(scope)
  if (!p) {
    p = ds.digest(undefined, { peek: true, space }).catch(() => {
      byScope.delete(scope)
      return undefined
    })
    byScope.set(scope, p)
  }
  return p
}

/** 标已读：每份汇报只发一次。 */
export function markDigestSeen(ds: DataSource, digestId: string | undefined, space?: string): void {
  const key = `${space ?? ''}/${digestId ?? '*'}`
  let set = marked.get(ds)
  if (!set) marked.set(ds, (set = new Set()))
  if (set.has(key)) return
  set.add(key)
  void ds.digest(undefined, { space }).catch(() => set!.delete(key))
}
