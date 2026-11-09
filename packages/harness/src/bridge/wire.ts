// 外部协议允许厂商扩展字段；只在协议边界使用动态对象，内部流用判别联合。
export type Wire = Record<string, any>
export type StreamEvent =
  | { type: 'text' | 'thinking'; text: string }
  | { type: 'tool'; index: number; id: string; name: string }
  | { type: 'arguments'; index: number; text: string }
  | { type: 'signature'; text: string }
  | { type: 'usage'; input?: number; output?: number; cached?: number; reasoning?: number }
  | { type: 'error'; message: string }
  | { type: 'finish'; reason: 'end_turn' | 'tool_use' | 'max_tokens' }
/** namespaces：展平后的函数名 → Codex 的命名空间与原名（MCP 工具分组，不同组可以同名）。 */
export interface BridgeRequest { messages: Wire[]; tools: Wire[]; custom: Set<string>; namespaces: Map<string, { namespace: string; name: string }>; options: Wire }
export const marker = 'takt-bridge-v1:'
export function encodeThinking(text: string, signature = ''): string {
  return marker + Buffer.from(JSON.stringify({ text, signature })).toString('base64url')
}
export function decodeThinking(value: unknown): { text: string; signature: string } | undefined {
  if (typeof value !== 'string' || !value.startsWith(marker)) return undefined
  try { const parsed = JSON.parse(Buffer.from(value.slice(marker.length), 'base64url').toString()); return typeof parsed.text === 'string' ? parsed : undefined } catch { return undefined }
}
export function contentText(content: any): string {
  return typeof content === 'string' ? content : Array.isArray(content) ? content.map(p => p.text ?? '').join('\n') : JSON.stringify(content ?? '')
}
