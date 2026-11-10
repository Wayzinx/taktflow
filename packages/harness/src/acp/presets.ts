import type { AcpHarnessConfig, AcpPresetInfo } from '@taktflow/core'
import { qwenProvider, hermesProvider, type ProviderInjector } from '../provider-injection.js'
import { claudeProviderEnv } from '../claude-env.js'
import { readProviderApiKey } from '../parse.js'

// 既有预设在 2026-11-08 核对官方 registry；Hermes / OpenClaw / Qwen 的源码证据见 m8-pairing-verify。
// 探测时不自动下载 agent。
// https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
export const ACP_PRESETS: AcpPresetInfo[] = [
  { id: 'hermes', displayName: 'Hermes Agent', command: ['hermes-acp'], install: '按 https://github.com/NousResearch/hermes-agent 的 ACP 安装说明安装含 ACP 依赖的版本，再运行 hermes-acp --check' },
  { id: 'openclaw', displayName: 'OpenClaw', command: ['openclaw', 'acp'], install: 'npm install -g openclaw；先配置并启动 OpenClaw Gateway，再运行 openclaw acp' },
  { id: 'gemini', displayName: 'Gemini CLI', command: ['npx', '--no-install', '@google/gemini-cli@0.67.0', '--acp'], install: 'npm install -g @google/gemini-cli@0.67.0；先完成 Gemini 登录' },
  { id: 'claude', displayName: 'Claude Agent ACP', command: ['npx', '--no-install', '@agentclientprotocol/claude-agent-acp@0.101.0'], install: 'npm install -g @agentclientprotocol/claude-agent-acp@0.101.0；按项目文档配置认证' },
  { id: 'codex', displayName: 'Codex ACP', command: ['npx', '--no-install', '@agentclientprotocol/codex-acp@2.5.0'], install: 'npm install -g @agentclientprotocol/codex-acp@2.5.0；先完成 Codex 登录' },
  { id: 'opencode', displayName: 'OpenCode', command: ['opencode', 'acp'], install: '从 https://github.com/anomalyco/opencode/releases 安装适合本机的二进制并加入 PATH（核对版本 2.2.6）' },
  { id: 'qwen', displayName: 'Qwen Code', command: ['npx', '--no-install', '@qwen-code/qwen-code@0.27.1', '--acp', '--experimental-skills'], install: 'npm install -g @qwen-code/qwen-code@0.27.1；先完成 Qwen 登录' },
  { id: 'kimi', displayName: 'Kimi CLI（Legacy）', command: ['kimi', 'acp'], install: '从 https://github.com/MoonshotAI/kimi-cli/releases 安装 1.52.0 对应二进制并加入 PATH；官方已归档，新用户可自定义 Kimi Code 命令' },
  { id: 'goose', displayName: 'Goose', command: ['goose', 'acp'], install: '从 https://github.com/block/goose/releases 安装适合本机的二进制并加入 PATH（核对版本 1.57.0）' },
  { id: 'copilot', displayName: 'GitHub Copilot', command: ['npx', '--no-install', '@github/copilot@1.0.107', '--acp'], install: 'npm install -g @github/copilot@1.0.107；先完成 GitHub 登录' },
]

/** 能改接别家模型 API 的预设：接哪些协议、怎么注入（只登记真跑或官方源码核实过的）。 */
export const ACP_PROVIDER_ENV: Record<string, ProviderInjector> = {
  claude: { protocols: ['anthropic-messages'], async prepare(req) { return { env: claudeProviderEnv(req, readProviderApiKey(req).value) } } },
  qwen: qwenProvider,
  hermes: hermesProvider,
  // openclaw acp 只连已有 Gateway，子进程配置不能替换 Gateway 的 provider。
}

/** 建会话时附带的预设专属参数。claude：和 CLI 一样不加载个人 ~/.claude 设置（适配器把 _meta.claudeCode.options 盖在默认值上）。 */
export function acpSessionMeta(preset: string | undefined, env: Record<string, string> | undefined): Record<string, unknown> | undefined {
  if (preset !== 'claude') return undefined
  const sources = (env?.TAKT_CLAUDE_SETTING_SOURCES ?? process.env.TAKT_CLAUDE_SETTING_SOURCES ?? 'project,local').split(',').map(s => s.trim()).filter(Boolean)
  return { claudeCode: { options: { settingSources: sources } } }
}

export function acpCommand(config: AcpHarnessConfig): string[] {
  const preset = ACP_PRESETS.find(item => item.id === config.preset)
  const command = config.command ?? preset?.command
  if (!command?.length || command.some(part => typeof part !== 'string') || !command[0]?.trim()) {
    throw new Error('ACP 缺少有效启动命令，请选择已知 preset 或填写 command 数组')
  }
  return [...command]
}
