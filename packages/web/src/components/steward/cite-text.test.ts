import { expect, it } from 'vitest'
import { stripCitations } from './cite-text'

it('去掉 [n] 引用，连同只包着引用的括号，不留下空括号', () => {
  expect(stripCitations('做出来了，已交付（[1]）。代码在集成分支（[2]、[3]）上')).toBe('做出来了，已交付。代码在集成分支上')
  expect(stripCitations('已合进 main [2]。括号里有字（见报告 [1]）')).toBe('已合进 main 。括号里有字（见报告 ）')
})
