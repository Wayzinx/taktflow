import { afterEach, describe, expect, it, vi } from 'vitest'
import { isNetworkError, isOnline, onReconnect, reportConnection } from './connection'

afterEach(() => reportConnection(true))

describe('连接状态', () => {
  it('只有网络错误算断开，HTTP 错误不冒充断网', () => {
    expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true)
    expect(isNetworkError(new TypeError('Load failed'))).toBe(true)
    expect(isNetworkError({ status: 403, message: 'network denied' })).toBe(false)
    expect(isNetworkError(new SyntaxError('Invalid JSON'))).toBe(false)
  })

  it('恢复后只通知一次重取数，解绑后不再通知', () => {
    const reload = vi.fn()
    const off = onReconnect(reload)
    reportConnection(false)
    expect(isOnline()).toBe(false)
    reportConnection(true)
    reportConnection(true)
    expect(reload).toHaveBeenCalledOnce()
    off()
    reportConnection(false)
    reportConnection(true)
    expect(reload).toHaveBeenCalledOnce()
  })
})
