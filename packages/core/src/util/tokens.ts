export function estimateTokens(value: string | Uint8Array): number {
  const text = typeof value === 'string' ? value : Buffer.from(value).toString('utf8')
  const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff01-\uff60\uffe0-\uffee]/gu) ?? []
  return cjk.length + Math.ceil((text.length - cjk.reduce((length, char) => length + char.length, 0)) / 4)
}
