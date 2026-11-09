import { describe, expect, it } from 'vitest'
import { cronMatches, nextCronAt, parseCron } from './cron.js'

describe('本机时区 cron', () => {
  it('步长、区间、列表、周 7 和严格晚于当前时刻', () => {
    const monday = new Date(2026, 10, 9, 9, 1, 35)
    expect(nextCronAt('*/15 9-18 * * 1-5', monday)).toBe(new Date(2026, 10, 9, 9, 15).toISOString())
    expect(nextCronAt('0 9 * * 7', monday)).toBe(new Date(2026, 10, 15, 9).toISOString())
    expect(nextCronAt('0,30 * * * *', new Date(2026, 10, 9, 9, 30))).toBe(new Date(2026, 10, 9, 10).toISOString())
    expect(cronMatches('0 9 * * 0,7', new Date(2026, 10, 15, 9))).toBe(true)
    expect(nextCronAt('0 0 29 2 *', new Date(2026, 0, 1))).toBe(new Date(2028, 1, 29).toISOString())
    expect(nextCronAt('0 0 31 2 *', monday)).toBeUndefined()
  })
  it('日和周都指定时按 cron 的或语义', () => {
    expect(cronMatches('0 9 1 * 1', new Date(2026, 10, 9, 9))).toBe(true)
    expect(cronMatches('0 9 * * 1', new Date(2026, 10, 10, 9))).toBe(false)
  })
  it.each([['* * * *', '5 段'], ['60 * * * *', '第 1 段'], ['* 24 * * *', '第 2 段'], ['* * 0 * *', '第 3 段'], ['* * * 13 *', '第 4 段'], ['* * * * 8', '第 5 段'], ['*/0 * * * *', '第 1 段'], ['* 5-1 * * *', '第 2 段'], ['1,,2 * * * *', '第 1 段']])('拒绝 %s', (cron, message) => {
    expect(() => parseCron(cron)).toThrow(message)
  })
})
