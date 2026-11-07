/** 项目空间前缀：/s/:spaceId/...；不带前缀即默认空间（单空间 serve 时就是唯一的空间）。 */

export function splitSpace(pathname: string): { spaceId?: string; rest: string } {
  const m = /^\/s\/([^/]+)(\/.*)?$/.exec(pathname)
  if (!m) return { rest: pathname || '/' }
  return { spaceId: decodeURIComponent(m[1]!), rest: m[2] && m[2] !== '' ? m[2] : '/' }
}

export function currentSpaceId(): string | undefined {
  return splitSpace(location.pathname).spaceId
}

export function spacePath(spaceId: string, rest = '/'): string {
  return `/s/${encodeURIComponent(spaceId)}${rest === '/' ? '' : rest}`
}

/**
 * 记住上次进入的空间：直接打开不带前缀的地址（书签、新标签页）时回到它，而不是总落在列表第一个。
 * 只存本机偏好；存储不可用时退回默认空间。
 */
const LAST_SPACE = 'takt.lastSpace'
export function rememberSpace(id: string): void {
  try {
    localStorage.setItem(LAST_SPACE, id)
  } catch {
    /* 无痕模式等 */
  }
}
export function lastSpaceId(): string | undefined {
  try {
    return localStorage.getItem(LAST_SPACE) ?? undefined
  } catch {
    return undefined
  }
}
export function forgetSpace(id: string): void {
  try {
    if (localStorage.getItem(LAST_SPACE) === id) localStorage.removeItem(LAST_SPACE)
  } catch {
    /* ignore */
  }
}
