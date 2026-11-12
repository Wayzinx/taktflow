import { describe, expect, it } from 'vitest'
import type { GraphNode } from '@taktflow/core'
import { harnessSplit } from './metrics-split'

const node = (id: string, tokens: number, harness?: string): GraphNode => ({ id, title: id, kind: 'agent', status: 'succeeded', attempts: 1, needs: [], harness, usage: { inputTokens: tokens, outputTokens: 0 } }) as GraphNode

describe('harnessSplit', () => {
  it('没记 harness 的用量单列“未记录”，占比以需求总 token 为分母，0 token 的 harness 不列', () => {
    const split = harnessSplit([node('a', 1990, 'claude-code'), node('b', 460, 'claude-acp'), node('c', 0, 'codex'), node('review', 7120)], 10_800)
    expect(split.rows).toEqual([{ key: 'claude-code', tokens: 1990 }, { key: 'claude-acp', tokens: 460 }, { key: '未记录 harness', tokens: 8350, unknown: true }])
    expect(split).toMatchObject({ known: 2450, denominator: 10_800 })
    expect(Math.round((split.rows[0]!.tokens / split.denominator) * 100)).toBe(18)
  })
  it('一个 harness 都没记录时不拆分；节点合计大于需求总量时以节点合计为分母', () => {
    expect(harnessSplit([node('review', 100)], 100)).toEqual({ rows: [], known: 0, denominator: 100 })
    expect(harnessSplit([node('a', 120, 'codex')], 100)).toEqual({ rows: [{ key: 'codex', tokens: 120 }], known: 120, denominator: 120 })
  })
})
