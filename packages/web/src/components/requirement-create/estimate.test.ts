import { expect, it } from 'vitest'
import { routePreviewFailure } from './estimate'

it('路由预览 409 的原因原样展示给用户（TF-032）', () => {
  expect(routePreviewFailure(Object.assign(new Error('这个空间还没有流水线，先去 流水线 新建或从模板导入'), { status: 409 }))).toBe('这个空间还没有流水线，先去 流水线 新建或从模板导入')
})

it('其他错误仍退回本地预估，不把原始报错顶到界面上（TF-032）', () => {
  expect(routePreviewFailure(Object.assign(new Error('服务器内部错误'), { status: 500 }))).toBeUndefined()
  expect(routePreviewFailure(new TypeError('Failed to fetch'))).toBeUndefined()
  expect(routePreviewFailure(undefined)).toBeUndefined()
})
