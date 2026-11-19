/**
 * 空间页面和空间管家使用当前空间选择的成员。显式个人管家使用单独保存的全局身份。
 * 部署在网关后由网关验证身份并设置可信请求头；直接访问本机服务可使用默认负责人。
 */
import { currentSpaceId } from './space'

const PREFIX = 'taktflow.attention.me:'
const key = (spaceId = currentSpaceId()) => `${PREFIX}${spaceId ?? ''}`
const cache = new Map<string, string | undefined>()
const listeners = new Set<() => void>()

export function actingUser(spaceId?: string): string | undefined {
  const k = key(spaceId)
  if (cache.has(k)) return cache.get(k)
  let v: string | undefined
  try {
    v = window.localStorage.getItem(k) ?? undefined
  } catch {
    v = undefined
  }
  cache.set(k, v)
  return v
}

const STEWARD_KEY = 'taktflow.steward.me'

function write(k: string, id: string | undefined) {
  cache.set(k, id)
  try {
    if (id) window.localStorage.setItem(k, id)
    else window.localStorage.removeItem(k)
  } catch {
    /* 隐私模式等：只在本页会话内生效 */
  }
}

export function setActingUser(id: string | undefined) {
  write(key(), id)
  // 选了人就同步成管家的全局身份；清空空间身份不清全局身份（别的空间可能还在用）
  if (id) write(STEWARD_KEY, id)
  for (const notify of listeners) notify()
}

globalThis.addEventListener?.('storage', (event) => {
  if (event.key === null) cache.clear()
  else if (event.key.startsWith(PREFIX)) cache.delete(event.key)
  else return
  for (const notify of listeners) notify()
})

export function subscribeActingUser(notify: () => void): () => void {
  listeners.add(notify)
  return () => listeners.delete(notify)
}

/** 个人管家使用的全局身份。 */
export function stewardUser(): string | undefined {
  if (cache.has(STEWARD_KEY)) return cache.get(STEWARD_KEY)
  let v: string | undefined
  try {
    v = window.localStorage.getItem(STEWARD_KEY) ?? undefined
  } catch {
    v = undefined
  }
  cache.set(STEWARD_KEY, v)
  return v
}

/** 请求头只能放 ByteString；成员 id 不是可打印 ASCII 时不发（服务端回落到缺省 owner）。 */
export function actingUserHeader(steward = false, spaceId?: string): Record<string, string> {
  const id = steward ? stewardUser() : actingUser(spaceId)
  return id && /^[\x21-\x7e]+$/.test(id) ? { 'x-takt-user': id } : {}
}
