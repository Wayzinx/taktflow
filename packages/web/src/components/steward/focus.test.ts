import { expect, it } from 'vitest'
import { decodeFocus, encodeFocus, fileFocus, fileFocusOf, filePagePath } from './focus'

it('产物链接换成文件焦点：产物页地址、管家写出的本机路径、需求目录相对路径', () => {
  const want = fileFocus('standard-delivery', 'REQ-003', 'reports/quality.md')
  expect(fileFocusOf('/Users/me/taktflow-playground/spaces/standard-delivery/requirements/REQ-003/reports/quality.md')).toEqual(want)
  expect(fileFocusOf('/s/standard-delivery/req/REQ-003?tab=artifacts&path=reports%2Fquality.md')).toEqual(want)
  expect(fileFocusOf('/req/REQ-003?path=reports/quality.md', 'standard-delivery')).toEqual(want)
  expect(fileFocusOf('/requirements/REQ-003/reports/quality.md', 'standard-delivery')).toEqual(want)
  // 不是产物：需求页其他标签、运行页、没有空间的相对路径
  expect(fileFocusOf('/s/standard-delivery/req/REQ-003?tab=runs')).toBeUndefined()
  expect(fileFocusOf('/s/standard-delivery/run/run-1?node=check')).toBeUndefined()
  expect(fileFocusOf('/requirements/REQ-003/reports/quality.md')).toBeUndefined()
})

it('文件焦点写进地址再读回来不变，完整页面地址指向产物页', () => {
  const t = fileFocus('shop', 'REQ-1', 'spec/prd.md')
  expect(encodeFocus(t)).toBe('file:shop/REQ-1/spec/prd.md')
  expect(decodeFocus(encodeFocus(t))).toEqual(t)
  expect(filePagePath(t)).toBe('/req/REQ-1?tab=artifacts&path=spec%2Fprd.md')
})
