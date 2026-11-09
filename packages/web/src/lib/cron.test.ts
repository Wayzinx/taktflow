import { describe, expect, it } from 'vitest'
import { describeCron, nextCron, parseCron } from './cron'

const at = (s: string) => new Date(s)
const local = (d: Date | undefined) => d && `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')} 周${d.getDay()}`

describe('cron（docs/design/30 §4）', () => {
  it('工作日 18:30：周五晚过了就到下周一', () => {
    // 2026-11-13 是周五
    expect(local(nextCron('30 18 * * 1-5', at('2026-11-13T19:00:00')))).toBe('2026-11-16 18:30 周1')
    expect(local(nextCron('30 18 * * 1-5', at('2026-11-13T18:29:00')))).toBe('2026-11-13 18:30 周5')
  })

  it('*/15 与周 7 当周日', () => {
    expect(local(nextCron('*/15 * * * *', at('2026-11-13T10:01:00')))).toBe('2026-11-13 10:15 周5')
    expect(local(nextCron('0 9 * * 7', at('2026-11-13T10:00:00')))).toBe('2026-11-15 9:00 周0')
  })

  it('日、周都限定时满足其一即可', () => {
    expect(local(nextCron('0 8 1 * 1', at('2026-11-13T10:00:00')))).toBe('2026-11-16 8:00 周1')
  })

  it('不合法时指出哪一段', () => {
    expect(() => parseCron('0 25 * * *')).toThrow('第 2 段（时）')
    expect(() => parseCron('0 9 * *')).toThrow('5 段')
  })

  it('常见写法翻成人话', () => {
    expect(describeCron('30 18 * * 1-5')).toBe('工作日 18:30')
    expect(describeCron('0 9 * * *')).toBe('每天 09:00')
    expect(describeCron('0 10 * * 1,3')).toBe('每周一、三 10:00')
    expect(describeCron('*/15 * * * *')).toBe('每 15 分钟')
    expect(describeCron('0 * * * *')).toBe('每小时整点')
    expect(describeCron('0 9 1 * *')).toBe('每月 1 日 09:00')
    expect(describeCron('0 9 1 1 *')).toBe('0 9 1 1 *')
    expect(describeCron('0 9 * *')).toBeUndefined()
  })
})
