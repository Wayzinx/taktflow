import type { HarnessInfo } from '@taktflow/core'
import { harnessIconKey } from '../components/brand/brand-icon'

/** server 将来在 HarnessInfo 上补的展示字段（docs/design/32 §5）；没给时前端按 id 兜底。 */
type Meta = Pick<HarnessInfo, 'id' | 'displayName' | 'source'> & Partial<Pick<HarnessInfo, 'command' | 'custom'>> & { icon?: string; ownLabel?: string; testOnly?: boolean }

/** 不选 provider 时，harness 用的是谁的账号 / 额度。 */
const OWN: Record<string, string> = {
  'claude-code': '使用个人 Claude 订阅', claude: '使用个人 Claude 订阅', codex: '使用 ChatGPT 账号', trae: '使用 TRAE 额度',
  pi: '使用 Pi 已配置的模型', dsh: '使用 DeepSeek 账号', 'gemini-cli': '使用 Google 账号', gemini: '使用 Google 账号',
  'cursor-agent': '使用 Cursor 账号', 'qwen-code': '使用 Qwen 账号', qwen: '使用 Qwen 账号', 'kimi-cli': '使用 Kimi 账号', kimi: '使用 Kimi 账号',
  opencode: '使用 OpenCode 已配置的模型', goose: '使用 Goose 已配置的模型', copilot: '使用 GitHub Copilot 订阅',
}

/** ACP 条目从启动命令认出是哪个 agent（自定义条目的 HarnessInfo 不带 preset）。 */
const ACP_AGENTS: Array<[RegExp, string, string]> = [
  [/claude-agent-acp|claude-code-acp/, 'claude', 'Claude Code'], [/codex-acp/, 'codex', 'Codex'], [/gemini-cli|\bgemini\b/, 'gemini', 'Gemini CLI'],
  [/qwen-code|\bqwen\b/, 'qwen', 'Qwen Code'], [/\bopencode\b/, 'opencode', 'OpenCode'], [/\bkimi\b/, 'kimi', 'Kimi CLI'],
  [/\bgoose\b/, 'goose', 'Goose'], [/copilot/, 'copilot', 'GitHub Copilot'],
]

export function acpAgent(h: Meta): { preset: string; name: string } | undefined {
  if (h.source !== 'acp') return undefined
  const command = h.command?.join(' ') ?? ''
  const hit = ACP_AGENTS.find(([re]) => re.test(command))
  return hit ? { preset: hit[1], name: hit[2] } : undefined
}

/** 只给测试用的替身，不进目录和选择器。 */
export const isTestOnly = (h: Meta) => h.testOnly ?? h.id === 'mock'

export function harnessMeta(h: Meta): { name: string; own?: string; icon?: string; note?: string } {
  const acp = acpAgent(h)
  const icon = harnessIconKey({ id: h.id, icon: h.icon, preset: acp?.preset })
  if (h.id === 'native' || h.source === 'native') {
    return { name: '直连 API（内置）', icon: 'takt', note: 'taktflow 自带的最小 agent 循环，不经外部 CLI，直接调接入的 LLM API' }
  }
  if (isTestOnly(h)) return { name: '测试替身（mock）', icon, note: '按脚本回放事件、不调模型，只给自动化测试用' }
  // 同一个 agent 走 ACP 时说明是接法不同，不是另一个 harness
  const name = acp && h.source === 'acp' && !h.displayName.includes('ACP') ? `${acp.name} · ACP 接法` : acp?.preset === 'claude' ? 'Claude Code · ACP 接法' : h.displayName
  return { name, icon, own: h.ownLabel ?? OWN[h.id] ?? (acp ? OWN[acp.preset] : undefined) }
}
