import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { Markdown } from '../src/lib/markdown'
import { PrefsForm } from '../src/pages/steward/prefs-form'
import { pageKeyOf } from '../src/components/steward/context'

vi.hoisted(() => {
  vi.stubGlobal('location', { href: 'http://localhost/solo' })
  vi.stubGlobal('window', { addEventListener: vi.fn() })
})
vi.mock('../src/components/ui', () => ({ Chips: () => null, Segmented: () => null, toast: vi.fn() }))

it('管家复用 Markdown：表格、有序列表、流式未闭合代码和引用行内回调同时生效', () => {
  const source = '| 编号 | 来源 |\n| --- | --- |\n| REQ-001 | [1] |\n\n1. 第一步\n2. 第二步\n\n```json\n{\n  "a": 1\n}'
  const html = renderToStaticMarkup(createElement(Markdown, { source, inline: (text: string) => [text === '[1]' ? createElement('sup', { key: 'cite' }, '1') : text] }))
  expect(html).toContain('<table>')
  expect(html).toContain('<ol start="1">')
  expect(html).toContain('<sup>1</sup>')
  expect(html).toContain('<pre class="md-code" data-lang="json"><code>{\n  &quot;a&quot;: 1\n}</code></pre>')
})

it('管家设置与输入框使用同一默认组合，当前空间没有 provider 也显示全局模型', () => {
  const html = renderToStaticMarkup(createElement(PrefsForm, { prefs: { trust: 'confirm', digestTimes: [] }, onChange: vi.fn(), spaces: [], choices: [{ harness: 'native', harnessLabel: '内置', model: 'global-flash', modelLabel: '全局模型', provider: 'global', available: true, isDefault: true }] }))
  expect(html).toContain('value="native" selected="">内置')
  expect(html).toContain('value="global-flash" selected="">全局模型 · global')
  expect(html).not.toContain('不可用')
})

it('设置建议读取 query 或子路径，裸设置页和未知标签回到成员页', () => {
  expect(pageKeyOf('/settings')).toEqual({ page: 'settings-members' })
  expect(pageKeyOf('/settings', new URLSearchParams('tab=runtime'))).toEqual({ page: 'settings-models' })
  expect(pageKeyOf('/settings/repos')).toEqual({ page: 'settings-repos' })
  expect(pageKeyOf('/settings', new URLSearchParams('tab=unknown'))).toEqual({ page: 'settings-members' })
})
