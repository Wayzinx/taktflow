import { describe, expect, it } from 'vitest'
import type { AgentProfile, HarnessAdapter, TaktConfig, WorkflowDefinition } from '../types.js'
import { forEachRoleSelector, resolveHarnessSelector, validateHarnessSelector, validateWorkflowHarnesses } from './selection.js'
import type { HarnessCapabilities } from '../types.js'

const adapter = (id: string, capabilities: HarnessCapabilities = {}): HarnessAdapter => ({ id, displayName: id, capabilities, available: async () => ({ ok: true }), run: async () => ({ ok: true, finalText: '' }) })
const harnesses = { native: adapter('native', { customProvider: true, requiresProvider: true, providerProtocols: ['openai-chat', 'anthropic-messages'] }), plain: adapter('plain'), custom: adapter('custom', { customProvider: true }),
  'claude-code': adapter('claude-code', { customProvider: true, providerProtocols: ['anthropic-messages'] }), codex: adapter('codex', { customProvider: true, providerProtocols: ['openai-chat', 'openai-responses'] }) }
const config: TaktConfig = { project: { name: 'selection' }, workflows: [],
  providers: { local: { protocol: 'openai-chat' }, other: { protocol: 'anthropic-messages' }, responses: { protocol: 'openai-responses' } },
  models: { alias: { provider: 'local', id: 'raw-id', price: { input: 1, output: 2 }, contextWindow: 1000 }, 'raw-id': { provider: 'other', id: 'do-not-resolve-twice' } },
}

describe('模型及 provider 早校验', () => {
  it('别名只解析一次，provider 按适配器声明能力校验', () => {
    expect(resolveHarnessSelector({ harness: 'native', model: 'alias' }, config, harnesses)).toMatchObject({
      model: 'raw-id', provider: { id: 'local', protocol: 'openai-chat' }, modelConfig: config.models!.alias,
    })
  })
  it('允许 harness 原生 raw ID；native raw ID 必须明确 provider', () => {
    expect(resolveHarnessSelector({ harness: 'plain', model: 'vendor/raw' }, config, harnesses)).toMatchObject({ model: 'vendor/raw', provider: undefined })
    expect(() => validateHarnessSelector({ harness: 'native', model: 'vendor/raw' }, config, harnesses)).toThrow('provider')
    expect(() => validateHarnessSelector({ harness: 'native', provider: 'local', model: 'vendor/raw' }, config, harnesses)).not.toThrow()
  })
  it.each([undefined, '', '  '])('native 拒绝空模型 %s', (model) => {
    expect(() => validateHarnessSelector({ harness: 'native', provider: 'local', model }, config, harnesses)).toThrow('非空模型')
  })
  it('拒绝缺失 provider、不支持 customProvider 及无效 fallback', () => {
    expect(() => validateHarnessSelector({ harness: 'custom', provider: 'missing' }, config, harnesses)).toThrow('provider 不存在')
    expect(() => validateHarnessSelector({ harness: 'plain', model: 'alias' }, config, harnesses)).toThrow('customProvider')
    expect(() => validateHarnessSelector({ harness: 'plain', fallback: [{ harness: 'custom', fallback: [{ harness: 'missing' }] }] }, config, harnesses)).toThrow('harness 不存在')
  })
  it('覆盖 provider 不串用旧厂商价格，按所选 provider 与 raw ID 唯一匹配', () => {
    expect(resolveHarnessSelector({ harness: 'native', model: 'alias', provider: 'other' }, config, harnesses).modelConfig).toBeUndefined()
    const otherModel = { provider: 'other', id: 'raw-id', price: { input: 10, output: 20 }, contextWindow: 2000 }
    const withOther = { ...config, models: { ...config.models, otherAlias: otherModel } }
    expect(resolveHarnessSelector({ harness: 'native', model: 'alias', provider: 'other' }, withOther, harnesses).modelConfig).toEqual(otherModel)
  })
  it('同 provider/raw ID 多别名保留所选 metadata，未命名的 raw ID 不猜 metadata', () => {
    const duplicate = { ...config.models!.alias!, price: { input: 10, output: 20 }, contextWindow: 9000 }
    const configured = { ...config, models: { alias: config.models!.alias!, duplicate } }
    expect(resolveHarnessSelector({ harness: 'native', model: 'alias' }, configured, harnesses).modelConfig).toEqual(config.models!.alias)
    expect(resolveHarnessSelector({ harness: 'native', model: 'duplicate' }, configured, harnesses).modelConfig).toEqual(duplicate)
    expect(resolveHarnessSelector({ harness: 'native', model: 'raw-id', provider: 'local' }, configured, harnesses).modelConfig).toBeUndefined()
  })
  it('插件注册键与 adapter.id 不同也只按能力校验，错误使用注册键', () => {
    const plugins = { community: adapter('native', { customProvider: true, requiresProvider: true, providerProtocols: ['anthropic-messages'] }) }
    expect(() => resolveHarnessSelector({ harness: 'community', model: 'raw', provider: 'other' }, config, plugins)).not.toThrow()
    expect(() => resolveHarnessSelector({ harness: 'community', model: 'raw', provider: 'local' }, config, plugins)).toThrow(/community.*协议/)
    expect(() => resolveHarnessSelector({ harness: 'community', model: 'raw' }, config, plugins)).toThrow(/community.*provider/)
    expect(() => resolveHarnessSelector({ harness: 'community', provider: 'other' }, config, plugins)).toThrow(/community.*非空模型/)
    expect(() => resolveHarnessSelector({ harness: 'plain-native' }, config, { 'plain-native': adapter('native') })).not.toThrow()
  })
  it.each([
    ['claude-code', 'local', false], ['claude-code', 'other', true], ['claude-code', 'responses', false],
    ['codex', 'local', true], ['codex', 'other', false], ['codex', 'responses', true],
  ])('%s / %s 协议兼容=%s', (harness, provider, valid) => {
    const check = () => validateHarnessSelector({ harness: String(harness), provider: String(provider) }, config, harnesses)
    if (valid) expect(check).not.toThrow()
    else expect(check).toThrow('协议')
  })
  it('递归检查 loop、subflow 和 rubric，override 与运行选择保持一致', () => {
    const profile: AgentProfile = { role: 'dev', title: '', description: '', instructions: '', skills: [], writeScope: [], harness: { harness: 'plain' } }
    const nested: WorkflowDefinition = { id: 'nested', version: '1', title: '', stages: [], nodes: [{ id: 'gate', kind: 'gate', title: '', checks: [{ id: 'rubric', kind: 'rubric', role: 'dev', rubric: '', threshold: 80 }] }] }
    const workflow: WorkflowDefinition = { ...nested, nodes: [{ id: 'loop', kind: 'loop', title: '', maxIterations: 1, until: () => true, body: [{ id: 'sub', kind: 'subflow', title: '', workflow: nested }] }] }
    const context = { config, profiles: { dev: profile }, harnesses }
    const visited: string[] = []
    forEachRoleSelector(workflow, (role) => visited.push(role))
    expect(visited).toEqual(['dev'])
    expect(() => validateWorkflowHarnesses(workflow, context)).not.toThrow()
    expect(() => validateWorkflowHarnesses(workflow, context, 'missing')).toThrow('harness 不存在')
    expect(() => validateWorkflowHarnesses(workflow, { ...context, profiles: {} })).toThrow('角色不存在')
  })
})
