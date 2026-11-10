import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import type { ProjectStores } from '../interfaces.js'
import { eventsFile } from '../store/paths.js'
import type { EventEnvelope, RunState } from '../types.js'

/**
 * 从一次运行的事件算出的摘要（用量、首轮通过、质量计数……）按「事件文件 + 运行状态 + 附加输入」缓存。
 * 总览、需求列表、运行列表每 15 秒被轮询一次，原来每次都把每个运行的事件日志整份解析一遍：几百 MB 的日志
 * 超出事件常驻缓存的上限，解析一次要好几秒，同一文件的读取还要排队，整个空间的页面都跟着慢。
 * 事件文件的 inode / 大小 / 修改时间、运行状态、附加输入任何一项变化都会重算；没有事件文件（还没开跑）时不缓存。
 * 缓存值共享给所有调用方，只读不改。
 */
const LIMIT = 4000
const digests = new Map<string, { key: string; value: unknown }>()
const pending = new Map<string, Promise<unknown>>()

const fingerprint = (value: unknown) => createHash('sha1').update(JSON.stringify(value) ?? '').digest('hex')

export async function runDigest<T>(
  stores: ProjectStores, state: RunState, name: string, compute: (events: EventEnvelope[]) => T | Promise<T>, extra?: unknown,
): Promise<T> {
  const file = eventsFile(stores.taktDir, state.runId)
  const info = await stat(file).catch(() => undefined)
  if (!info) return compute(await stores.events.read(state.runId))
  const id = `${name}\0${file}`
  const key = `${info.ino}:${info.size}:${info.mtimeMs}:${fingerprint([state, extra])}`
  const hit = digests.get(id)
  if (hit?.key === key) {
    // 最近用过的排到最后，超出上限时先淘汰最久没用的
    digests.delete(id)
    digests.set(id, hit)
    return hit.value as T
  }
  // 页面一打开会并发好几个请求要同一份摘要：只算一次
  const running = pending.get(`${id}\0${key}`)
  if (running) return running as Promise<T>
  const task = (async () => {
    const value = await compute(await stores.events.read(state.runId))
    digests.delete(id)
    digests.set(id, { key, value })
    if (digests.size > LIMIT) digests.delete(digests.keys().next().value!)
    return value
  })()
  pending.set(`${id}\0${key}`, task)
  try { return await task } finally { pending.delete(`${id}\0${key}`) }
}
