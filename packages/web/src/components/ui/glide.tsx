import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'

/**
 * 竖向滑块：列表的"当前项"底色跟着选中项滑过去（transform 平移，高度直接设定、不过渡），和 Tabs / Segmented 的横向指示器同一套做法。
 *   const [ref, glide] = useGlide<HTMLElement>('.item.active')
 *   <nav ref={ref} className="list"><GlideMark glide={glide} className="list-glide" />…</nav>
 * 容器要 position: relative（或 sticky）；滑块是容器的第一个子元素，列表项画在它上面。
 */
export function useGlide<T extends HTMLElement>(selector: string) {
  const ref = useRef<T>(null)
  const [glide, setGlide] = useState<{ y: number; h: number } | null>(null)
  useLayoutEffect(() => {
    const root = ref.current
    const el = root?.querySelector<HTMLElement>(selector)
    if (!root || !el) return setGlide(null)
    // 列表项可能包在别的定位元素里（offsetTop 不可靠）：按视口坐标差算，加上容器自身的滚动
    const next = { y: Math.round(el.getBoundingClientRect().top - root.getBoundingClientRect().top - root.clientTop + root.scrollTop), h: el.offsetHeight }
    setGlide((g) => (g && g.y === next.y && g.h === next.h ? g : next))
  })
  return [ref, glide] as const
}

export function GlideMark({ glide, className }: { glide: { y: number; h: number } | null; className?: string }) {
  if (!glide) return null
  return <span className={`glide${className ? ` ${className}` : ''}`} aria-hidden style={{ height: glide.h, '--glide-y': `${glide.y}px` } as CSSProperties} />
}
