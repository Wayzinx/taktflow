import { expect, it } from 'vitest'
import { extractJsonBlock } from './json-block.js'

it('仅使用最后一个明确 JSON 块，末块损坏或未闭合不会回退', () => {
  const first = '```json\n{"old":true}\n```\n'
  expect(extractJsonBlock(`${first}text\n \t\`\`\`JSON\r\n[1,2]\r\n \`\`\`\r\n`)).toEqual([1, 2])
  expect(extractJsonBlock(`${first}\`\`\`json\n{broken}\n\`\`\``)).toBeUndefined()
  expect(extractJsonBlock(`${first}\`\`\`json\n{"new":true}`)).toBeUndefined()
  expect(extractJsonBlock('{"plain":true}')).toBeUndefined()
  expect(extractJsonBlock('```json\nfalse\n```')).toBe(false)
})

it('块里先抄了 schema 再写结果（几个 JSON 值首尾相接）时取最后一个；其中任何一段坏了仍不接受', () => {
  const schema = '{"type":"object","required":["checks"],"properties":{"checks":{"type":"array"}}}'
  const data = '{"checks":[{"id":"c1","pass":true,"evidence":"a } ] \\" b"}]}'
  expect(extractJsonBlock(`说明\n\n\`\`\`json\n${schema}\n${data}\n\`\`\`\n`)).toEqual({ checks: [{ id: 'c1', pass: true, evidence: 'a } ] " b' }] })
  expect(extractJsonBlock(`\`\`\`json\n${schema}${data}\n\`\`\``)).toEqual({ checks: [{ id: 'c1', pass: true, evidence: 'a } ] " b' }] })
  expect(extractJsonBlock(`\`\`\`json\n${schema}\n{broken}\n\`\`\``)).toBeUndefined()
  expect(extractJsonBlock(`\`\`\`json\n${schema}\n{"a":1\n\`\`\``)).toBeUndefined()
  expect(extractJsonBlock('```json\n{"a":1} trailing\n```')).toBeUndefined()
})
