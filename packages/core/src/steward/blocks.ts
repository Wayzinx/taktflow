import type { StewardAction, StewardBlock, StewardContextRef, StewardStageStatus, StewardTone } from '../api.js'

const tones = new Set<StewardTone>(['neutral', 'success', 'running', 'waiting', 'failed', 'stale'])
const statuses = new Set<StewardStageStatus>(['done', 'running', 'waiting', 'failed', 'todo', 'skipped'])
const refTypes = new Set<StewardContextRef['type']>(['space', 'requirement', 'run', 'node', 'workflow', 'knowledge', 'file'])

type MaybePromise<T> = T | Promise<T>

export interface NormalizeBlocksContext {
  refVisible?(ref: StewardContextRef): MaybePromise<boolean>
  commandExists?(commandId: string): MaybePromise<boolean>
}

export async function normalizeBlocks(
  raw: unknown,
  ctx: NormalizeBlocksContext = {},
): Promise<{ blocks: StewardBlock[]; issues: string[] }> {
  const issues: string[] = []
  const input = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.blocks) ? raw.blocks : undefined
  if (!input) {
    issues.push(`blocks：期望数组，收到 ${describe(raw)}，已忽略`)
    return { blocks: [], issues }
  }
  const blocks: StewardBlock[] = []
  if (input.length > 6) issues.push(`blocks：最多 6 块，收到 ${input.length} 块，已截断`)
  for (const [index, item] of input.slice(0, 6).entries()) {
    const block = await normalizeBlock(item, `blocks[${index}]`, ctx, issues)
    if (block) blocks.push(block)
  }
  return { blocks, issues }
}

const STAGE_WORD: Record<StewardStageStatus, string> = { done: '完成', running: '进行中', waiting: '等人', failed: '失败', todo: '未开始', skipped: '跳过' }

/**
 * 块内容的一行行文字摘要，回给模型：它据此写不超过 3 句的结论并引用，不用再调查询工具复述同样的数据。
 * 每块一行、每行截断，避免把整张表塞回上下文。
 */
export function describeBlocks(blocks: StewardBlock[], max = 240): string[] {
  const cut = (line: string) => (line.length > max ? `${line.slice(0, max - 1)}…` : line)
  return blocks.map((block) => {
    const head = 'title' in block && block.title ? `${block.title}：` : ''
    switch (block.type) {
      case 'stats':
        return cut(`${head}${block.items.map((i) => `${i.label} ${i.value}${i.unit ?? ''}`).join('，')}`)
      case 'lanes':
        return cut(`${head}${block.rows.map((r) => {
          const cur = r.stages.find((st) => st.status !== 'done' && st.status !== 'skipped')
          const where = r.note ?? (!r.stages.length ? '无阶段' : cur ? `${cur.label}${STAGE_WORD[cur.status]}` : '全部完成')
          return `${r.title}（${where}）`
        }).join('；')}`)
      case 'bars':
        return cut(`${head}${block.items.map((i) => `${i.label} ${i.value}${block.unit ?? ''}`).join('，')}`)
      case 'table':
        return cut(`${head}${block.rows.map((row) => block.columns.map((c) => row[c.key] ?? '—').join(' / ')).join('；')}`)
      case 'checklist':
        return cut(`${head}${block.items.filter((i) => i.done).length}/${block.items.length} 完成；未完成：${block.items.filter((i) => !i.done).map((i) => i.label).join('、') || '无'}`)
      case 'timeline':
        return cut(`${head}${block.items.map((i) => `${i.title}`).join('；')}`)
      case 'callout':
        return cut(`${block.title}${block.body ? `：${block.body}` : ''}`)
      case 'actions':
        return cut(`按钮：${block.items.map((a) => a.label).join('、')}`)
      default:
        return ''
    }
  }).filter(Boolean)
}

async function normalizeBlock(
  raw: unknown,
  path: string,
  ctx: NormalizeBlocksContext,
  issues: string[],
): Promise<StewardBlock | undefined> {
  try {
    if (!isRecord(raw)) {
      issues.push(`${path}：期望对象，收到 ${describe(raw)}，已丢弃`)
      return undefined
    }
    switch (raw.type) {
      case 'stats':
        return { type: 'stats', ...title(raw, path, issues), items: await list(raw.items, `${path}.items`, 6, issues, async (item, itemPath) => {
          if (!isRecord(item)) return drop(itemPath, item, issues)
          const label = text(item.label, `${itemPath}.label`, 40, issues)
          const value = statValue(item.value, `${itemPath}.value`, issues)
          if (label === undefined || value === undefined) return undefined
          return clean({ label, value, unit: text(item.unit, `${itemPath}.unit`, 40, issues, true), tone: tone(item.tone, `${itemPath}.tone`, issues, true), hint: text(item.hint, `${itemPath}.hint`, 80, issues, true), ref: await ref(item.ref, `${itemPath}.ref`, ctx, issues) })
        }) }
      case 'lanes':
        return { type: 'lanes', ...title(raw, path, issues), rows: await list(raw.rows, `${path}.rows`, 12, issues, async (row, rowPath) => {
          if (!isRecord(row)) return drop(rowPath, row, issues)
          const rowTitle = text(row.title, `${rowPath}.title`, 60, issues)
          if (rowTitle === undefined) return undefined
          const stages = await list(row.stages, `${rowPath}.stages`, 12, issues, async (stage, stagePath) => {
            if (!isRecord(stage)) return drop(stagePath, stage, issues)
            const label = text(stage.label, `${stagePath}.label`, 40, issues)
            if (label === undefined) return undefined
            return { label, status: status(stage.status, `${stagePath}.status`, issues) }
          })
          return clean({ title: rowTitle, ref: await ref(row.ref, `${rowPath}.ref`, ctx, issues), stages, note: text(row.note, `${rowPath}.note`, 80, issues, true), tone: tone(row.tone, `${rowPath}.tone`, issues, true) })
        }) }
      case 'bars':
        return { type: 'bars', ...title(raw, path, issues), unit: text(raw.unit, `${path}.unit`, 40, issues, true), items: await list(raw.items, `${path}.items`, 12, issues, async (item, itemPath) => {
          if (!isRecord(item)) return drop(itemPath, item, issues)
          const label = text(item.label, `${itemPath}.label`, 40, issues),
            value = finite(item.value, `${itemPath}.value`, issues)
          if (label === undefined || value === undefined) return undefined
          return clean({ label, value, max: finite(item.max, `${itemPath}.max`, issues, true), tone: tone(item.tone, `${itemPath}.tone`, issues, true), hint: text(item.hint, `${itemPath}.hint`, 80, issues, true), ref: await ref(item.ref, `${itemPath}.ref`, ctx, issues) })
        }) }
      case 'table': {
        const columns = await list(raw.columns, `${path}.columns`, 8, issues, async (column, columnPath) => {
          if (!isRecord(column)) return drop(columnPath, column, issues)
          const key = text(column.key, `${columnPath}.key`, 40, issues),
            label = text(column.label, `${columnPath}.label`, 40, issues)
          if (key === undefined || label === undefined) return undefined
          return clean({ key, label, align: column.align === 'end' ? 'end' as const : column.align === 'start' ? 'start' as const : undefined, mono: typeof column.mono === 'boolean' ? column.mono : undefined })
        })
        const keys = columns.map((column) => column.key)
        const rows = await list(raw.rows, `${path}.rows`, 20, issues, async (row, rowPath) => {
          if (!isRecord(row)) return drop(rowPath, row, issues)
          const out: Record<string, string | number | null> = {}
          for (const key of keys) {
            const value = row[key]
            if (value === null || value === undefined) out[key] = value === null ? null : ''
            else if (typeof value === 'string') out[key] = trim(value, 80, `${rowPath}.${key}`, issues)
            else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
            else {
              issues.push(`${rowPath}.${key}：期望 string|number|null，收到 ${describe(value)}，已按空值处理`)
              out[key] = ''
            }
          }
          return out
        })
        const refs = Array.isArray(raw.refs) ? await list(raw.refs, `${path}.refs`, 20, issues, async (item, itemPath) => item === null ? null : await ref(item, itemPath, ctx, issues)) : undefined
        return clean({ type: 'table' as const, ...title(raw, path, issues), columns, rows, refs })
      }
      case 'checklist':
        return { type: 'checklist', ...title(raw, path, issues), items: await list(raw.items, `${path}.items`, 12, issues, async (item, itemPath) => {
          if (!isRecord(item)) return drop(itemPath, item, issues)
          const label = text(item.label, `${itemPath}.label`, 40, issues)
          if (label === undefined) return undefined
          return clean({ label, done: item.done === true, hint: text(item.hint, `${itemPath}.hint`, 80, issues, true), ref: await ref(item.ref, `${itemPath}.ref`, ctx, issues) })
        }) }
      case 'timeline':
        return { type: 'timeline', ...title(raw, path, issues), items: await list(raw.items, `${path}.items`, 12, issues, async (item, itemPath) => {
          if (!isRecord(item)) return drop(itemPath, item, issues)
          const at = text(item.at, `${itemPath}.at`, 40, issues),
            itemTitle = text(item.title, `${itemPath}.title`, 60, issues)
          if (at === undefined || itemTitle === undefined) return undefined
          return clean({ at, title: itemTitle, detail: text(item.detail, `${itemPath}.detail`, 80, issues, true), tone: tone(item.tone, `${itemPath}.tone`, issues, true), ref: await ref(item.ref, `${itemPath}.ref`, ctx, issues) })
        }) }
      case 'callout': {
        const calloutTitle = text(raw.title, `${path}.title`, 60, issues)
        if (calloutTitle === undefined) return undefined
        return clean({ type: 'callout' as const, tone: tone(raw.tone, `${path}.tone`, issues), title: calloutTitle, body: text(raw.body, `${path}.body`, 240, issues, true) })
      }
      case 'actions':
        return { type: 'actions', items: await list(raw.items, `${path}.items`, 4, issues, async (item, itemPath) => action(item, itemPath, ctx, issues)) }
      default:
        issues.push(`${path}.type：未知块类型 ${describe(raw.type)}，已丢弃`)
        return undefined
    }
  } catch (error) {
    issues.push(`${path}：规范化失败 ${String(error)}，已丢弃`)
    return undefined
  }
}

async function action(raw: unknown, path: string, ctx: NormalizeBlocksContext, issues: string[]): Promise<StewardAction | undefined> {
  if (!isRecord(raw)) return drop(path, raw, issues)
  const label = text(raw.label, `${path}.label`, 40, issues)
  if (label === undefined) return undefined
  const primary = typeof raw.primary === 'boolean' ? raw.primary : undefined
  if (raw.kind === 'ask') {
    const askText = text(raw.text, `${path}.text`, 80, issues)
    return askText === undefined ? undefined : clean({ kind: 'ask' as const, label, text: askText, primary })
  }
  if (raw.kind === 'open') {
    const openRef = await ref(raw.ref, `${path}.ref`, ctx, issues)
    return openRef ? clean({ kind: 'open' as const, label, ref: openRef, primary }) : undefined
  }
  if (raw.kind === 'command') {
    const commandId = text(raw.commandId, `${path}.commandId`, 80, issues)
    if (commandId === undefined) return undefined
    if (!(await safe(ctx.commandExists?.(commandId)))) {
      issues.push(`${path}.commandId：命令 ${commandId} 不在命令表里，已丢弃该按钮`)
      return undefined
    }
    return clean({ kind: 'command' as const, label, commandId, input: isRecord(raw.input) ? raw.input : undefined, primary })
  }
  issues.push(`${path}.kind：期望 ask|open|command，收到 ${describe(raw.kind)}，已丢弃`)
  return undefined
}

async function ref(raw: unknown, path: string, ctx: NormalizeBlocksContext, issues: string[]): Promise<StewardContextRef | undefined> {
  if (raw === undefined || raw === null) return undefined
  if (!isRecord(raw) || !refTypes.has(raw.type as StewardContextRef['type']) || typeof raw.id !== 'string') {
    issues.push(`${path}：期望可见对象引用，收到 ${describe(raw)}，已去掉 ref`)
    return undefined
  }
  const result = clean({
    type: raw.type as StewardContextRef['type'],
    id: trim(raw.id, 80, `${path}.id`, issues),
    spaceId: typeof raw.spaceId === 'string' ? trim(raw.spaceId, 80, `${path}.spaceId`, issues) : undefined,
    parent: typeof raw.parent === 'string' ? trim(raw.parent, 80, `${path}.parent`, issues) : undefined,
    label: text(raw.label, `${path}.label`, 40, issues, true),
  }) as StewardContextRef
  if (!(await safe(ctx.refVisible?.(result)))) {
    issues.push(`${path}：对象不可见或不存在，已去掉 ref，保留文字`)
    return undefined
  }
  return result
}

async function list<T>(raw: unknown, path: string, max: number, issues: string[], map: (item: unknown, path: string) => Promise<T | undefined>): Promise<T[]> {
  if (!Array.isArray(raw)) {
    issues.push(`${path}：期望数组，收到 ${describe(raw)}，已按空数组处理`)
    return []
  }
  if (raw.length > max) issues.push(`${path}：最多 ${max} 项，收到 ${raw.length} 项，已截断`)
  const out: T[] = []
  for (const [index, item] of raw.slice(0, max).entries()) {
    const value = await map(item, `${path}[${index}]`)
    if (value !== undefined) out.push(value)
  }
  return out
}

function title(raw: Record<string, unknown>, path: string, issues: string[]): { title?: string } {
  return clean({ title: text(raw.title, `${path}.title`, 60, issues, true) })
}
function tone(raw: unknown, path: string, issues: string[], optional = false): StewardTone {
  if (raw === undefined && optional) return undefined as unknown as StewardTone
  if (tones.has(raw as StewardTone)) return raw as StewardTone
  issues.push(`${path}：期望 neutral|success|running|waiting|failed|stale，收到 ${describe(raw)}，已按 neutral 处理`)
  return 'neutral'
}
function status(raw: unknown, path: string, issues: string[]): StewardStageStatus {
  if (statuses.has(raw as StewardStageStatus)) return raw as StewardStageStatus
  issues.push(`${path}：期望 done|running|waiting|failed|todo|skipped，收到 ${describe(raw)}，已按 todo 处理`)
  return 'todo'
}
function text(raw: unknown, path: string, max: number, issues: string[], optional = false): string | undefined {
  if (raw === undefined || raw === null) {
    if (!optional) issues.push(`${path}：期望字符串，收到 ${describe(raw)}，已丢弃该项`)
    return undefined
  }
  if (typeof raw !== 'string') {
    issues.push(`${path}：期望字符串，收到 ${describe(raw)}，已丢弃该项`)
    return undefined
  }
  return trim(raw, max, path, issues)
}
function statValue(raw: unknown, path: string, issues: string[]): string | number | undefined {
  if (typeof raw === 'string') return trim(raw, 80, path, issues)
  return finite(raw, path, issues)
}
function finite(raw: unknown, path: string, issues: string[], optional = false): number | undefined {
  if (raw === undefined && optional) return undefined
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  issues.push(`${path}：期望有限数字，收到 ${describe(raw)}，已丢弃该项`)
  return undefined
}
function trim(value: string, max: number, path: string, issues: string[]): string {
  const chars = [...value]
  if (chars.length <= max) return value
  issues.push(`${path}：最多 ${max} 字，收到 ${chars.length} 字，已截断`)
  return chars.slice(0, max).join('')
}
function drop(path: string, raw: unknown, issues: string[]): undefined {
  issues.push(`${path}：期望对象，收到 ${describe(raw)}，已丢弃`)
  return undefined
}
function clean<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key]
  return value
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
async function safe(value: MaybePromise<boolean> | undefined): Promise<boolean> {
  try {
    return value === undefined ? false : await value
  } catch {
    return false
  }
}
function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify([...value].slice(0, 80).join(''))
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return JSON.stringify(value)
  if (Array.isArray(value)) return `数组(${value.length})`
  return '对象'
}
