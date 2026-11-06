/**
 * usePresence 的进出场时序（m3-web 动效规范）：挂载先 enter 一帧再 open；关闭保留 exitMs；退出途中重开直接回 open。
 * vitest 跑在 node 环境、没有 DOM 库：用 react-dom/client 渲染一个返回 null 的探针组件，
 * 容器只需要 nodeType / addEventListener；rAF 与计时器都由 fake timers 驱动。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePresence, type PresenceState } from './motion'

type Snap = { mounted: boolean; state: PresenceState }

function fakeContainer(): Element {
  const doc = { nodeType: 9, addEventListener() {}, removeEventListener() {} }
  return { nodeType: 1, nodeName: 'DIV', tagName: 'DIV', ownerDocument: doc, addEventListener() {}, removeEventListener() {} } as unknown as Element
}

// react-dom 只用到 window.HTMLIFrameElement（取焦点元素）；motion.tsx 用 matchMedia 判断减少动态效果
const fakeWindow = (reduced: boolean) => ({ HTMLIFrameElement: class {}, matchMedia: () => ({ matches: reduced }) })

let root: Root
let last: Snap
function Probe({ open, exitMs }: { open: boolean; exitMs: number }) {
  last = usePresence(open, exitMs)
  return null
}
const render = (open: boolean, exitMs = 140) => act(() => root.render(createElement(Probe, { open, exitMs })))
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms))

beforeEach(() => {
  vi.useFakeTimers()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  vi.stubGlobal('window', fakeWindow(false))
  root = createRoot(fakeContainer())
})
afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('usePresence', () => {
  it('初始关闭时不挂载；初始打开时直接 open', () => {
    render(false)
    expect(last).toEqual({ mounted: false, state: 'exit' })
    act(() => root.unmount())
    root = createRoot(fakeContainer())
    render(true)
    expect(last).toEqual({ mounted: true, state: 'open' })
  })

  it('打开：先 enter 保留两帧，再进入 open', () => {
    render(false)
    render(true)
    expect(last).toEqual({ mounted: true, state: 'enter' })
    advance(16)
    expect(last.state).toBe('enter')
    advance(16)
    expect(last).toEqual({ mounted: true, state: 'open' })
  })

  it('关闭：exit 保留 exitMs 后卸载', () => {
    render(true)
    render(false, 140)
    expect(last).toEqual({ mounted: true, state: 'exit' })
    advance(139)
    expect(last.mounted).toBe(true)
    advance(1)
    expect(last).toEqual({ mounted: false, state: 'exit' })
  })

  it('退出途中重开：直接回 open，不重新 enter，卸载计时被取消', () => {
    render(true)
    render(false, 140)
    advance(60)
    render(true, 140)
    expect(last).toEqual({ mounted: true, state: 'open' })
    advance(500)
    expect(last).toEqual({ mounted: true, state: 'open' })
  })

  it('减少动态效果：关闭不等待', () => {
    vi.stubGlobal('window', fakeWindow(true))
    render(true)
    render(false, 140)
    advance(0)
    expect(last.mounted).toBe(false)
  })
})
