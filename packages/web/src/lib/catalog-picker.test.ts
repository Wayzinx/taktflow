import { describe, expect, it } from 'vitest'
import type { CatalogModel, RuntimeCatalog } from '@taktflow/core'
import { catalogToPicker, contextText, findPicked } from './catalog-picker'

const m = (id: string, x: Partial<CatalogModel> = {}): CatalogModel => ({ id, label: id, origin: 'discovered', ...x })
type H = RuntimeCatalog['harnesses'][number]
const harness = (id: string, x: Partial<H> = {}): H => ({ id, displayName: id, source: 'builtin', available: true, capabilities: {}, roles: [], accepts: [], ...x })

const catalog = (): RuntimeCatalog => ({
  harnesses: [
    harness('native', { displayName: 'native', source: 'native', capabilities: { requiresProvider: true, customProvider: true } }),
    harness('claude-code', { displayName: 'Claude Code', own: { source: 'live', models: [m('opus', { origin: 'harness', efforts: ['low', 'high', 'max'], defaultEffort: 'high' })] } }),
    harness('trae', { displayName: 'TRAE', own: { source: 'live', models: [m('glm-5', { origin: 'harness' })] } }),
    harness('dsh', { displayName: 'DeepSeek Harness', ownReady: false, ownReason: '没登录 DeepSeek 账号' }),
    harness('mock', { displayName: 'Mock', testOnly: true }),
  ],
  providers: [
    { id: 'gw', displayName: 'gw', protocols: ['openai-chat'], keyPresent: true, models: { source: 'live', models: [m('flash-v4', { alias: 'flash', contextWindow: 1_048_576, reasoning: true }), m('old-1', { deprecated: true }), m('glm-5')] } },
    { id: 'nokey', displayName: 'NoKey', protocols: ['anthropic-messages'], keyPresent: false, models: { source: 'preset', models: [m('k1')], error: '缺少密钥 NOKEY' } },
  ],
  pairings: [
    { harness: 'native', provider: 'gw', status: 'direct', protocol: 'openai-chat' },
    { harness: 'native', provider: 'nokey', status: 'direct', protocol: 'anthropic-messages' },
    { harness: 'claude-code', provider: null, status: 'builtin' },
    { harness: 'claude-code', provider: 'gw', status: 'bridge', protocol: 'anthropic-messages', upstream: 'openai-chat' },
    { harness: 'claude-code', provider: 'nokey', status: 'direct', protocol: 'anthropic-messages' },
    { harness: 'trae', provider: null, status: 'builtin' },
    { harness: 'trae', provider: 'gw', status: 'unavailable', reason: 'TRAE 不能换 API' },
    { harness: 'dsh', provider: null, status: 'builtin' },
    { harness: 'dsh', provider: 'gw', status: 'direct', protocol: 'openai-chat' },
  ],
  enrichment: 'ok',
})

describe('catalogToPicker', () => {
  it('测试替身不进选择器；native 没有「自带」组', () => {
    const hs = catalogToPicker(catalog())
    expect(hs.map((h) => h.id)).toEqual(['native', 'claude-code', 'trae', 'dsh'])
    expect(hs[0]!.groups.map((g) => g.key)).toEqual(['p:gw', 'p:nokey'])
  })

  it('自带组先放默认模型，再放 harness 列出的模型和推理强度', () => {
    const claude = catalogToPicker(catalog()).find((h) => h.id === 'claude-code')!
    expect(claude.groups.map((g) => [g.key, g.note])).toEqual([['own', '自带'], ['p:gw', '经协议桥'], ['p:nokey', '直连']])
    expect(claude.groups[0]!.models.map((x) => x.label)).toEqual(['默认模型', 'opus'])
    expect(claude.groups[0]!.models[1]).toMatchObject({ model: 'opus', efforts: ['low', 'high', 'max'], defaultEffort: 'high' })
  })

  it('配了别名的写别名、不带 provider；下架的放最后并置灰；缺密钥整组不可选', () => {
    const claude = catalogToPicker(catalog()).find((h) => h.id === 'claude-code')!
    const gw = claude.groups[1]!
    expect(gw.models.map((x) => [x.model, x.provider, x.available])).toEqual([['flash', undefined, true], ['glm-5', 'gw', true], ['old-1', 'gw', false]])
    expect(gw.models[0]).toMatchObject({ aliases: ['flash-v4'], detail: '别名 flash', tags: ['桥接', '推理', '1M'] })
    expect(gw.models[2]!.tags).toEqual(['已下架'])
    expect(gw.hint).toContain('中间自动转换')
    const nokey = claude.groups[2]!
    expect(nokey.models.every((x) => !x.available)).toBe(true)
    expect(nokey.hint).toContain('缺少密钥')
  })

  it('搭不上的 provider 收进最后一组，只说明不能选', () => {
    const trae = catalogToPicker(catalog()).find((h) => h.id === 'trae')!
    const off = trae.groups.at(-1)!
    expect(off).toMatchObject({ key: 'off', label: '搭不上的 API' })
    expect(off.models).toEqual([
      expect.objectContaining({ label: 'gw', info: true, reason: 'TRAE 不能换 API' }),
      expect.objectContaining({ label: 'NoKey', info: true, reason: expect.stringContaining('Anthropic') }),
    ])
  })

  it('自带账号没登录时只有「自带」那组不可用，API 组照常', () => {
    const dsh = catalogToPicker(catalog()).find((h) => h.id === 'dsh')!
    expect(dsh.available).toBe(true)
    expect(dsh.groups[0]).toMatchObject({ key: 'own', hint: '没登录 DeepSeek 账号' })
    expect(dsh.groups[0]!.models.every((x) => !x.available)).toBe(true)
    expect(dsh.groups[1]!.models[0]!.available).toBe(true)
  })

  it('选中值按别名或厂商 ID 都能认出来', () => {
    const hs = catalogToPicker(catalog())
    expect(findPicked(hs, { harness: 'native', model: 'flash' })?.key).toBe('p:gw:flash-v4')
    expect(findPicked(hs, { harness: 'native', model: 'flash-v4', provider: 'gw' })?.key).toBe('p:gw:flash-v4')
    expect(findPicked(hs, { harness: 'trae' })?.key).toBe('own:')
    expect(findPicked(hs, { harness: 'native', model: 'nope' })).toBeUndefined()
  })

  it('上下文长度写成 K / M', () => {
    expect([contextText(131072), contextText(1_048_576), contextText(168000), contextText(1_000_000), contextText()]).toEqual(['128K', '1M', '168K', '1M', undefined])
  })

  it('同组里同名的模型写出 ID 区分', () => {
    const c = catalog()
    c.providers[0]!.models.models.push(m('gw-opus-a', { label: 'Opus' }), m('gw-opus-b', { label: 'Opus' }))
    const gw = catalogToPicker(c)[0]!.groups[0]!
    expect(gw.models.filter((x) => x.label === 'Opus').map((x) => x.detail)).toEqual(['gw-opus-a', 'gw-opus-b'])
    expect(gw.models[1]!.detail).toBeUndefined()
  })
})
