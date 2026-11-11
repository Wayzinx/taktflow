import { expect, it } from 'vitest'
import { roleHue } from './roles'

it('内置角色各占一档颜色、互不相同；管家和 Lead 用蜂蜜色；同名角色同色', () => {
  const builtin = ['pm', 'architect', 'dev', 'test-designer', 'automation', 'reviewer', 'judge', 'verifier', 'evaluator', 'auditor', 'wiki-writer']
  expect(new Set(builtin.map(roleHue)).size).toBe(builtin.length)
  expect(roleHue('steward')).toBe('var(--honey)')
  expect(roleHue('lead')).toBe('var(--honey)')
  expect(roleHue('security-expert')).toBe(roleHue('security-expert'))
  expect(roleHue()).toBe('var(--c-7)')
})
