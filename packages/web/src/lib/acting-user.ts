/**
 * "我是谁"：还没有登录时由人在界面上选（待办页的"我是"），HTTP 客户端把它放进 `x-takt-user`，
 * 这样"派给我"筛选和服务端审计（审批、处置、改配置的操作者）是同一个人。
 * 没选过时不发请求头，服务端按空间第一个 owner 处理，`GET /api/me` 返回的就是这个缺省身份。
 * 按空间分别记：各空间成员不同，在 A 空间选的人到 B 空间可能不是成员，带过去会让写操作 403。
 */
import { currentSpaceId } from './space'

const key = () => `taktflow.attention.me:${currentSpaceId() ?? ''}`
const cache = new Map<string, string | undefined>()

export function actingUser(): string | undefined {
  const k = key()
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

export function setActingUser(id: string | undefined) {
  const k = key()
  cache.set(k, id)
  try {
    if (id) window.localStorage.setItem(k, id)
    else window.localStorage.removeItem(k)
  } catch {
    /* 隐私模式等：只在本页会话内生效 */
  }
}

/** 请求头只能放 ByteString；成员 id 不是可打印 ASCII 时不发（服务端回落到缺省 owner）。 */
export function actingUserHeader(): Record<string, string> {
  const id = actingUser()
  return id && /^[\x21-\x7e]+$/.test(id) ? { 'x-takt-user': id } : {}
}
