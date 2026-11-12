import { ApiRequestError } from './client'
import type { DataSource } from './source'

/**
 * 演示数据只在显式要求时使用（不再因为探测失败静默切过去）：
 * ?mock=1 / VITE_MOCK=1 只读演示，写操作一律拒绝。
 */
export type DemoMode = 'readonly'

export function demoMode(search = location.search, env: string | undefined = import.meta.env.VITE_MOCK): DemoMode | undefined {
  const v = new URLSearchParams(search).get('mock') ?? env
  return v === '1' ? 'readonly' : undefined
}

/** 演示数据源的写方法：动词开头（client.ts 里它们都发 POST / PUT / PATCH / DELETE）。预览类 POST 只读，不算。 */
const WRITE = /^(add|answer|approve|archive|attribute|cancel|collect|confirm|convert|create|decide|delete|dispose|edit|harvest|migrate|patch|post|publish|put|refresh|reject|repair|replace|report|resend|restore|retire|retry|rewind|rollback|run(?=Command)|save|set|start|stop|sync|synthesize|test|trigger|undo|update|upload)(?![a-z])/
const READ_ANYWAY = new Set(['rewindPreview'])
const WRITE_ANYWAY = new Set(['stewardFeedback'])
export const isWriteMethod = (name: string): boolean => WRITE_ANYWAY.has(name) || (WRITE.test(name) && !READ_ANYWAY.has(name) && !/Preview(Draft)?$/.test(name))

export const DEMO_READONLY_MESSAGE = '演示数据是只读的，这次改动没有保存。连上 takt serve 后再操作。'

/** 只读演示：写方法直接拒绝（405），读方法和订阅照常；forSpace 绑定出来的数据源同样只读。 */
export function readOnlyDemo(source: DataSource): DataSource {
  const bound = new Map<string, DataSource>()
  return new Proxy(source, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown
      if (typeof key !== 'string' || typeof value !== 'function') return value
      if (key === 'forSpace') return (id: string) => bound.get(id) ?? bound.set(id, readOnlyDemo(target.forSpace(id))).get(id)!
      // 汇报默认会标已读；演示查询只预览，不改变未读数。
      if (key === 'digest') return (since?: string) => target.digest(since, { peek: true })
      if (key === 'runCommand') return async (...args: Parameters<DataSource['runCommand']>) => {
        const command = (await target.commands()).find((c) => c.id === args[0])
        if (command?.risk !== 'read') throw new ApiRequestError(405, DEMO_READONLY_MESSAGE)
        return target.runCommand.apply(receiver, args)
      }
      if (isWriteMethod(key)) return () => Promise.reject(new ApiRequestError(405, DEMO_READONLY_MESSAGE))
      return value
    },
  })
}
