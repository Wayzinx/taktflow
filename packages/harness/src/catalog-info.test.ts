import { expect, it } from 'vitest'
import type { HarnessInfo, TaktConfig } from '@taktflow/core'
import { harnessCatalogInfo } from './catalog-info.js'

const config: TaktConfig = { project: { name: '目录' }, workflows: [], harnessOverrides: { codex: { disabled: true } }, harnesses: [
  { id: 'subscription', kind: 'acp', preset: 'claude' },
  { id: 'command', kind: 'cli', command: ['custom'], output: { format: 'text' } },
] }
const info = (id: string): HarnessInfo => ({ id, displayName: id, source: 'builtin', available: false, capabilities: {}, roles: [] })

it('品牌、订阅来源、安装提示、hidden/testOnly 与 ACP 预设一致', () => {
  expect(harnessCatalogInfo(info('codex'), config)).toMatchObject({ icon: 'codex', ownLabel: '使用 ChatGPT 账号', hidden: true, install: expect.any(String) })
  expect(harnessCatalogInfo(info('subscription'), config)).toMatchObject({ icon: 'claude', ownLabel: '使用个人 Claude 订阅', install: expect.stringContaining('claude-agent-acp') })
  expect(harnessCatalogInfo(info('mock'), config).testOnly).toBe(true)
  expect(harnessCatalogInfo(info('command'), config).icon).toBeUndefined()
  expect(harnessCatalogInfo(info('native'), config)).toMatchObject({ icon: 'takt', displayName: '直连 API（内置）' })
  expect(harnessCatalogInfo(info('native'), config).ownLabel).toBeUndefined()
})
