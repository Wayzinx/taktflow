import { describe, expect, it } from 'vitest'
import { parseMarkdown, type MdBlock } from './markdown-parse'

const list = (block: MdBlock | undefined) => {
  if (block?.type !== 'list') throw new Error(`不是列表：${JSON.stringify(block)}`)
  return block
}

describe('parseMarkdown', () => {
  it('列表首项缩进比后面的项深时不卡死：浅的那行另起一个列表', () => {
    // 真实 PRD 的形状：表格后面接着缩进 2 的编号项，再回到顶格的无序项
    const blocks = parseMarkdown(['| a | b |', '|---|---|', '| 1 | 2 |', '', '  1. 第一条', '  2. 第二条', '- **证据**：接口响应', '- **来源**：request.md'].join('\n'))
    expect(blocks.map((b) => b.type)).toEqual(['table', 'list', 'list'])
    expect(list(blocks[1]).items.map((i) => i.text)).toEqual(['第一条', '第二条'])
    expect(list(blocks[1]).ordered).toBe(true)
    expect(list(blocks[2]).items.map((i) => i.text)).toEqual(['**证据**：接口响应', '**来源**：request.md'])
  })

  it('子列表首项缩进比后面的子项深时不卡死，子项都留在上一项下面', () => {
    const blocks = parseMarkdown(['- 父项', '    - 深的子项', '  - 浅的子项', '- 下一个父项'].join('\n'))
    const top = list(blocks[0])
    expect(top.items.map((i) => i.text)).toEqual(['父项', '下一个父项'])
    const children = top.items[0]!.blocks.flatMap((b) => list(b).items.map((i) => i.text))
    expect(children).toEqual(['深的子项', '浅的子项'])
  })

  it('子块以续行开头时不报错，续行并进项文字', () => {
    const blocks = parseMarkdown(['- 项', '  续行', '  - 子项'].join('\n'))
    const item = list(blocks[0]).items[0]!
    expect(item.text).toBe('项 续行')
    expect(list(item.blocks[0]).items[0]!.text).toBe('子项')
  })

  it('列表项里的表格、代码块按块解析，后面的同级项不丢', () => {
    const source = [
      '  5. **优先级**：输入 → 期望：',
      '     | 输入 | 期望 |',
      '     |---|---|',
      '     | `null` | 未执行 |',
      '  6. **不变**：既有用例不改',
      '     ```ts',
      '     expect(x).toBe(1)',
      '     ```',
    ].join('\n')
    const top = list(parseMarkdown(source)[0])
    expect(top.start).toBe(5)
    expect(top.items.map((i) => i.text)).toEqual(['**优先级**：输入 → 期望：', '**不变**：既有用例不改'])
    expect(top.items[0]!.blocks[0]).toEqual({ type: 'table', head: ['输入', '期望'], align: [undefined, undefined], rows: [['`null`', '未执行']] })
    expect(top.items[1]!.blocks[0]).toEqual({ type: 'code', lang: 'ts', code: 'expect(x).toBe(1)' })
  })

  it('项之间隔空行仍是同一个列表；换成另一种列表或段落就结束', () => {
    const blocks = parseMarkdown(['1. 一', '', '2. 二', '', '   二的第二段', '- 无序', '', '段落'].join('\n'))
    expect(blocks.map((b) => b.type)).toEqual(['list', 'list', 'paragraph'])
    const ordered = list(blocks[0])
    expect(ordered.items.map((i) => i.text)).toEqual(['一', '二'])
    expect(ordered.items[1]!.blocks).toEqual([{ type: 'paragraph', text: '二的第二段' }])
  })

  it('标题、引用、分隔线、段落和缩进的代码围栏', () => {
    const blocks = parseMarkdown(['# 标题', '> 引用 **粗**', '> - 引用里的项', '---', '第一行', '第二行', '  ```', '  code', '  ```'].join('\n'))
    expect(blocks).toEqual([
      { type: 'heading', level: 1, text: '标题' },
      { type: 'quote', blocks: [{ type: 'paragraph', text: '引用 **粗**' }, { type: 'list', ordered: false, start: 1, items: [{ text: '引用里的项', blocks: [] }] }] },
      { type: 'hr' },
      { type: 'paragraph', text: '第一行 第二行' },
      { type: 'code', lang: '', code: 'code' },
    ])
  })

  it('任意缩进和标记组合都能在有限步内解析完', () => {
    let seed = 7
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    const shapes = ['- ', '* ', '1. ', '10) ', '| a | b |', '|---|---|', '```', '> ', '# ', '---', '', 'text', '\t- ']
    for (let doc = 0; doc < 400; doc++) {
      const lines = Array.from({ length: 30 }, () => `${' '.repeat(rand(7))}${shapes[rand(shapes.length)]}x`)
      expect(Array.isArray(parseMarkdown(lines.join('\n')))).toBe(true)
    }
  })
})
