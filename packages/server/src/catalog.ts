import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { loadProfiles, type CliHarnessConfig, type HarnessInfo, type ModelInfo, type ProjectStores } from '@taktflow/core'

async function available(config: CliHarnessConfig, projectDir: string): Promise<{ available: boolean; reason?: string }> {
  if (config.available?.length) {
    return new Promise((resolve) => {
      execFile(config.available![0]!, config.available!.slice(1), { cwd: projectDir, env: { ...process.env, ...config.env }, timeout: 3000, maxBuffer: 64 * 1024 }, (error) => {
        resolve(error ? { available: false, reason: '配置的可用性检查未通过或超时' } : { available: true })
      })
    })
  }
  const command = config.command[0]
  if (!command || command.includes('{{')) return { available: false, reason: '无法确定可执行文件' }
  const candidates = command.includes('/') ? [path.resolve(projectDir, command)] : (config.env?.PATH ?? process.env.PATH ?? '').split(path.delimiter).map((dir) => path.resolve(projectDir, dir, command))
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return { available: true, reason: '仅确认可执行文件存在；未配置登录或连通性检查' } } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  }
  return { available: false, reason: '未找到可执行文件' }
}

export async function harnesses(stores: ProjectStores): Promise<HarnessInfo[]> {
  const profiles = await loadProfiles(stores.taktDir)
  const roles = { ...stores.config.roles }
  for (const [role, profile] of Object.entries(profiles)) roles[role] = profile.harness
  const configured = new Map((stores.config.harnesses ?? []).map((item) => [item.id, item]))
  const ids = new Set(['claude-code', 'codex', 'dsh', 'mock', ...configured.keys(), ...Object.values(roles).map((selector) => selector.harness)])
  return Promise.all([...ids].map(async (id): Promise<HarnessInfo> => {
    const config = configured.get(id)
    return {
      id, displayName: config?.displayName ?? id,
      source: config ? 'cli' : id === 'native' ? 'native' : ['claude-code', 'codex', 'dsh', 'mock'].includes(id) ? 'builtin' : 'plugin',
      ...(config ? await available(config, stores.projectDir) : { available: false, reason: 'server 未接入运行时 harness 注册表，无法探测适配器可用性' }),
      capabilities: config?.capabilities ?? {}, roles: Object.entries(roles).filter(([, selector]) => selector.harness === id).map(([role]) => role),
    }
  }))
}

export function models(stores: ProjectStores): ModelInfo[] {
  return Object.entries(stores.config.models ?? {}).map(([alias, model]) => {
    const provider = stores.config.providers?.[model.provider]
    if (!provider) throw new Error(`模型 ${alias} 引用了不存在的 provider：${model.provider}`)
    return { alias, provider: model.provider, protocol: provider.protocol, id: model.id, contextWindow: model.contextWindow, price: model.price ? { input: model.price.input, output: model.price.output } : undefined, keyPresent: !!(provider.apiKeyEnv && process.env[provider.apiKeyEnv]) }
  })
}
