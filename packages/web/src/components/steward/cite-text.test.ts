import { expect, it } from 'vitest'
import { plainSummary, plainWithSources, stripCitations } from './cite-text'

it('去掉 [n] 引用，连同只包着引用的括号，不留下空括号', () => {
  expect(stripCitations('做出来了，已交付（[1]）。代码在集成分支（[2]、[3]）上')).toBe('做出来了，已交付。代码在集成分支上')
  expect(stripCitations('已合进 main [2]。括号里有字（见报告 [1]）')).toBe('已合进 main 。括号里有字（见报告 ）')
})

it('复制成纯文本：去掉 Markdown 标记，引用留编号并在末尾列出来源的绝对地址', () => {
  const text = '## 结论\n失败在 **clarify（需求澄清）** 节点 [1]，详见[运行页](/s/std/run/r1?node=clarify)和[成绩单]([2])。\n```json\n{"a":1}\n```'
  const cites = [
    { label: '作者版标准交付示例', href: '/s/standard-delivery' },
    { label: '成绩单', href: 'https://example.com/eval' },
  ]
  expect(plainWithSources(text, cites, 'http://127.0.0.1:4870')).toBe(
    '结论\n失败在 clarify（需求澄清） 节点 [1]，详见运行页（http://127.0.0.1:4870/s/std/run/r1?node=clarify）和成绩单[2]。\n{"a":1}\n\n来源：\n[1] 作者版标准交付示例 http://127.0.0.1:4870/s/standard-delivery\n[2] 成绩单 https://example.com/eval',
  )
  expect(plainWithSources('没有引用')).toBe('没有引用')
})

it('历史摘要去掉表格、围栏和被截断的 Markdown 链接', () => {
  expect(plainSummary('| 编号 | 标题 |\n| --- | --- |\n| REQ-001 | **问候** [1] |')).toBe('编号 标题 REQ-001 问候')
  expect(plainSummary('重新生成[添加成员提案](/steward?thread=abc')).toBe('重新生成添加成员提案')
  expect(plainSummary('```json\n{"a": 1}\n```')).toBe('{"a": 1}')
})
