import { useMemo } from 'react'
import { BookOpen, Boxes, FileText, Inbox, LayoutDashboard, LayoutGrid, ListTodo, Monitor, Moon, Play, Plus, Settings, Shapes, Sun, UserRoundCog, Workflow, Zap, type LucideIcon } from 'lucide-react'
import { isMac } from '../../lib/shortcuts'
import { askSteward, openCreateRequirement, openCreateSpace, openSteward } from '../../lib/ui-store'
import type { CommandInfo, RequirementSummary, RunSummary } from '@taktflow/core'
import { useAsync } from '../../api'
import { fmtRelative } from '../../lib/format'
import { matchPath, navigate, useLocation } from '../../lib/router'
import { REQ_STATUS, RUN_STATUS, toneVar } from '../../lib/status'
import { setTheme } from '../../lib/theme'
import { RISK } from '../ui/reason-dialog'
import { commandScope, SCOPE_KEY } from './schema'
import { BeeGlyph } from '../identity'

export type Group = '页面' | '查询' | '命令' | '需求' | '运行' | '操作' | '管家'
const GROUP_ORDER: Group[] = ['页面', '查询', '命令', '需求', '运行', '操作', '管家']

export interface Item {
  id: string
  group: Group
  label: string
  /** 等宽显示的标识（REQ-001、run id、命令 id） */
  code?: string
  hint?: string
  icon: LucideIcon
  tone?: string
  keywords: string
  /** 有 command 时选中进入表单，不直接执行 */
  command?: CommandInfo
  /** 命令能从当前页面带入参数时排前面 */
  inContext?: boolean
  run?: () => void
}

/** 当前页面能自动带入命令的参数。 */
export interface PaletteContext {
  requirementId?: string
  runId?: string
  nodeId?: string
}

export function usePaletteContext(runs: RunSummary[] | undefined): PaletteContext {
  const { path, query } = useLocation()
  const req = matchPath('/req/:id', path)
  const run = matchPath('/run/:runId', path)
  if (req) return { requirementId: req.id }
  if (run) {
    const r = runs?.find((x) => x.runId === run.runId)
    return { runId: run.runId, requirementId: r?.requirementId, nodeId: query.get('node') ?? undefined }
  }
  return {}
}

/** 命令的适用上下文在当前页面里全部能带入。 */
export function contextFits(cmd: CommandInfo, ctx: PaletteContext): boolean {
  const scope = commandScope(cmd)
  if (!scope.length) return false
  return scope.every((s) => !!ctx[SCOPE_KEY[s]])
}

const PAGES: Array<[string, string, LucideIcon, string]> = [
  ['/', '总览', LayoutDashboard, 'overview home zonglan'],
  ['/requirements', '需求列表', ListTodo, 'requirements xuqiu'],
  ['/attention', '待办', Inbox, 'attention todo daiban'],
  ['/knowledge', '知识库', BookOpen, 'knowledge zhishi kb rag wiki'],
  ['/solo', '管家 · 整页对话', BeeGlyph, 'solo steward guanjia assistant agent 管家 对话'],
  ['/spaces', '全部空间', Boxes, 'spaces kongjian'],
  ['/workflows', 'Workflow', Workflow, 'workflows pipeline liushuixian bianji'],
  ['/settings', '空间设置', Settings, 'settings space members repos models harness shezhi'],
  ['/settings?tab=lessons', '经验库', BookOpen, 'lessons jingyan 经验'],
  ['/automations', '自动化', Zap, 'automations schedule cron im feishu slack webhook zidonghua 定时 通知 飞书 汇报'],
  ['/settings?tab=agents', '角色', UserRoundCog, 'roles agents harness model skills juese 角色 技能'],
  ['/settings?tab=shared', '共享资源', LayoutGrid, 'shared resources skills knowledge repos gongxiang 共享 资源'],
  ['/ui', '组件陈列', Shapes, 'ui components gallery design system zujian 组件 规范 头像 图标'],
]

export interface PaletteData {
  items: Item[]
  loading: boolean
  reqs: RequirementSummary[]
  runs: RunSummary[]
  ctx: PaletteContext
}

export function usePaletteData(active: boolean): PaletteData {
  const reqs = useAsync((ds) => (active ? ds.requirements() : Promise.resolve([])), [active])
  const runs = useAsync((ds) => (active ? ds.runs() : Promise.resolve([])), [active])
  const cmds = useAsync((ds) => (active ? ds.commands() : Promise.resolve([])), [active])
  // 当前用户的角色：已经够格的命令不再提示"需 maintainer"（拿不到时照常提示）
  const me = useAsync((ds) => (active ? ds.me().catch(() => undefined) : Promise.resolve(undefined)), [active])
  const myRole = me.data?.member?.role
  const ctx = usePaletteContext(runs.data)
  const ctxKey = `${ctx.requirementId}|${ctx.runId}|${ctx.nodeId}`
  const sortedRuns = useMemo(() => [...(runs.data ?? [])].sort((a, b) => b.startedAt.localeCompare(a.startedAt)), [runs.data])

  const items = useMemo(() => {
    const out: Item[] = PAGES.map(([to, label, icon, kw]) => ({ id: `page:${to}`, group: '页面', label, icon, keywords: kw, run: () => navigate(to) }))
    for (const c of cmds.data ?? []) {
      const risk = RISK[c.risk]
      const fits = contextFits(c, ctx)
      const carried = fits ? [ctx.requirementId, ctx.runId && !ctx.requirementId ? ctx.runId : undefined].filter(Boolean).join(' · ') : ''
      out.push({
        id: `cmd:${c.id}`,
        group: c.kind === 'query' ? '查询' : '命令',
        label: c.title,
        code: c.id,
        hint: carried ? `带入 ${carried}` : c.minRole === 'maintainer' && myRole !== 'maintainer' && myRole !== 'owner' ? '需 maintainer' : undefined,
        icon: risk.icon,
        tone: c.risk === 'dangerous' ? 'var(--st-failed)' : undefined,
        keywords: `${c.id} ${c.title} ${(c.keywords ?? []).join(' ')} ${risk.label} ${c.kind === 'query' ? '查询 query' : '命令 command'}`,
        command: c,
        inContext: fits,
      })
    }
    for (const r of reqs.data ?? []) {
      const st = REQ_STATUS[r.status]
      out.push({ id: `req:${r.id}`, group: '需求', label: r.title, code: r.id, hint: st.label, icon: FileText, tone: toneVar(st.tone), keywords: `${r.id} ${r.title}`, run: () => navigate(`/req/${r.id}`) })
    }
    for (const r of sortedRuns.slice(0, 30)) {
      const st = RUN_STATUS[r.status]
      out.push({
        id: `run:${r.runId}`,
        group: '运行',
        label: r.origin?.title ?? `${r.requirementId} · ${r.workflowId}`,
        code: r.runId,
        hint: `${st.label} · ${fmtRelative(r.startedAt)}`,
        icon: Play,
        tone: toneVar(st.tone),
        keywords: `${r.runId} ${r.requirementId} ${r.workflowId} ${r.origin?.title ?? ''}`,
        run: () => navigate(`/run/${r.runId}`),
      })
    }
    out.push(
      { id: 'create:requirement', group: '操作', label: '新建需求', hint: 'C', icon: Plus, keywords: 'new requirement create xinjian xuqiu 新建 需求', run: () => openCreateRequirement() },
      { id: 'create:space', group: '操作', label: '新建空间', icon: Boxes, keywords: 'new space create xinjian kongjian 新建 空间', run: () => openCreateSpace() },
      { id: 'create:knowledge', group: '操作', label: '新建知识库', icon: BookOpen, keywords: 'new knowledge create kb 新建 知识库', run: () => navigate('/knowledge?new=1') },
      { id: 'steward:open', group: '操作', label: '打开管家面板', hint: isMac ? '⌘J' : 'Ctrl J', icon: BeeGlyph, keywords: 'steward guanjia 管家 面板 dock', run: () => openSteward() },
      { id: 'theme:light', group: '操作', label: '切换到浅色主题', icon: Sun, keywords: 'theme light 浅色 主题', run: () => setTheme('light') },
      { id: 'theme:dark', group: '操作', label: '切换到深色主题', icon: Moon, keywords: 'theme dark 深色 主题', run: () => setTheme('dark') },
      { id: 'theme:system', group: '操作', label: '主题跟随系统', icon: Monitor, keywords: 'theme system 系统 主题', run: () => setTheme('system') },
    )
    return out
    // ctx 用 ctxKey 比较，避免每次渲染新对象
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqs.data, sortedRuns, cmds.data, ctxKey, myRole])

  return { items, loading: reqs.loading || runs.loading || cmds.loading, reqs: reqs.data ?? [], runs: sortedRuns, ctx }
}

/**
 * 过滤：所有空格分开的词都要命中；标识前缀命中最好，其次标题前缀。
 * 分组按组内最佳得分排序（组标题不重复），组内按得分；无输入时能带入上下文的命令排在各自组的最前。
 */
export function filterItems(items: Item[], q: string): Item[] {
  return withAsk(rankItems(items, q), q)
}

/** ⌘K 兜底（docs/design/22 §1.2）：有输入时最后一项是"问管家：…"，匹配不到任何命令时它就是唯一一项。 */
function withAsk(list: Item[], q: string): Item[] {
  const text = q.trim()
  if (!text) return list
  return [...list, { id: 'ask:steward', group: '管家', label: `问管家：${text}`, icon: BeeGlyph, keywords: text, run: () => askSteward(text) }]
}

function rankItems(items: Item[], q: string): Item[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const scored: Array<[Item, number]> = []
  if (!words.length) {
    let runs = 0
    for (const it of items) if (it.group !== '运行' || runs++ < 6) scored.push([it, it.inContext ? 0 : 1])
  } else {
    for (const it of items) {
      const hay = `${it.label} ${it.keywords}`.toLowerCase()
      if (!words.every((w) => hay.includes(w))) continue
      const first = words[0]!
      const code = it.code?.toLowerCase() ?? ''
      const base = code.startsWith(first) ? 0 : it.label.toLowerCase().startsWith(first) ? 1 : 2
      scored.push([it, base * 2 + (it.inContext ? 0 : 1)])
    }
  }
  const best = new Map<Group, number>()
  for (const [it, s] of scored) best.set(it.group, Math.min(best.get(it.group) ?? Infinity, s))
  const groupRank = (g: Group) => (words.length ? best.get(g)! * 10 : 0) + GROUP_ORDER.indexOf(g)
  return scored
    .map(([it, s], i) => ({ it, s, i }))
    .sort((a, b) => groupRank(a.it.group) - groupRank(b.it.group) || a.s - b.s || a.i - b.i)
    .map((x) => x.it)
}
