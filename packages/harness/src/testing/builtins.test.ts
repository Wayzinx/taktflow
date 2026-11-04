import { createClaudeCodeHarness, createClaudeCodeParser } from '../claude-code.js'
import { createCodexHarness, createCodexParser } from '../codex.js'
import { createDshHarness, createDshParser } from '../dsh.js'
import { createMockHarness } from '../mock.js'
import { createCliHarness, createCliParser } from '../adapters/cli-generic.js'
import { parseHarnessStream, runHarnessConformance } from './index.js'
import { claudeFixtures, codexFixtures, dshFixtures, genericConfig, genericFixtures, mockFixtures } from './fixtures.js'

for (const [name, parser, factory, fixtures] of [
  ['claude-code', createClaudeCodeParser, createClaudeCodeHarness, claudeFixtures],
  ['codex', createCodexParser, createCodexHarness, codexFixtures],
  ['dsh', createDshParser, createDshHarness, dshFixtures],
] as const) {
  runHarnessConformance(name, {
    parse: parseHarnessStream(parser), fixtures,
    runtime: { create: bin => factory({ bin }), replay: fixtures },
  })
}

runHarnessConformance('generic', {
  parse: parseHarnessStream(onEvent => createCliParser(genericConfig, onEvent)), fixtures: genericFixtures,
  runtime: { create: bin => createCliHarness({ ...genericConfig, command: [bin] }), replay: genericFixtures },
})

runHarnessConformance('mock', {
  parse: async (script, onEvent, req) => createMockHarness(script).run(req, onEvent), fixtures: mockFixtures,
  cancellation: () => createMockHarness({ steps: [{ finalText: 'should cancel' }] }),
})
