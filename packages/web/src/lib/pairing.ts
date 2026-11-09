import type { Pairing, ProviderProtocol } from '@taktflow/core'

/** 协议的短名：在搭配说明里用（「DeepSeek（Chat）」）。 */
export const PROTOCOL_SHORT: Record<ProviderProtocol, string> = {
  'openai-chat': 'Chat',
  'openai-responses': 'Responses',
  'anthropic-messages': 'Anthropic',
  gemini: 'Gemini',
}

/** "直连 · Anthropic" / "桥接 · Responses ← Chat" / "自带" */
export function pairingText(p: Pairing): string {
  if (p.mode === 'builtin') return '自带'
  if (p.mode === 'direct') return `直连 · ${p.protocol ? PROTOCOL_SHORT[p.protocol] : ''}`
  if (p.mode === 'bridge') return `桥接 · ${p.protocol ? PROTOCOL_SHORT[p.protocol] : '?'} ← ${p.upstream ? PROTOCOL_SHORT[p.upstream] : '?'}`
  return '不可用'
}
