/**
 * "我是谁"：还没有登录时由人在界面上选（待办页的"我是"），HTTP 客户端把它放进 `x-takt-user`，
 * 这样"派给我"筛选和服务端审计（审批、处置、改配置的操作者）是同一个人。
 * 没选过时不发请求头，服务端按空间第一个 owner 处理，`GET /api/me` 返回的就是这个缺省身份。
 * 按空间分别记：各空间成员不同，在 A 空间选的人到 B 空间可能不是成员，带过去会让写操作 403。
 * 管家是全局的（会话、提案、汇报按人存，不分空间）：另记一份全局身份 stewardUser()，最近一次在任何空间选的"我是"，
 * Solo 整页与空间内停靠面板用的是同一个人。
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
}

/** 管家接口（/steward/*）用的全局身份；没选过时为空，服务端回落到缺省 owner。 */
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
export function actingUserHeader(steward = false): Record<string, string> {
  const id = steward ? stewardUser() : actingUser()
  return id && /^[\x21-\x7e]+$/.test(id) ? { 'x-takt-user': id } : {}
}
