import type { HarnessInfo, TaktConfig } from '@taktflow/core'
import { ACP_PRESETS } from './acp/presets.js'

const brands: Record<string, [string, string?]> = {
  'claude-code': ['claude', '使用个人 Claude 订阅'], claude: ['claude', '使用个人 Claude 订阅'],
  codex: ['codex', '使用 ChatGPT 账号'], trae: ['trae', '使用 TRAE 额度'],
  pi: ['pi', '使用 Pi 已配置的模型'], dsh: ['dsh', '使用 DeepSeek 账号'],
  'gemini-cli': ['gemini', '使用 Google 账号'], gemini: ['gemini', '使用 Google 账号'],
  'cursor-agent': ['cursor', '使用 Cursor 账号'], 'qwen-code': ['qwen', '使用 Qwen 账号'], qwen: ['qwen', '使用 Qwen 账号'],
  'kimi-cli': ['kimi', '使用 Kimi 账号'], kimi: ['kimi', '使用 Kimi 账号'],
  opencode: ['opencode', '使用 OpenCode 已配置的模型'], goose: ['goose', '使用 Goose 已配置的模型'],
  copilot: ['copilot', '使用 GitHub Copilot 账号'], hermes: ['hermes', '使用 Hermes 已配置的模型'],
  openclaw: ['openclaw', '使用 OpenClaw 已配置的模型'], native: ['takt'],
}

export function harnessCatalogInfo(info: HarnessInfo, config: TaktConfig): HarnessInfo {
  const custom = config.harnesses?.find(h => h.id === info.id)
  const preset = custom?.kind === 'acp' ? custom.preset : undefined
  const brand = custom?.kind === 'cli' || info.source === 'cli' ? undefined : brands[preset ?? info.id]
  const hidden = config.harnessOverrides?.[info.id]?.disabled === true
  const available = info.available && !hidden
  const install = ACP_PRESETS.find(p => p.id === preset)?.install
    ?? (brand && info.id !== 'native' ? `请安装 ${info.displayName}，将可执行文件加入 PATH 并完成登录` : undefined)
  return { ...info, available, ...(hidden ? { reason: '本空间已停用' } : {}), ...(info.id === 'native' ? { displayName: '直连 API（内置）' } : {}),
    ...(brand ? { icon: brand[0], ...(brand[1] ? { ownLabel: brand[1] } : {}) } : {}),
    ...(!available && install ? { install } : {}),
    hidden, testOnly: info.id === 'mock' || info.testOnly === true }
}
