import { decode } from './http.js'

export function createRouter<T>() {
  const routes: Array<{ method: string; parts: string[]; handler: T }> = []
  return {
    add(method: string, pattern: string, handler: T) {
      routes.push({ method, parts: pattern.split('/'), handler })
    },
    match(method: string, pathname: string): { handler: T; params: Record<string, string> } | undefined {
      const parts = pathname.split('/')
      for (const route of routes) {
        if (route.method !== method || route.parts.length !== parts.length) continue
        if (!route.parts.every((part, i) => part.startsWith(':') ? parts[i] !== '' : part === parts[i])) continue
        const params: Record<string, string> = {}
        route.parts.forEach((part, i) => { if (part.startsWith(':')) params[part.slice(1)] = decode(parts[i]!) })
        return { handler: route.handler, params }
      }
      return undefined
    },
  }
}
