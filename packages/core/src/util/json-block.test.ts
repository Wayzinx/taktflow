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
