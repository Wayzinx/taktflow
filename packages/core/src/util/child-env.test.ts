import { afterEach, expect, it, vi } from 'vitest'
import { command } from '../engine/process.js'
import { childEnv } from './child-env.js'

afterEach(() => vi.unstubAllEnvs())

it('子进程环境去掉外层 Claude Code 会话标记，其余继承，调用方显式给的照传', async () => {
  vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'host-session'); vi.stubEnv('CLAUDE_CODE_MESSAGING_TOKEN', 'host-token'); vi.stubEnv('TAKT_KEEP', 'kept')
  const env = childEnv({ CLAUDE_PID: 'explicit' })
  expect(env).toMatchObject({ TAKT_KEEP: 'kept', CLAUDE_PID: 'explicit' })
  expect(env).not.toHaveProperty('CLAUDE_CODE_SESSION_ID')
  expect(env).not.toHaveProperty('CLAUDE_CODE_MESSAGING_TOKEN')
  const result = await command('printf "%s|%s" "${CLAUDE_CODE_MESSAGING_TOKEN:-none}" "$TAKT_KEEP"', process.cwd(), {})
  expect(result).toMatchObject({ code: 0, output: 'none|kept' })
})
