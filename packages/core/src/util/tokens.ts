export function estimateTokens(value: string | Uint8Array): number {
  const text = typeof value === 'string' ? value : Buffer.from(value).toString('utf8')
  return Math.ceil(text.length / 4)
}
