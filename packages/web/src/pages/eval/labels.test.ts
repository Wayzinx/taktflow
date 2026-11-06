import { describe, expect, it } from 'vitest'
import type { EvalCaseResult, EvalRun, HarnessInfo, NodeScorecard } from '@taktflow/core'
import { cardKey, cardTitle, caseOutcome, defaultHarness, findCard, variantPair } from './labels'

const card = (key: NodeScorecard['key']) => ({ key, label: key.nodeId ?? '' }) as NodeScorecard

describe('cardKey / findCard', () => {
  const cards = [
    card({ by: 'node', workflowId: 'taktflow-standard', nodeId: 'implement' }),
    card({ by: 'node', workflowId: 'quick-fix', nodeId: 'implement' }),
    card({ by: 'node', workflowId: 'quick-fix', nodeId: 'review-code' }),
  ]
  it('keys node cards by workflow + node so same-named nodes do not collide', () => {
    expect(cards.map(cardKey)).toEqual(['taktflow-standard/implement', 'quick-fix/implement', 'quick-fix/review-code'])
    expect(cardKey(card({ by: 'recipe', recipeKey: 'abc' }))).toBe('abc')
    expect(cardKey(card({ by: 'skill', skill: { name: 'tdd', hash: 'h1' } }))).toBe('tdd@h1')
  })
  it('opens the exact card, not the first one with that node id', () => {
    expect(findCard(cards, 'quick-fix/implement')).toBe(cards[1])
  })
  it('falls back to a bare node id (old links) and to the longest path prefix', () => {
    expect(findCard(cards, 'review-code')).toBe(cards[2])
    expect(findCard(cards, 'quick-fix/implement/T-1')).toBe(cards[1])
    expect(findCard(cards, 'other/implement')).toBeUndefined()
  })
})

const res = (pass: boolean, score?: number) => ({ pass, score }) as EvalCaseResult
describe('caseOutcome (mirror of core compareEval)', () => {
  it('compares pass first, then score with a 5-point dead band', () => {
    expect(caseOutcome(res(false, 90), res(true, 10))).toBe('win')
    expect(caseOutcome(res(true, 10), res(false, 90))).toBe('loss')
    expect(caseOutcome(res(true, 80), res(true, 84))).toBe('tie')
    expect(caseOutcome(res(true, 80), res(true, 85))).toBe('win')
    expect(caseOutcome(res(true, 80), res(true, 75))).toBe('loss')
    expect(caseOutcome(res(true), res(true))).toBe('tie')
    expect(caseOutcome(undefined, res(true))).toBeUndefined()
  })
})

describe('variantPair', () => {
  const v = (id: string) => ({ id, label: id })
  const run = (variants: string[], comparison?: { baseline: string; candidate: string }) => ({ variants: variants.map(v), comparison }) as unknown as EvalRun
  it('reads baseline / candidate from the comparison, not array order', () => {
    const p = variantPair(run(['cand', 'baseline'], { baseline: 'baseline', candidate: 'cand' }))
    expect([p.baseline?.id, p.candidate?.id]).toEqual(['baseline', 'cand'])
  })
  it('falls back to request order without a comparison', () => {
    const p = variantPair(run(['baseline', 'v2']))
    expect([p.baseline?.id, p.candidate?.id]).toEqual(['baseline', 'v2'])
  })
})

describe('defaultHarness', () => {
  const h = (id: string, roles: string[], available = true) => ({ id, roles, available }) as HarnessInfo
  const list = [h('claude-code', ['pm'], false), h('codex', ['dev']), h('mock', ['evaluator'])]
  it('picks the available harness for the role, then the first available one', () => {
    expect(defaultHarness(list, 'evaluator')).toBe('mock')
    expect(defaultHarness(list, 'pm')).toBe('codex')
    expect(defaultHarness(list, undefined)).toBe('codex')
    expect(defaultHarness([h('x', [], false)], 'dev')).toBeUndefined()
  })
})

describe('cardTitle', () => {
  it('does not repeat the workflow/node path when the server label is just the key', () => {
    const c = { key: { by: 'node', workflowId: 'quick-fix', nodeId: 'implement' }, label: 'quick-fix/implement', role: 'dev' } as NodeScorecard
    expect(cardTitle(c)).toEqual({ title: 'implement', sub: 'quick-fix · dev' })
  })
  it('keeps a real title and shows the path underneath', () => {
    const c = { key: { by: 'node', workflowId: 'sdlc', nodeId: 'design' }, label: '系分设计' } as NodeScorecard
    expect(cardTitle(c)).toEqual({ title: '系分设计', sub: 'sdlc/design' })
  })
})
