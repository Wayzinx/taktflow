export interface Cron { fields: Set<number>[]; dayWildcard: boolean; weekWildcard: boolean }
const bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const
const names = ['分', '时', '日', '月', '周']
export function parseCron(expression: string): Cron {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error('cron 必须是 5 段（分 时 日 月 周），请修正表达式')
  const fields = parts.map((part, i) => {
    const [min, max] = bounds[i]!, values = new Set<number>()
    const invalid = (): never => { throw new Error(`cron 第 ${i + 1} 段（${names[i]}）不合法，请使用 ${min}–${max} 范围内的数字、*、a-b、*/n 或逗号列表`) }
    for (const item of part.split(',')) {
      let from: number, to: number, step = 1
      if (item === '*') { from = min; to = max }
      else if (/^\*\/\d+$/.test(item)) { from = min; to = max; step = Number(item.slice(2)); if (step < 1 || step > max - min + 1) invalid() }
      else if (/^\d+-\d+$/.test(item)) { [from, to] = item.split('-').map(Number) as [number, number] }
      else if (/^\d+$/.test(item)) { from = to = Number(item) }
      else return invalid()
      if (from < min || to > max || from > to) invalid()
      for (let value = from; value <= to; value += step) values.add(i === 4 && value === 7 ? 0 : value)
    }
    return values
  })
  return { fields, dayWildcard: parts[2]!.startsWith('*'), weekWildcard: parts[4]!.startsWith('*') }
}
export function cronMatches(cron: Cron | string, date: Date): boolean {
  const c = typeof cron === 'string' ? parseCron(cron) : cron
  const [minute, hour, day, month, week] = c.fields
  const days = c.dayWildcard || c.weekWildcard ? day!.has(date.getDate()) && week!.has(date.getDay()) : day!.has(date.getDate()) || week!.has(date.getDay())
  return minute!.has(date.getMinutes()) && hour!.has(date.getHours()) && month!.has(date.getMonth() + 1) && days
}
export function nextCronAt(expression: string, after = new Date()): string | undefined {
  const cron = parseCron(expression), next = new Date(after)
  next.setSeconds(0, 0); next.setTime(next.getTime() + 60_000)
  const end = new Date(after); end.setFullYear(end.getFullYear() + 8)
  // 跳过不匹配的日期；分钟以真实时间推进，夏令时跳时与重复小时都按本机时区判断。
  while (next <= end) {
    if (!cron.fields[3]!.has(next.getMonth() + 1)) { next.setDate(1); next.setMonth(next.getMonth() + 1); next.setHours(0, 0, 0, 0); continue }
    if (cronMatches(cron, next)) return next.toISOString()
    const day = cron.fields[2]!.has(next.getDate()), week = cron.fields[4]!.has(next.getDay())
    if (!(cron.dayWildcard || cron.weekWildcard ? day && week : day || week)) { next.setDate(next.getDate() + 1); next.setHours(0, 0, 0, 0) }
    else next.setTime(next.getTime() + 60_000)
  }
  return undefined
}
