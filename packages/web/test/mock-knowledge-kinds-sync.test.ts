/**
 * mock 的知识库类型必须与服务端 kinds 同形（评审发现：mock 自造的字段名 kind/dsn/spec 让表单在真实服务端上全部失效，
 * needsBuild 也与服务端相反）。直接读 packages/knowledge 源码里的内置类型比对。
 */
import { describe, expect, it } from 'vitest'
import { builtinKinds } from '../../knowledge/src/kinds/index.js'
import { KINDS, seedBases } from '../src/api/mock-knowledge-seed'
import { defaultsOf, fieldsOf, missingFields, parseNumber, setWikiMode, wikiMode, type Schema } from '../src/pages/knowledge/schema-config'

const shape = (k: { kind: string; title: string; summary: string; intents: string[]; needsBuild: boolean; configSchema: unknown }) => ({ kind: k.kind, title: k.title, summary: k.summary, intents: k.intents, needsBuild: k.needsBuild, configSchema: k.configSchema })

describe('mock knowledge kinds', () => {
  it('lists exactly the server kinds', () => {
    expect(KINDS.map((k) => k.kind).sort()).toEqual(builtinKinds.map((k) => k.kind).sort())
  })
  it('matches every server kind shape (schema, needsBuild, intents)', () => {
    for (const real of builtinKinds) expect(shape(KINDS.find((k) => k.kind === real.kind)!)).toEqual(shape(real))
  })
  it('seed bases only use fields the server schema declares (or requires)', () => {
    for (const b of seedBases()) {
      const kind = KINDS.find((k) => k.kind === b.kind)!
      const keys = fieldsOf(kind.configSchema as Schema).map(([k]) => k)
      for (const k of Object.keys(b.config)) expect(keys, `${b.id}.${k}`).toContain(k)
    }
  })
})

describe('schema-config', () => {
  const schemaOf = (kind: string) => KINDS.find((k) => k.kind === kind)!.configSchema as Schema
  it('rag defaults to one upload source and wants a file', () => {
    const cfg = defaultsOf(schemaOf('rag'))
    expect(cfg.sources).toEqual([{ type: 'upload' }])
    expect(missingFields('rag', cfg, 0, schemaOf('rag'))).toEqual(['至少上传一个文件'])
    expect(missingFields('rag', cfg, 2, schemaOf('rag'))).toEqual([])
    expect(missingFields('rag', { sources: [{ type: 'repo' }] }, 0, schemaOf('rag'))).toEqual(['仓库'])
  })
  it('api: openapi is required even though the schema has no property for it', () => {
    expect(fieldsOf(schemaOf('api')).map(([k]) => k)).toContain('openapi')
    expect(missingFields('api', defaultsOf(schemaOf('api')), 0, schemaOf('api'))).toEqual(['OpenAPI 地址或文件'])
    expect(missingFields('api', { openapi: 'https://x/openapi.json' }, 0, schemaOf('api'))).toEqual([])
  })
  it('database requires driver and connection', () => {
    expect(missingFields('database', defaultsOf(schemaOf('database')), 0, schemaOf('database'))).toEqual(['连接串'])
  })
  it('llm-wiki switches between source and generate', () => {
    const cfg = defaultsOf(schemaOf('llm-wiki'))
    expect(wikiMode(cfg)).toBe('space')
    const gen = setWikiMode(cfg, 'generate')
    expect(gen.source).toBeUndefined()
    expect(wikiMode(gen)).toBe('generate')
    expect(missingFields('llm-wiki', gen, 0, schemaOf('llm-wiki'))).toEqual(['仓库'])
    expect(setWikiMode(gen, 'path')).toEqual({ source: 'path' })
  })
  it('parses integers as numbers, empty as undefined', () => {
    expect(parseNumber('800', true)).toBe(800)
    expect(parseNumber('12.7', true)).toBe(12)
    expect(parseNumber('', true)).toBeUndefined()
    expect(parseNumber('0.5', false)).toBe(0.5)
  })
})
