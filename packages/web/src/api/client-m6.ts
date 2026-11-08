import { ApiRequestError } from './client'
import { RuntimeConflictError, type M6Source } from './source-m6'

interface Http {
  req: <T>(method: string, path: string, body?: unknown) => Promise<T>
  get: <T>(path: string) => Promise<T>
}

const enc = encodeURIComponent

/** M6 接口的 HTTP 实现（docs/design/27 §4）。 */
export function createM6Http({ req, get }: Http): M6Source {
  return {
    runtimeConfig: () => get('/space/runtime'),
    patchRuntime: (patch) =>
      req<Awaited<ReturnType<M6Source['patchRuntime']>>>('PATCH', '/space/runtime', patch).catch((e: unknown) => {
        if (e instanceof ApiRequestError && e.status === 409) throw new RuntimeConflictError(e.message)
        throw e
      }),
    testRuntime: (body) => req('POST', '/space/runtime/test', body),
    putSecret: (name, value, reason) => req('PUT', `/secrets/${enc(name)}`, { value, reason }),
    deleteSecret: (name, reason) => req('DELETE', `/secrets/${enc(name)}`, { reason }),
  }
}
