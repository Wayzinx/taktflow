import { useEffect, useRef, useState } from 'react'

/**
 * 新行闪烁（体验基线 4）：首屏之后新出现的 key，底色闪一下、1.2s 淡出（.flash-row）。首屏的行不闪。
 *   const flash = useFlashRows(rows.map((r) => r.id))
 *   <tr key={r.id} className={`row ${flash(r.id)}`}>
 */
export function useFlashRows(keys: string[], ms = 1200): (key: string) => string {
  const seen = useRef<Set<string> | null>(null)
  const [fresh, setFresh] = useState<Set<string>>(new Set())
  const sig = keys.join('\u0001')
  useEffect(() => {
    if (seen.current === null) {
      // 首屏：只记下来，不闪
      if (keys.length) seen.current = new Set(keys)
      return
    }
    const added = keys.filter((k) => !seen.current!.has(k))
    keys.forEach((k) => seen.current!.add(k))
    if (!added.length) return
    setFresh((s) => new Set([...s, ...added]))
    const t = setTimeout(() => setFresh((s) => new Set([...s].filter((k) => !added.includes(k)))), ms)
    return () => clearTimeout(t)
    // keys 用 sig 比较
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, ms])
  return (key: string) => (fresh.has(key) ? 'flash-row' : '')
}

/** 单个值变化时闪一下（卡片数字、状态标签）：返回的 key 变化时重挂 class。 */
export function useFlashOnChange(value: unknown): string {
  const prev = useRef(value)
  const [on, setOn] = useState(false)
  useEffect(() => {
    if (Object.is(prev.current, value)) return
    prev.current = value
    setOn(false)
    const r = requestAnimationFrame(() => setOn(true))
    const t = setTimeout(() => setOn(false), 1200)
    return () => {
      cancelAnimationFrame(r)
      clearTimeout(t)
    }
  }, [value])
  return on ? 'flash-row' : ''
}
