export function optionalNumber(s: string): number | undefined {
  return s.trim() === '' ? undefined : Number(s)
}
export function invalidNumber(s: string, kind: 'price' | 'integer'): boolean {
  const n = optionalNumber(s)
  if (n === undefined) return false
  return kind === 'integer' ? !Number.isSafeInteger(n) || n <= 0 : !Number.isFinite(n) || n < 0
}
