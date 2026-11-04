import { execFile } from 'node:child_process'
import { isAbsolute, resolve, extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { validateWorkflow } from './workflow.js'
import type { HarnessAdapter, KnowledgeSource, TaktConfig, TaktPlugin, WorkflowDefinition } from '../types.js'

export type PluginImporter = (url: string) => Promise<{ default?: unknown }>
export interface LoadedPlugins {
  names: string[]
  harnesses: Record<string, HarnessAdapter>
  providers: NonNullable<TaktPlugin['providers']>
  knowledge: KnowledgeSource[]
  workflows: WorkflowDefinition[]
  roles: Record<string, string>
}

const execute = promisify(execFile)

async function pluginURL(entry: string, projectDir: string): Promise<string> {
  if (isAbsolute(entry) || entry.startsWith('.')) return pathToFileURL(resolve(projectDir, entry)).href
  // require.resolve 使用 require 条件，会拒绝只有 exports.import 的包。子进程仅解析 URL，不执行插件。
  const { stdout } = await execute(process.execPath, [
    '--experimental-import-meta-resolve', '--input-type=module', '--eval',
    'process.stdout.write(import.meta.resolve(process.argv[1], process.argv[2]))',
    entry, pathToFileURL(resolve(projectDir, 'takt.config.json')).href,
  ], { timeout: 10_000 })
  return stdout
}

export async function loadPlugins(config: TaktConfig, projectDir: string, importer?: PluginImporter): Promise<LoadedPlugins> {
  const result: LoadedPlugins = {
    names: [], harnesses: Object.create(null), providers: Object.create(null), knowledge: [], workflows: [], roles: Object.create(null),
  }
  const seen = new Map<string, Set<string>>()
  const claim = (kind: string, name: string) => {
    if (typeof name !== 'string' || !name.trim()) throw new Error(`插件 ${kind} 名称必须是非空字符串`)
    const names = seen.get(kind) ?? new Set<string>()
    if (names.has(name)) throw new Error(`插件 ${kind} 名称冲突：${name}`)
    names.add(name)
    seen.set(kind, names)
  }
  for (const entry of config.plugins ?? []) {
    try {
      const url = await pluginURL(entry, projectDir)
      if (/\.[cm]?ts$/.test(extname(new URL(url).pathname)) && !importer) throw new Error('TypeScript 插件需要注入 importer')
      const module = await (importer ? importer(url) : import(url)) as { default?: unknown }
      const plugin = module.default as TaktPlugin | undefined
      if (!plugin || typeof plugin !== 'object') throw new Error('插件必须 default 导出 TaktPlugin')
      if (plugin.apiVersion !== 1) throw new Error('插件 apiVersion 必须为 1')
      claim('plugin', plugin.name)
      result.names.push(plugin.name)
      for (const item of plugin.harnesses ?? []) {
        const harness = typeof item === 'function' ? item({ config, projectDir }) : item
        claim('harness', harness.id)
        if (typeof harness.run !== 'function' || typeof harness.available !== 'function') throw new Error(`插件 harness 格式错误：${harness.id}`)
        result.harnesses[harness.id] = harness
      }
      for (const [id, factory] of Object.entries(plugin.providers ?? {})) {
        claim('provider', id)
        if (typeof factory !== 'function') throw new Error(`插件 provider 必须是工厂：${id}`)
        result.providers[id] = factory
      }
      for (const factory of plugin.knowledge ?? []) {
        const source = factory({ projectDir })
        claim('knowledge', source.id)
        if (typeof source.query !== 'function') throw new Error(`插件 knowledge 格式错误：${source.id}`)
        result.knowledge.push(source)
      }
      for (const workflow of plugin.workflows ?? []) {
        claim('workflow', workflow.id)
        validateWorkflow(workflow)
        result.workflows.push(workflow)
      }
      for (const [role, markdown] of Object.entries(plugin.roles ?? {})) {
        claim('role', role)
        if (typeof markdown !== 'string') throw new Error(`插件 role 必须是 markdown：${role}`)
        result.roles[role] = markdown
      }
    } catch (error) {
      throw new Error(`加载插件 ${entry} 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return result
}
