import { expect, it } from 'vitest'
import { nodeResultDigest } from './tools.js'

it('门禁结果给模型看摘要：按用例状态分组、带标题和覆盖的 AC，不带证据路径', () => {
  const evidence = [{ workspace: 'REQ-1', path: 'evidence/TC-1/log.txt', version: 3 }]
  const result = {
    pass: false,
    checks: [
      { id: 'acceptance', pass: false, message: '存在无用例、未通过或缺少证据的 AC', details: [
        { ac: 'AC-1', title: '修订记录里的一行', pass: false, cases: [{ id: 'TC-1', status: 'passed', evidence }, { id: 'TC-2', status: 'manual_pending', evidence }] },
        { ac: 'AC-2', title: '', pass: false, cases: [{ id: 'TC-2', status: 'manual_pending', evidence }, { id: 'TC-3', status: 'blocked', evidence: [] }] },
        { ac: 'AC-3', title: '', pass: true, cases: [{ id: 'TC-1', status: 'passed', evidence }] },
      ] },
      { id: 'other', pass: true },
    ],
  }
  const titles = new Map([['TC-2', '画布尺寸 416×416'], ['TC-3', '【阻塞】rng 复位与深相等互斥']])
  const digest = nodeResultDigest(result, titles) as { checks: Array<Record<string, unknown>> }
  expect(digest.checks[0]).toEqual({
    id: 'acceptance', pass: false, message: '存在无用例、未通过或缺少证据的 AC',
    acs: 3, acsNotPassed: ['AC-1', 'AC-2'],
    caseCounts: { passed: 1, manual_pending: 1, blocked: 1 },
    notPassed: {
      manual_pending: [{ id: 'TC-2', title: '画布尺寸 416×416', covers: ['AC-1', 'AC-2'] }],
      blocked: [{ id: 'TC-3', title: '【阻塞】rng 复位与深相等互斥', covers: ['AC-2'] }],
    },
  })
  expect(digest.checks[1]).toEqual({ id: 'other', pass: true })
  expect(JSON.stringify(digest)).not.toContain('evidence/')
})

it('不是门禁结果：小的原样给，大的截断', () => {
  expect(nodeResultDigest({ summary: '好' }, new Map())).toEqual({ summary: '好' })
  expect(String(nodeResultDigest({ text: 'x'.repeat(5000) }, new Map()))).toHaveLength(2001)
})
