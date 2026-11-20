import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { ConnectDialog, type Pairing } from './connect-dialog.js'

vi.mock('../../components/ui/dialog.js', () => ({
  Dialog: ({ children }: { children: ReactNode }) => children,
}))

it.each(['http://127.0.0.1:4870', 'http://localhost:4870', 'http://[::1]:4870'])('访问 %s 的配对向导默认等候另一台电脑的地址', hub => {
  const pairing: Pairing = {
    displayName: '开发机', platform: 'mac', nodeId: 'computer-001', harness: 'codex',
    spaceId: 'shop', hub, code: 'fixture-code', expiresAt: '2026-11-20T12:00:00Z',
  }
  const html = renderToStaticMarkup(createElement(ConnectDialog, {
    open: true, pairing, expired: false, busy: false, onClose() {}, onLink() {},
  }))
  expect(html).toMatch(/<input[^>]*checked=""[^>]*\/> 另一台电脑/)
  expect(html).toMatch(/<input[^>]*inputMode="url"[^>]*value=""/i)
  expect(html).not.toContain('下载命令')
  expect(html).not.toContain('启动命令')
  expect(html).not.toContain(pairing.code)
})
