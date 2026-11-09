import type { StewardContextRef } from '@taktflow/core'
import { matchPath, useLocation } from '../../lib/router'
import { usePageContextExtra } from '../../lib/ui-store'
import { useAsync } from '../../api'

/** 全局页面（不属于任何空间）：不带空间上下文。 */
const GLOBAL = /^\/(solo|steward|spaces)(\/|$)/

/**
 * 停靠面板自动带上的上下文（docs/design/22 §1.2）：按当前路由推导空间 / 需求 / 运行 / 节点 / workflow / 知识库，
 * 再合并页面用 usePageContext() 声明的（例如 workflow 编辑器里选中的节点）。A 组可以改推导规则，签名不变。
 */
export function usePageStewardContext(): StewardContextRef[] {
  const { path, query, spaceId } = useLocation()
  const extra = usePageContextExtra()
  const out: StewardContextRef[] = []
  // 默认空间 / 单空间模式下 URL 不带 /s/:space 前缀：用当前空间的真实 id 补上，管家才知道指的是哪个空间的对象
  const global = GLOBAL.test(path)
  const current = useAsync((d) => (spaceId || global ? Promise.resolve(undefined) : d.space().then((s) => ({ id: s.id, name: s.name })).catch(() => undefined)), [spaceId ?? '', global])
  const space = spaceId ?? (global ? undefined : current.data?.id)
  if (space) out.push({ type: 'space', id: space, label: current.data?.id === space ? current.data.name : space })
  const req = matchPath('/req/:id', path)
  if (req) out.push({ type: 'requirement', spaceId: space, id: req.id!, label: req.id })
  const run = matchPath('/run/:runId', path)
  if (run) {
    out.push({ type: 'run', spaceId: space, id: run.runId!, label: run.runId })
    const node = query.get('node')
    if (node) out.push({ type: 'node', spaceId: space, id: node, parent: run.runId, label: node })
  }
  const wf = matchPath('/workflows/:id', path)
  if (wf) out.push({ type: 'workflow', spaceId: space, id: wf.id!, label: wf.id })
  const kb = matchPath('/knowledge/:id', path)
  if (kb) out.push({ type: 'knowledge', spaceId: space, id: kb.id!, label: kb.id })
  for (const e of extra) if (!out.some((o) => o.type === e.type && o.id === e.id)) out.push(e)
  return out
}

/** 当前路由对应的建议页键（GET /steward/suggestions?page=&id=）。 */
export function pageKeyOf(path: string): { page: string; id?: string } {
  const rules: Array<[string, string]> = [
    ['/req/:id', 'requirement'],
    ['/run/:id', 'run'],
    ['/workflows/:id', 'workflow'],
    ['/knowledge/:id', 'knowledge-detail'],
  ]
  for (const [pattern, page] of rules) {
    const m = matchPath(pattern, path)
    if (m) return { page, id: m.id }
  }
  const first = path.split('/').filter(Boolean)[0]
  const pages: Record<string, string> = { requirements: 'requirements', attention: 'attention', workflows: 'workflows', knowledge: 'knowledge', settings: 'settings', eval: 'eval', spaces: 'spaces', steward: 'steward', solo: 'steward' }
  return { page: first ? (pages[first] ?? first) : 'overview' }
}
