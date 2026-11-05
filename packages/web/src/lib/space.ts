/** 项目空间前缀：/s/:spaceId/...；不带前缀即默认空间（单空间 serve 时就是唯一的空间）。 */
import { currentLocation } from './router'

export function splitSpace(pathname: string): { spaceId?: string; rest: string } {
  const m = /^\/s\/([^/]+)(\/.*)?$/.exec(pathname)
  if (!m) return { rest: pathname || '/' }
  return { spaceId: decodeURIComponent(m[1]!), rest: m[2] && m[2] !== '' ? m[2] : '/' }
}

export function currentSpaceId(): string | undefined {
  const loc = currentLocation()
  const i = loc.indexOf('?')
  return splitSpace(i < 0 ? loc : loc.slice(0, i)).spaceId
}

export function spacePath(spaceId: string, rest = '/'): string {
  return `/s/${encodeURIComponent(spaceId)}${rest === '/' ? '' : rest}`
}
