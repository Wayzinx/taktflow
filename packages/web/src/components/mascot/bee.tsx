import { memo, useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react'
import { BeeEngine, type BeeMode, type BeeOptions } from './bee-engine'
import { beeMarkup, type BeeProp } from './bee-markup'
import type { BeeAct, BeeFace, BeeState } from './bee-states'
import './bee.css'

export interface BeeProps {
  state?: BeeState
  /** 像素；≤ 24 只留轮廓、条纹和眼睛，≤ 40 线条加粗。 */
  size?: number
  /** 身体颜色：品牌蜂用默认蜂蜜色，Agent 按 harness 着色。 */
  hue?: string
  /** 状态之上的常驻表情。 */
  face?: BeeFace
  /** 角色道具。 */
  prop?: BeeProp
  /** 干活时在这些工具之间轮换（传稳定的数组）。 */
  tools?: readonly BeeProp[]
  mode?: BeeMode
  logo?: boolean
  gapScale?: number
  follow?: boolean
  /** 点它会被戳、指针移入会注意到你。 */
  interactive?: boolean
  /** 静止头像：关掉基础循环和小动作，只留表情与眨眼。 */
  still?: boolean
  /** 安静：关掉基础循环，只在切状态时播入场动作（DAG 里不在跑的节点）。 */
  calm?: boolean
  label?: string
  className?: string
  onAct?: (act: BeeAct | null) => void
}

/**
 * 节拍蜂（docs/design/27 §2）。SVG 只渲染一次，之后由 BeeEngine 改根节点 data-*；
 * 状态变化带入场动作（完成先蹦一下、失败先叹气……），减少动态效果时只留每个状态的静态表情。
 */
export const Bee = memo(function Bee({ state = 'idle', size, hue, face, prop, tools, mode, logo, gapScale, follow, interactive, still, calm, label, className, onAct }: BeeProps) {
  const ref = useRef<SVGSVGElement>(null)
  const engine = useRef<BeeEngine | null>(null)
  const markup = useMemo(() => ({ __html: beeMarkup() }), [])
  const onActRef = useRef(onAct)
  useEffect(() => {
    onActRef.current = onAct
  })
  const opts: BeeOptions = { state, face, prop, tools, logo, gapScale, follow, mode: still || calm ? 'off' : mode, onAct: (a) => onActRef.current?.(a) }

  // 绘制前建引擎，首帧就有表情
  useLayoutEffect(() => {
    const e = new BeeEngine(ref.current!, opts)
    engine.current = e
    return () => e.destroy()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [follow])
  useEffect(() => {
    engine.current?.update(opts)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, face?.eyes, face?.mouth, face?.blush, prop, tools, logo, gapScale, mode, still, calm])

  const tier = size === undefined ? '' : size <= 24 ? ' tiny' : size <= 40 ? ' small' : ''
  return (
    <svg
      ref={ref}
      className={`bee${tier}${still ? ' still' : calm ? ' calm' : ''}${interactive ? ' is-interactive' : ''}${className ? ` ${className}` : ''}`}
      // 小尺寸裁掉阴影和叠加物的留白，身体放大约 14%
      viewBox={tier === ' tiny' ? '4 6 56 56' : '0 0 64 64'}
      width={size}
      height={size}
      style={hue ? ({ '--hue': hue } as CSSProperties) : undefined}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      onClick={interactive ? () => engine.current?.poke() : undefined}
      onPointerEnter={interactive ? () => engine.current?.hover() : undefined}
      dangerouslySetInnerHTML={markup}
    />
  )
})
