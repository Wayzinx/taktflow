import { useEffect, useState } from 'react'
import { BookOpen, FolderKanban, ListChecks, PlayCircle, SquareTerminal, Workflow, type LucideIcon } from 'lucide-react'
import type { CommandInfo, StewardContextRef } from '@taktflow/core'
import type { DataSource } from '../../api'

export interface PickItem {
  key: string
  icon: LucideIcon
  label: string
  hint?: string
  section: string
  /** @ 引用：插入文本 + 加进上下文。 */
  ref?: StewardContextRef
  /** / 命令：插入的文本。 */
  insert: string
}

const safe = <T,>(p: Promise<T[]>) => p.catch(() => [] as T[])

/** @ 可引用的对象：空间、需求、运行、workflow、知识库（第一次输入 @ 时才拉）。 */
export async function loadMentions(ds: DataSource): Promise<PickItem[]> {
  const [spaces, reqs, runs, wfs, kbs] = await Promise.all([safe(ds.spaces()), safe(ds.requirements()), safe(ds.runs()), safe(ds.workflows()), safe(ds.knowledgeBases())])
  return [
    ...reqs.map((r) => ({ key: `requirement:${r.id}`, icon: ListChecks, label: `${r.id} ${r.title}`, hint: '需求', section: '需求', insert: `@${r.id}`, ref: { type: 'requirement' as const, id: r.id, label: `${r.id} ${r.title}` } })),
    ...spaces.map((s) => ({ key: `space:${s.id}`, icon: FolderKanban, label: s.name, hint: s.id, section: '空间', insert: `@${s.id}`, ref: { type: 'space' as const, id: s.id, label: s.name } })),
    ...wfs.map((w) => ({ key: `workflow:${w.id}`, icon: Workflow, label: w.title, hint: w.id, section: 'workflow', insert: `@${w.id}`, ref: { type: 'workflow' as const, id: w.id, label: w.title } })),
    ...kbs.map((k) => ({ key: `knowledge:${k.id}`, icon: BookOpen, label: k.name, hint: k.kind, section: '知识库', insert: `@${k.id}`, ref: { type: 'knowledge' as const, id: k.id, label: k.name } })),
    ...runs.slice(0, 8).map((r) => ({ key: `run:${r.runId}`, icon: PlayCircle, label: r.runId, hint: r.requirementId, section: '运行', insert: `@${r.runId}`, ref: { type: 'run' as const, id: r.runId, label: r.runId } })),
  ]
}

export function commandItems(list: CommandInfo[]): PickItem[] {
  return list.map((c) => ({ key: `cmd:${c.id}`, icon: SquareTerminal, label: c.title, hint: c.id, section: c.kind === 'query' ? '查询' : '命令', insert: `/${c.id} ` }))
}

/** 多词全命中；标识前缀命中排前。 */
export function filterItems(items: PickItem[], q: string, max = 8): PickItem[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return items.slice(0, max)
  const scored = items
    .map((it) => {
      const hay = `${it.label} ${it.hint ?? ''} ${it.insert}`.toLowerCase()
      if (!words.every((w) => hay.includes(w))) return null
      const pre = it.insert.toLowerCase().startsWith(`@${words[0]}`) || it.insert.toLowerCase().startsWith(`/${words[0]}`)
      return { it, s: pre ? 0 : 1 }
    })
    .filter((x): x is { it: PickItem; s: number } => !!x)
  return scored.sort((a, b) => a.s - b.s).slice(0, max).map((x) => x.it)
}

/** 光标前的触发词：@xxx 或行首 / 空白后的 /xxx。 */
export function triggerAt(text: string, caret: number): { kind: '@' | '/'; start: number; query: string } | undefined {
  const before = text.slice(0, caret)
  const m = /(^|\s)([@/])([^\s@/]*)$/.exec(before)
  if (!m) return undefined
  return { kind: m[2] as '@' | '/', start: before.length - m[3]!.length - 1, query: m[3]! }
}

export function useLazy<T>(load: () => Promise<T>, on: boolean): T | undefined {
  const [v, setV] = useState<T>()
  useEffect(() => {
    if (!on || v !== undefined) return
    let alive = true
    void load().then((x) => alive && setV(x))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, v])
  return v
}
