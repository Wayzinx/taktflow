import { matchGlob } from '../util/glob.js'
import type { AgentProfile, NodeDef } from '../types.js'

// 两个 glob 数组分别是 OR，工具白名单必须表示它们的 AND；不能拼接数组。
// 在字符、路径段两层同步消费通配符，结果仍是 glob，因而新文件也受同一约束。
function intersectTokens(left: string[], right: string[], star: string, meet: (a: string, b: string) => string[]): string[][] {
  const memo = new Map<string, string[][]>()
  let count = 0
  const visit = (i: number, j: number): string[][] => {
    const key = `${i}:${j}`
    const cached = memo.get(key)
    if (cached) return cached
    const a = left[i], b = right[j]
    let result: string[][]
    if (a === undefined && b === undefined) result = [[]]
    else if (a === star && b === star) {
      result = [...visit(i + 1, j), ...visit(i, j + 1)].map((tail) => [star, ...tail])
    } else if (a === star) {
      result = [...visit(i + 1, j), ...(b === undefined ? [] : visit(i, j + 1).map((tail) => [b, ...tail]))]
    } else if (b === star) {
      result = [...visit(i, j + 1), ...(a === undefined ? [] : visit(i + 1, j).map((tail) => [a, ...tail]))]
    } else if (a === undefined || b === undefined) result = []
    else result = meet(a, b).flatMap((head) => visit(i + 1, j + 1).map((tail) => [head, ...tail]))
    result = [...new Map(result.map((tokens) => {
      const compact = tokens.filter((token, index) => token !== star || tokens[index - 1] !== star)
      return [JSON.stringify(compact), compact] as const
    })).values()]
    count += result.length
    if (count > 10000) throw new Error('写范围交集过于复杂，请简化 writeScope')
    memo.set(key, result)
    return result
  }
  return visit(0, 0)
}

function intersectSegment(a: string, b: string): string[] {
  if (a === b) return [a]
  return intersectTokens(a.split(''), b.split(''), '*', (x, y) => x === y ? [x] : x === '?' ? [y] : y === '?' ? [x] : [])
    .map((tokens) => tokens.join(''))
}

function segments(pattern: string): string[] {
  const parts = pattern.split('/')
  // matchGlob 的末尾 /** 保留前面的斜杠，不能把目录本身当成文件放行。
  if (parts.at(-1) === '**') parts.push('*')
  return parts
}

export function intersectWriteScopes(profile: string[], node?: string[]): string[] {
  if (node === undefined) return [...profile]
  return [...new Set(profile.flatMap((a) => node.flatMap((b) =>
    intersectTokens(segments(a), segments(b), '**', intersectSegment).map((tokens) => tokens.join('/')))))]
}

/**
 * 声明的产出（相对公共存放区 workspace）里角色与节点写权限盖不住的那些：产出不会自动获得写权限，写不了就必然缺产物或判越界。
 * 通配产出取最直接的一个文件代表：research/review/** 看 research/review/x，reports/*.md 看 reports/x.md；带 [] {} 的交给运行后的守卫。
 */
export function unwritableOutputs(outputs: Array<{ path: string }>, workspace: string, profile: string[], node?: string[]): string[] {
  const allowed = (file: string) => profile.some((pattern) => matchGlob(pattern, file)) && (node === undefined || node.some((pattern) => matchGlob(pattern, file)))
  return outputs.map((output) => output.path).filter((path) => {
    if (/[[{]/.test(path)) return false
    const parts = path.split('/')
    const sample = parts.flatMap((part, index) => part === '**' ? index === parts.length - 1 ? ['x'] : [] : [part.replace(/[*?]+/g, 'x')]).join('/')
    return !allowed(workspace ? `${workspace}/${sample}` : sample)
  })
}

export function unwritableMessage(nodeId: string, role: string, paths: string[], scope: string[]): string {
  return `节点 ${nodeId} 要产出 ${paths.join('、')}，但角色 ${role} 的写权限不含它：${JSON.stringify(scope)}。给角色加上这个路径的写权限，或把产出改到写权限里的位置，再重试`
}

/** 启动前核对每个 agent 节点的产出都写得了；planner 展开的节点在开跑前另行核对。 */
export function validateWorkflowOutputs(nodes: NodeDef[], profiles: Record<string, AgentProfile>, workspace: string): void {
  for (const node of nodes) {
    if (node.kind === 'loop') validateWorkflowOutputs(node.body, profiles, workspace)
    else if (node.kind === 'subflow') validateWorkflowOutputs(node.workflow.nodes, profiles, workspace)
    else if (node.kind === 'agent' && profiles[node.role] && node.outputs?.length) {
      const paths = unwritableOutputs(node.outputs, workspace, profiles[node.role]!.writeScope, node.writeScope)
      if (paths.length) throw new Error(unwritableMessage(node.id, node.role, paths, intersectWriteScopes(profiles[node.role]!.writeScope, node.writeScope)))
    }
  }
}
