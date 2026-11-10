import type { CatalogModel, Effort } from '@taktflow/core'
import { execFile } from 'node:child_process'
import { object } from './parse.js'

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

/** 只读一次命令输出、只看退出码：runProcess 会把输出里的 overloaded / sign in / timeout 当报错，而 claude --help、codex 模型说明里正好有这些词。 */
export function listCliModels(bin: string, args: string[], env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env: { ...process.env, ...env }, timeout: 20_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout)
      const detail = String(stderr).trim().split(/\r?\n/).slice(-2).join(' ') || error.message
      reject(new Error(`列出自带模型失败：${detail}`))
    })
  })
}

export async function listClaudeModels(bin: string, env?: Record<string, string>): Promise<CatalogModel[]> {
  const help = await listCliModels(bin, ['--help'], env)
  const supportsEffort = /(?:^|\s)--effort(?:\s|=)/m.test(help)
  return ['opus', 'sonnet', 'haiku'].map(id => ({ id,
    label: `${id[0]!.toUpperCase()}${id.slice(1)}（订阅默认最新）`, origin: 'harness',
    ...(supportsEffort ? { reasoning: true, efforts: [...efforts], defaultEffort: 'high' } : {}) }))
}
