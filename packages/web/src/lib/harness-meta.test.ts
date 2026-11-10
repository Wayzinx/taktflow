import { describe, expect, it } from 'vitest'
import type { StewardRuntimeChoice } from '@taktflow/core'
import { acpAgent, harnessMeta, isTestOnly } from './harness-meta'
import { choicesToPicker } from '../components/steward/runtime-choices'

describe('harnessMeta', () => {
  it('内置直连 API 与测试替身换成人话', () => {
    expect(harnessMeta({ id: 'native', displayName: 'native', source: 'native' })).toMatchObject({ name: '直连 API（内置）', icon: 'takt' })
    expect(harnessMeta({ id: 'mock', displayName: 'Mock', source: 'builtin' }).name).toBe('测试替身（mock）')
    expect(isTestOnly({ id: 'mock', displayName: 'Mock', source: 'builtin' })).toBe(true)
    expect(isTestOnly({ id: 'mock', displayName: 'Mock', source: 'builtin', testOnly: false })).toBe(false)
  })

  it('自加的 Claude ACP 条目标成同一个 agent 的另一种接法', () => {
    const h = { id: 'claude-acp', displayName: 'Claude Agent ACP', source: 'acp' as const, command: ['npx', '--no-install', '@agentclientprotocol/claude-agent-acp@0.101.0'] }
    expect(acpAgent(h)).toEqual({ preset: 'claude', name: 'Claude Code' })
    expect(harnessMeta(h)).toMatchObject({ name: 'Claude Code · ACP 接法', icon: 'claudecode', own: '使用个人 Claude 订阅' })
  })

  it('自带来源：server 给了就用 server 的，否则按 id', () => {
    expect(harnessMeta({ id: 'codex', displayName: 'Codex', source: 'builtin' }).own).toBe('使用 ChatGPT 账号')
    expect(harnessMeta({ id: 'codex', displayName: 'Codex', source: 'builtin', ownLabel: '使用公司账号' }).own).toBe('使用公司账号')
    expect(harnessMeta({ id: 'my-cli', displayName: 'My CLI', source: 'cli' })).toMatchObject({ name: 'My CLI', own: undefined, icon: undefined })
  })
})

describe('choicesToPicker', () => {
  const choice = (c: Partial<StewardRuntimeChoice> & Pick<StewardRuntimeChoice, 'harness'>): StewardRuntimeChoice => ({ harnessLabel: c.harness, available: true, ...c })

  it('不带模型的是「自带」组，带模型的按 provider 分组，桥接打标签', () => {
    const [native, claude] = choicesToPicker([
      choice({ harness: 'native', model: 'flash', modelLabel: 'deepseek-flash', provider: 'deepseek', isDefault: true }),
      choice({ harness: 'claude-code', harnessLabel: 'Claude Code' }),
      choice({ harness: 'claude-code', harnessLabel: 'Claude Code', model: 'flash', provider: 'deepseek', pairing: { mode: 'bridge', protocol: 'anthropic-messages', upstream: 'openai-chat' } }),
    ])
    expect(native).toMatchObject({ id: 'native', name: '直连 API（内置）', badge: '默认', groups: [{ key: 'p:deepseek', icon: 'deepseek' }] })
    expect(claude!.groups.map((g) => [g.key, g.note])).toEqual([['own', '自带'], ['p:deepseek', '经协议桥']])
    expect(claude!.groups[0]!.label).toBe('使用个人 Claude 订阅')
    expect(claude!.groups[1]!.models[0]).toMatchObject({ model: 'flash', provider: 'deepseek', tags: ['桥接'] })
  })

  it('一个组合都不能用时整行不可用，并带上原因', () => {
    const [codex] = choicesToPicker([choice({ harness: 'codex', available: false, reason: '未登录' })])
    expect(codex).toMatchObject({ available: false, reason: '未登录' })
  })
})
