const pad = (n: number) => String(n).padStart(2, '0')

/** HH:MM；不是今天时前面带月-日。 */
export function hm(ts: string | undefined): string {
  if (!ts) return ''
  const d = new Date(ts)
  const today = new Date().toDateString() === d.toDateString()
  return `${today ? '' : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} `}${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** "等了 5 小时" 这类时长，不带"前"。 */
export function since(ts: string): string {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(ts)) / 60000))
  if (min < 60) return `${min} 分钟`
  const h = Math.round(min / 60)
  return h < 24 ? `${h} 小时` : `${Math.round(h / 24)} 天`
}
