import { useEffect, useState } from 'react'
import { prefersReducedMotion } from '../../../lib/motion'

export const DEFAULT_HINT = '发消息，@lead 让 Lead 处理，@ 成员通知对方'

const EXAMPLES = [
  '@lead 现在卡在哪一步？',
  '@lead 导出文件名的日期改成 YYYYMMDD，按 T1 走',
  '@lead 系分评审打回的两条，先修金额精度那条',
  '@lin 技术方案 v2 的接口变更帮忙看一下',
  '@lead 这次预算快用完了，先停掉并行任务',
]

const CHAR_MS = 28
const HOLD_MS = 3200
const EXIT_MS = 140

/**
 * 输入框的占位语轮播：示例逐字淡入、停留一会儿、快速退出，换下一条。
 * 只在输入框空着且没聚焦时播放；聚焦、有内容或"减少动态效果"时停在静态提示。
 * 纯装饰（aria-hidden），读屏读 textarea 自己的 aria-label / placeholder。
 */
export function ComposerHint({ active }: { active: boolean }) {
  const [i, setI] = useState(0)
  const [phase, setPhase] = useState<'in' | 'out'>('in')
  const animate = active && !prefersReducedMotion()

  useEffect(() => {
    if (!animate) return
    const text = EXAMPLES[i % EXAMPLES.length]!
    const ms = phase === 'in' ? [...text].length * CHAR_MS + HOLD_MS : EXIT_MS
    const t = setTimeout(() => {
      if (phase === 'in') setPhase('out')
      else {
        setI((x) => x + 1)
        setPhase('in')
      }
    }, ms)
    return () => clearTimeout(t)
  }, [animate, i, phase])

  if (!active) return null
  if (!animate) return <span className="chat-hint-rot" aria-hidden="true">{DEFAULT_HINT}</span>
  const text = EXAMPLES[i % EXAMPLES.length]!
  return (
    <span key={i} className="chat-hint-rot" data-phase={phase} aria-hidden="true">
      <span className="chat-hint-try">试试</span>
      {[...text].map((c, k) => (
        <span key={k} className="chat-hint-ch" style={{ animationDelay: `${k * CHAR_MS}ms` }}>
          {c}
        </span>
      ))}
    </span>
  )
}
