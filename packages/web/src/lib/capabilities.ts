import { Braces, Cable, CircleDollarSign, Gauge, History, Plug, Shield, Shrink, Wrench, type LucideIcon } from 'lucide-react'
import type { HarnessCapabilities, HarnessInfo, ProviderProtocol } from '@taktflow/core'

export interface CapabilityMeta {
  key: keyof HarnessCapabilities
  label: string
  icon: LucideIcon
  /** 支持时的含义。 */
  on: string
  /** 不支持时引擎怎么降级（docs/design/13 的能力表）。 */
  off: string
}

export const CAPABILITIES: CapabilityMeta[] = [
  { key: 'resume', label: '续会话', icon: History, on: '能接着上一轮会话继续', off: "session: 'resume' 退化为新会话，并注入上一轮的产物清单" },
  { key: 'structuredOutput', label: '结构化输出', icon: Braces, on: '原生按 JSON Schema 输出', off: '从最终文本里提取 ```json 代码块再校验' },
  { key: 'toolEvents', label: '工具事件', icon: Wrench, on: '报告每次工具调用，Trace 完整', off: 'Trace 只记录最终结果，"计划读 vs 实际读"不可用' },
  { key: 'usage', label: 'Token 用量', icon: Gauge, on: '报告真实 token 用量', off: '按字符估算 token，并标注为估算' },
  { key: 'cost', label: '成本', icon: CircleDollarSign, on: '直接报告成本', off: '按模型表里的单价换算成本' },
  { key: 'compactionEvents', label: '压缩事件', icon: Shrink, on: '报告上下文压缩', off: '压缩时间线为空，账本标注"不报告压缩"' },
  { key: 'customProvider', label: '自定义模型', icon: Plug, on: '能把模型指到别家 LLM API', off: '只能用该 harness 自带的模型' },
  { key: 'sandbox', label: '沙箱', icon: Shield, on: '自带沙箱 / 权限模式', off: '依赖 takt 的写权限守卫（事后 diff）' },
  { key: 'mcp', label: 'MCP', icon: Cable, on: '支持 MCP，知识层可直接挂载', off: '知识层改为预取注入 + takt kb query' },
]

export const HARNESS_SOURCE: Record<HarnessInfo['source'], { label: string; hint: string; color: string }> = {
  builtin: { label: '内置', hint: '内置适配器：解析该 CLI 的结构化事件流', color: 'var(--c-1)' },
  cli: { label: '声明式 CLI', hint: 'takt.config.json 里声明命令模板和输出映射，零代码接入', color: 'var(--c-4)' },
  plugin: { label: '插件', hint: '由插件（definePlugin）提供', color: 'var(--c-6)' },
  native: { label: 'native', hint: 'takt 自带的轻量 agent loop，直连任意 LLM API', color: 'var(--c-3)' },
  acp: { label: 'ACP', hint: '通过 Agent Client Protocol 接入：任何支持 ACP 的 agent，配一条启动命令即可', color: 'var(--c-2)' },
}

const PROTOCOL_COLOR: Record<string, string> = {
  'openai-chat': 'var(--c-3)',
  'openai-responses': 'var(--c-2)',
  'anthropic-messages': 'var(--c-4)',
  gemini: 'var(--c-1)',
}
export const protocolColor = (p: ProviderProtocol): string => PROTOCOL_COLOR[p] ?? 'var(--c-7)'
