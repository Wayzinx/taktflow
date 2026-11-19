import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { SpaceMember } from '@taktflow/core'
import type { FeishuBindingStatus } from '../../api/feishu.js'

vi.mock('../../api', () => ({ useAsync: vi.fn() }))
vi.mock('../../lib/router', () => ({ Link: ({ to, children }: { to: string; children: string }) => createElement('a', { href: to }, children) }))

import { FeishuEditor } from './feishu-tab.js'

const members: SpaceMember[] = [
  { id: 'owner-1', name: '空间负责人', role: 'owner' },
  { id: 'qa-1', name: '测试同事', role: 'member' },
]
const configured: FeishuBindingStatus = {
  configured: true,
  binding: { chatId: 'oc_release', members: [{ openId: 'ou_qa', memberId: 'qa-1' }], revision: 'r1' },
}

function render(initial: FeishuBindingStatus, mock = false) {
  return renderToStaticMarkup(createElement(FeishuEditor, { initial, members, source: { mock, feishuBinding: vi.fn(), setFeishuBinding: vi.fn() } }))
}

it('向所有者显示真实成员与角色，并区分群绑定和单向 Webhook', () => {
  const html = render(configured)
  expect(html).toContain('已绑定')
  expect(html).toContain('空间负责人（owner · owner-1）')
  expect(html).toContain('测试同事（member · qa-1）')
  expect(html).toContain('添加映射')
  expect(html).toContain('解绑群')
  expect(html).not.toContain('确认解绑')
  expect(html).toContain('单向通知 Webhook')
})

it('未配置企业应用时指引联系运维，不提供保存', () => {
  const html = render({ configured: false, binding: null })
  expect(html).toContain('企业应用未配置')
  expect(html).toContain('请联系 Hub 运维')
  expect(html).not.toContain('保存绑定')
})

it('只读演示显示已保存映射，不显示修改操作', () => {
  const html = render(configured, true)
  expect(html).toContain('ou_qa')
  expect(html).toContain('不能保存或解绑')
  expect(html).not.toContain('解绑群')
  expect(html).not.toContain('添加映射')
})
