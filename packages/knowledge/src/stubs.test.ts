import { expect, it } from 'vitest'
import { createApiRegistrySource, createCodeGraphSource, createDatabaseSource } from './stubs.js'

it.each([
  [createCodeGraphSource, 'codegraph', 'impact', 'CodeGraph'],
  [createDatabaseSource, 'database', 'schema', '只读'],
  [createApiRegistrySource, 'api-registry', 'fact', 'OpenAPI'],
] as const)('%s 返回空结果并说明 M1 接入方式', async (factory, id, intent, integration) => {
  const source = factory()
  expect(source.id).toBe(id)
  expect(source.kind).toBe(id)
  expect(source.intents).toEqual([intent])
  expect(source.describe()).toContain('M1')
  expect(source.describe()).toContain(integration)
  expect(await source.query({ text: 'query', intent })).toEqual([])
})
