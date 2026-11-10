import type { CatalogModel, Effort } from '@taktflow/core'
import { object } from './parse.js'
import { runProcess } from './process.js'

const efforts: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const effort = (value: unknown): Effort | undefined => efforts.includes(value as Effort) ? value as Effort : undefined

export function parseCodexModels(output: string): CatalogModel[] {
  const data = object(JSON.parse(output))
  if (!Array.isArray(data.models)) throw new Error('Codex 模型列表缺少 models 数组')
  return data.models.flatMap(value => {
    const row = object(value)
    if (row.visibility !== 'list') return []
    if (typeof row.slug !== 'string' || !row.slug.trim()) throw new Error('Codex 模型列表缺少 slug')
    const levels = Array.isArray(row.supported_reasoning_levels)
      ? [...new Set(row.supported_reasoning_levels.map(v => effort(object(v).effort)).filter((v): v is Effort => !!v))] : []
    const selected = effort(row.default_reasoning_level)
    return [{ id: row.slug, label: typeof row.display_name === 'string' ? row.display_name : row.slug,
      ...(typeof row.context_window === 'number' && row.context_window > 0 ? { contextWindow: row.context_window } : {}),
      ...(levels.length ? { reasoning: true, efforts: levels, ...(selected && levels.includes(selected) ? { defaultEffort: selected } : {}) } : {}), origin: 'harness' as const }]
  })
}

export function parseTraeModels(output: string): CatalogModel[] {
  const lines = output.trim().split(/\r?\n/)
  // 本机 models 输出为每行一个 ID；拒绝标题、表格或诊断文本，避免把它们当模型。
  if (!lines.length || lines.some(line => !/^[\w][\w./:-]*$/.test(line))) throw new Error('TRAE 模型列表格式不正确')
  return [...new Set(lines)].map(id => ({ id, label: id, origin: 'harness' }))
}

export async function listCliModels(bin: string, args: string[], env?: Record<string, string>): Promise<string> {
  const proc = await runProcess(bin, args, { prompt: '', cwd: process.cwd(), env: { ...env, TAKT_TRANSCRIPT: '' }, timeoutMs: 20_000 })
  if (!proc.ok) throw new Error(proc.error || '列出自带模型失败；请检查命令和登录状态')
  return proc.stdout
}

export async function listClaudeModels(bin: string, env?: Record<string, string>): Promise<CatalogModel[]> {
  const help = await listCliModels(bin, ['--help'], env)
  const supportsEffort = /(?:^|\s)--effort(?:\s|=)/m.test(help)
  return ['opus', 'sonnet', 'haiku'].map(id => ({ id,
    label: `${id[0]!.toUpperCase()}${id.slice(1)}（订阅默认最新）`, origin: 'harness',
    ...(supportsEffort ? { reasoning: true, efforts: [...efforts], defaultEffort: 'high' } : {}) }))
}
