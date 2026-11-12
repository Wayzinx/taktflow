/**
 * TF-042 / TF-015：⌘K 默认只列页面、需求、运行、操作和常用命令；维护类命令输入 > 才出现。
 * items.ts 经 api / router / theme 在加载时读 location、document，先放假的再动态导入（同 lib/router.test.ts）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandInfo } from '@taktflow/core'
import { Search } from 'lucide-react'
import type { Item } from './items'

let items: typeof import('./items')
beforeEach(async () => {
  vi.stubGlobal('location', new URL('http://app.test/s/demo'))
  vi.stubGlobal('history', { state: null, replaceState() {}, pushState() {} })
  vi.stubGlobal('window', { addEventListener() {} })
  vi.stubGlobal('document', { documentElement: { setAttribute() {}, removeAttribute() {} } })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} })
  vi.resetModules()
  items = await import('./items')
})
afterEach(() => vi.unstubAllGlobals())

const page = (label: string, keywords: string): Item => ({ id: `page:${label}`, group: '页面', label, icon: Search, keywords })
const command = (id: string, title: string, inContext = false): Item => ({
  id: `cmd:${id}`,
  group: '命令',
  label: title,
  code: id,
  icon: Search,
  keywords: `${id} ${title}`,
  command: { id, title, kind: 'command', risk: 'write', input: {} } as CommandInfo,
  inContext,
})
const term = (label: string, hint: string): Item => ({ id: `term:${label}`, group: '术语', label, hint, icon: Search, keywords: `${label} 术语 glossary 解释` })
const all = [page('评测', 'eval pingce'), page('总览', 'overview'), command('knowledge.eval', '评测知识库'), command('run.start', '启动运行'), command('quality.repair', '修复质量锚点'), command('run.retry', '重试失败节点', true), term('判决', '测试失败后由独立 Agent 判断原因')]

describe('filterItems', () => {
  it('不输入时：维护类命令不出现，常用命令出现', () => {
    const ids = items.filterItems(all, '').map((i) => i.id)
    expect(ids).toContain('cmd:run.start')
    expect(ids).toContain('cmd:run.retry')
    expect(ids).not.toContain('cmd:quality.repair')
    expect(ids).not.toContain('cmd:knowledge.eval')
    expect(ids).not.toContain('term:判决')
    expect(items.filterItems([command('quality.repair', '修复质量锚点', true)], '')).toEqual([])
  })

  it('搜术语时给出解释（TF-041），默认不占列表', () => {
    const r = items.filterItems(all, '判决')
    expect(r.find((i) => i.id === 'term:判决')?.hint).toContain('独立 Agent')
  })

  it('搜“评测”第一项是评测页，不是写命令；高级命令只计数提示', () => {
    const r = items.filterItems(all, '评测')
    expect(r[0]!.id).toBe('page:评测')
    expect(r.some((i) => i.id === 'cmd:knowledge.eval')).toBe(false)
    expect(items.hiddenCommandMatches(all, '评测')).toBe(1)
  })

  it('输入 > 只搜命令（含维护类），不追加“问管家”', () => {
    const r = items.filterItems(all, '> 修复')
    expect(r.map((i) => i.id)).toEqual(['cmd:quality.repair'])
    expect(items.filterItems(all, '>').every((i) => i.command)).toBe(true)
    expect(items.hiddenCommandMatches(all, '> 修复')).toBe(0)
  })
})
