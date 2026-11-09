import { expect, it, vi } from 'vitest'
import { resumeInBackground } from './resume-background.js'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

it('启动就返回，jobs 等待执行、错误通知和收尾全部结束', async () => {
  const running = deferred<void>(), reporting = deferred<void>(), settling = deferred<void>()
  const jobs = new Set<Promise<unknown>>()
  const onError = vi.fn(() => reporting.promise), onSettled = vi.fn(() => settling.promise)
  await resumeInBackground(onStarted => { onStarted(); return running.promise }, { jobs, onError, onSettled })
  expect(jobs.size).toBe(1)
  expect(onSettled).not.toHaveBeenCalled()
  const finished = Promise.all(jobs)
  running.reject(new Error('执行失败'))
  await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: '执行失败' })))
  expect(onSettled).not.toHaveBeenCalled()
  reporting.resolve()
  await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1))
  expect(jobs.size).toBe(1)
  settling.resolve()
  await finished
  expect(jobs.size).toBe(0)
})

it.each(['同步', '异步'])('开始前%s异常交给调用方，仍执行收尾', async mode => {
  const jobs = new Set<Promise<unknown>>()
  const onError = vi.fn(), onSettled = vi.fn()
  await expect(resumeInBackground(() => {
    if (mode === '同步') throw new Error('启动失败')
    return Promise.reject(new Error('启动失败'))
  }, { jobs, onError, onSettled })).rejects.toThrow('启动失败')
  expect(onError).not.toHaveBeenCalled()
  expect(onSettled).toHaveBeenCalledTimes(1)
  expect(jobs.size).toBe(0)
})

it('无须执行也结束等待；收尾和通知抛错不泄漏 rejection', async () => {
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const jobs = new Set<Promise<unknown>>()
  try {
    await resumeInBackground(async () => 'cancelled', { jobs,
      onSettled: result => { expect(result).toBe('cancelled'); throw new Error('收尾失败') },
      onError: async () => { throw new Error('通知失败') },
    })
    expect(jobs.size).toBe(0)
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('后台续跑错误通知失败'))
  } finally { stderr.mockRestore() }
})
