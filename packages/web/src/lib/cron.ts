/**
 * 5 段 cron（分 时 日 月 周）的解析、下一次时间和人话描述（docs/design/30 §4）。
 * 语法与服务端 packages/core/src/automations/cron.ts 一致：*、数字、a-b、星号/n、逗号列表；周 0 和 7 都是周日。
 * 前端只用来预览，真正的触发以服务端为准（AutomationView.nextAt）。
 */

const BOUNDS = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
] as const
const NAMES = ['分', '时', '日', '月', '周']
const WEEK = ['日', '一', '二', '三', '四', '五', '六']

export interface Cron {
  fields: Array<Set<number>>
  dayAny: boolean
  weekAny: boolean
}

/** 不合法时抛错，消息指出第几段。 */
export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error('要 5 段：分 时 日 月 周')
  const fields = parts.map((part, i) => {
    const [min, max] = BOUNDS[i]!
    const bad = (): never => {
      throw new Error(`第 ${i + 1} 段（${NAMES[i]}）不对：只能用 ${min}–${max} 的数字、*、a-b、*/n 或逗号列表`)
    }
    const out = new Set<number>()
    for (const item of part.split(',')) {
      let from: number
      let to: number
      let step = 1
      if (item === '*') [from, to] = [min, max]
      else if (/^\*\/\d+$/.test(item)) {
        ;[from, to] = [min, max]
        step = Number(item.slice(2))
        if (step < 1) bad()
      } else if (/^\d+-\d+$/.test(item)) [from, to] = item.split('-').map(Number) as [number, number]
      else if (/^\d+$/.test(item)) from = to = Number(item)
      else return bad()
      if (from < min || to > max || from > to) bad()
      for (let v = from; v <= to; v += step) out.add(i === 4 && v === 7 ? 0 : v)
    }
    return out
  })
  return { fields, dayAny: parts[2]!.startsWith('*'), weekAny: parts[4]!.startsWith('*') }
}

function dayOk(c: Cron, d: Date): boolean {
  const day = c.fields[2]!.has(d.getDate())
  const week = c.fields[4]!.has(d.getDay())
  // 和标准 cron 一致：日、周都限定时满足其一即可；有一个是 * 时两者都要满足
  return c.dayAny || c.weekAny ? day && week : day || week
}

/** after 之后（不含）的下一次触发时间；8 年内没有返回 undefined。 */
export function nextCron(expr: string | Cron, after = new Date()): Date | undefined {
  const c = typeof expr === 'string' ? parseCron(expr) : expr
  const t = new Date(after)
  t.setSeconds(0, 0)
  t.setMinutes(t.getMinutes() + 1)
  const end = after.getTime() + 8 * 366 * 86_400_000
  while (t.getTime() <= end) {
    if (!c.fields[3]!.has(t.getMonth() + 1)) {
      t.setMonth(t.getMonth() + 1, 1)
      t.setHours(0, 0, 0, 0)
    } else if (!dayOk(c, t)) {
      t.setDate(t.getDate() + 1)
      t.setHours(0, 0, 0, 0)
    } else if (!c.fields[1]!.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0)
    } else if (!c.fields[0]!.has(t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1, 0, 0)
    } else return t
  }
  return undefined
}

const pad = (n: number) => String(n).padStart(2, '0')
const single = (s: string) => /^\d+$/.test(s)

/** 常见写法翻成人话（"工作日 18:30"、"每 15 分钟"）；认不出的原样返回。不合法时返回 undefined。 */
export function describeCron(expr: string): string | undefined {
  try {
    parseCron(expr)
  } catch {
    return undefined
  }
  const [m, h, dom, mon, dow] = expr.trim().split(/\s+/) as [string, string, string, string, string]
  if (mon !== '*') return expr.trim()
  const every = /^\*\/(\d+)$/
  if (every.test(m) && h === '*' && dom === '*' && dow === '*') return `每 ${m.match(every)![1]} 分钟`
  if (single(m) && h === '*' && dom === '*' && dow === '*') return m === '0' ? '每小时整点' : `每小时第 ${m} 分`
  if (single(m) && every.test(h) && dom === '*' && dow === '*') return `每 ${h.match(every)![1]} 小时（第 ${m} 分）`
  if (!single(m) || !single(h)) return expr.trim()
  const at = `${pad(Number(h))}:${pad(Number(m))}`
  if (dom === '*' && dow === '*') return `每天 ${at}`
  if (dom === '*' && dow === '1-5') return `工作日 ${at}`
  if (dom === '*' && /^[0-7](,[0-7])*$/.test(dow)) return `每周${[...new Set(dow.split(',').map((d) => WEEK[Number(d) % 7]))].join('、')} ${at}`
  if (single(dom) && dow === '*') return `每月 ${dom} 日 ${at}`
  return expr.trim()
}
