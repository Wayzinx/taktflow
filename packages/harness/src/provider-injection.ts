import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HarnessRequest, ProviderProtocol } from '@taktflow/core'
import { readProviderApiKey } from './parse.js'

export interface ProviderInjection {
  env: Record<string, string>
  args?: string[]
  cleanup?: () => Promise<void>
}

export interface ProviderInjector {
  protocols: ProviderProtocol[]
  prepare(req: HarnessRequest): Promise<ProviderInjection>
}

function credentials(req: HarnessRequest, protocols: ProviderProtocol[]): string {
  if (!req.provider || !protocols.includes(req.provider.protocol)) throw new Error('不支持此 provider 协议')
  if (!req.model?.trim() || !req.provider.baseURL?.trim()) throw new Error('改接模型 API 需要 model 和 baseURL')
  const key = readProviderApiKey(req)
  if (key.name && !key.value) throw new Error(`缺少模型 API 密钥：${key.name}`)
  return key.value ?? 'takt-no-api-key'
}

// JSON 是 YAML 的子集；文件只含环境变量名，创建失败也回收目录。
export async function temporaryConfig(prefix: string, filename: string, config: unknown) {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  const cleanup = () => rm(directory, { recursive: true, force: true })
  try {
    const file = join(directory, filename)
    await writeFile(file, JSON.stringify(config), { mode: 0o600 })
    return { directory, file, cleanup }
  } catch (error) { await cleanup(); throw error }
}

export const openCodeProvider: ProviderInjector = {
  protocols: ['openai-chat', 'anthropic-messages'],
  async prepare(req) {
    const token = credentials(req, this.protocols)
    const name = 'takt-runtime'
    const npm = req.provider!.protocol === 'anthropic-messages' ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible'
    return { env: { TAKT_OPENCODE_API_KEY: token, OPENCODE_CONFIG_CONTENT: JSON.stringify({
      provider: { [name]: { npm, name, options: { baseURL: req.provider!.baseURL, apiKey: '{env:TAKT_OPENCODE_API_KEY}' },
        models: { [req.model!]: { name: req.model } } } }, model: `${name}/${req.model}`,
    }) }, args: ['--model', `${name}/${req.model}`] }
  },
}

export const qwenProvider: ProviderInjector = {
  protocols: ['openai-chat', 'openai-responses', 'anthropic-messages'],
  async prepare(req) {
    const token = credentials(req, this.protocols)
    const anthropic = req.provider!.protocol === 'anthropic-messages'
    const auth = anthropic ? 'anthropic' : req.provider!.protocol === 'openai-responses' ? 'openai-responses' : 'openai'
    const prefix = anthropic ? 'ANTHROPIC' : 'OPENAI'
    // 隔离 ACP 的认证/模型持久化；bare 防止项目的 modelProviders 覆盖本次环境变量。
    const temp = await temporaryConfig('takt-qwen-', 'settings.json', {})
    return { env: { QWEN_HOME: temp.directory, [`${prefix}_API_KEY`]: token,
      [`${prefix}_BASE_URL`]: req.provider!.baseURL!, [`${prefix}_MODEL`]: req.model! },
      args: ['--bare', '--auth-type', auth, '--model', req.model!], cleanup: temp.cleanup }
  },
}

export const hermesProvider: ProviderInjector = {
  protocols: ['openai-chat'],
  async prepare(req) {
    const token = credentials(req, this.protocols)
    const temp = await temporaryConfig('takt-hermes-', 'config.yaml', {
      model: { provider: 'custom:takt-runtime', default: req.model },
      providers: { 'takt-runtime': { name: 'takt-runtime', base_url: req.provider!.baseURL,
        key_env: 'TAKT_HERMES_API_KEY', api_mode: 'chat_completions' } },
    })
    return { env: { HERMES_HOME: temp.directory, TAKT_HERMES_API_KEY: token }, cleanup: temp.cleanup }
  },
}

export const dshProvider: ProviderInjector = {
  protocols: ['openai-chat', 'openai-responses', 'anthropic-messages'],
  async prepare(req) {
    const token = req.provider ? credentials(req, this.protocols) : undefined
    const apis: Record<string, string> = { 'openai-chat': 'openai-completions', 'openai-responses': 'openai-responses', 'anthropic-messages': 'anthropic-messages' }
    const defaults = { provider: req.provider ? 'takt-runtime' : 'deepseek-account',
      ...(req.model ? { model: req.model } : {}), ...(req.effort ? { reasoningEffort: req.effort } : {}) }
    const patches = [
      { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: defaults },
      ...(req.provider ? [{ id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: {
        'takt-runtime': { api: apis[req.provider.protocol], baseURL: req.provider.baseURL, apiKeyEnv: 'TAKT_DSH_API_KEY',
          models: [{ id: req.model, ...(req.modelConfig?.contextWindow ? { contextWindow: req.modelConfig.contextWindow } : {}) }] },
      } } }] : []),
    ]
    const temp = await temporaryConfig('takt-dsh-', 'patch.yml', patches)
    return { args: ['--patch', temp.file], env: { ...(token === undefined ? {} : { TAKT_DSH_API_KEY: token }) }, cleanup: temp.cleanup }
  },
}
