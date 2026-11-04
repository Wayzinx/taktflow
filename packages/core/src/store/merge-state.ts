import { canonicalJson } from '../util/hash.js'

const equal = (a: unknown, b: unknown) => a === undefined || b === undefined ? a === b : canonicalJson(a) === canonicalJson(b)
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

function generationDelta(incoming: unknown, current: unknown): number {
  if (!object(incoming) || !object(current)
    || typeof incoming.attempts !== 'number' || typeof current.attempts !== 'number') return 0
  return incoming.attempts - current.attempts
    || ((incoming.iteration as number | undefined) ?? 0) - ((current.iteration as number | undefined) ?? 0)
}

// 按上次提交计算补丁；未改字段保留磁盘更新，冲突默认保留外部更新。
export function mergeState<T>(base: T | undefined, incoming: T, current: T): T {
  const delta = generationDelta(incoming, current)
  if (delta < 0) return structuredClone(current)
  if (delta > 0) return structuredClone(incoming)
  if (equal(base, incoming)) return structuredClone(current)
  if (equal(base, current) || equal(incoming, current)) {
    // 整个 RunState 的快捷返回会绕过子节点的代际保护，必须递归检查节点。
    if (!object(incoming) || !object(current)) return structuredClone(incoming)
  }
  if (object(incoming) && object(current)) {
    const result: Record<string, unknown> = {}
    const before: Record<string, unknown> = object(base) ? base : {}
    for (const key of new Set([...Object.keys(before), ...Object.keys(incoming), ...Object.keys(current)])) {
      const value = mergeState(before[key], incoming[key], current[key])
      if (value !== undefined) result[key] = value
    }
    if (typeof incoming.runId === 'string' && incoming.runId === current.runId
      && object(incoming.nodes) && object(current.nodes)) {
      const proposedNodes = incoming.nodes
      const outdated = Object.entries(current.nodes).some(([id, node]) =>
        proposedNodes[id] === undefined || generationDelta(proposedNodes[id], node) < 0)
      if (incoming.status === 'cancelled') {
        result.status = 'cancelled'
        if (incoming.endedAt !== undefined) result.endedAt = incoming.endedAt
      } else if (outdated) {
        // 节点已被代际保护时，旧执行推导的失败/结束时间也不能覆盖新运行结果；明确取消仍生效。
        result.status = current.status
        if (current.endedAt === undefined) delete result.endedAt
        else result.endedAt = current.endedAt
      }
    }
    return result as T
  }
  return structuredClone(current)
}
