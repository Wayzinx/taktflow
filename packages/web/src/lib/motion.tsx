import { useEffect, useRef, useState } from 'react'

/**
 * 弹层 / 对话框 / 下拉 / 抽屉的进出场（docs/dev/m3-web.md 动效规范）。
 *
 * - open 变 true：先以 `enter` 挂载一帧（初始样式），下一帧进入 `open`，CSS 过渡从 enter → open；
 * - open 变 false：进入 `exit` 并保留最后一帧 exitMs 毫秒，之后 mounted 为 false；
 * - 退出期间重新打开会直接打断退出回到 `open`，不会重挂载；
 * - 用户开了"减少动态效果"时不等待退出。
 *
 * 用法：
 *   const p = usePresence(open, 140)
 *   if (!p.mounted) return null
 *   return <div className="menu" data-state={p.state}>…</div>
 * CSS 里按 `[data-state='enter']` / `[data-state='exit']` 写初始与退出样式，`[data-state='open']` 为常态。
 */
export type PresenceState = 'enter' | 'open' | 'exit'

export function usePresence(open: boolean, exitMs = 140): { mounted: boolean; state: PresenceState } {
  const [mounted, setMounted] = useState(open)
  const [state, setState] = useState<PresenceState>(open ? 'open' : 'exit')

  // open 变化：全新挂载先 enter；退出途中重开直接回 open（清掉卸载计时，不重挂载）
  useEffect(() => {
    if (open) {
      setMounted(true)
      setState(mounted ? 'open' : 'enter')
      return
    }
    if (!mounted) return
    setState('exit')
    const timer = setTimeout(() => setMounted(false), prefersReducedMotion() ? 0 : exitMs)
    return () => clearTimeout(timer)
    // mounted 只读渲染时的值：它只由这里和计时器改，不需要作为依赖重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, exitMs])

  // enter 保留一帧初始样式（两次 rAF：先提交再绘制），之后进入 open，让 CSS 过渡起跑
  useEffect(() => {
    if (state !== 'enter') return
    let r2 = 0
    const r1 = requestAnimationFrame(() => (r2 = requestAnimationFrame(() => setState('open'))))
    return () => {
      cancelAnimationFrame(r1)
      cancelAnimationFrame(r2)
    }
  }, [state])

  // 刚打开、effect 还没跑的那一帧也按 enter 渲染
  return { mounted: mounted || open, state: open && !mounted ? 'enter' : state }
}

/** 保留最后一个非空值：关闭弹层时 props 已清空，退出动画期间仍渲染关闭前的内容。 */
export function useLastDefined<T>(value: T | undefined | null): T | undefined {
  const ref = useRef<T | undefined>(undefined)
  if (value !== undefined && value !== null) ref.current = value
  return ref.current
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}
