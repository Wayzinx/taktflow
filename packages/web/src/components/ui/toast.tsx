import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Check, CircleAlert, Info, Undo2, X } from 'lucide-react'
import { toneVar, type Tone } from '../../lib/status'
import { prefersReducedMotion } from '../../lib/motion'
import './primitives.css'

export interface ToastOptions {
  body?: ReactNode
  /** success（默认）/ failed / waiting / running / pending … 只决定图标与细条颜色。 */
  tone?: Tone
  /** 能撤销的操作带撤销按钮；点击后执行并收起这条提示。 */
  undo?: () => void | Promise<void>
  /** 其他动作（"查看"）。 */
  action?: { label: string; onClick: () => void }
  /** 毫秒，默认 5000；悬停时暂停。 */
  duration?: number
}

interface ToastItem extends ToastOptions {
  id: number
  title: string
  leaving?: boolean
  done?: boolean
}

let seq = 0
const subs = new Set<(t: ToastItem | { dismiss: number }) => void>()

/**
 * 成功反馈（体验基线 2）：底部居中升起，5 秒后消失，最多堆叠 3 条；能撤销的都带撤销。
 *   toast('已归档 REQ-007', { undo: () => ds.restoreRequirement('REQ-007', '撤销归档') })
 *   toast('保存失败', { tone: 'failed', body: e.message })
 * 返回 id，可用 dismissToast(id) 提前收起。
 */
export function toast(title: string, opts: ToastOptions = {}): number {
  const t: ToastItem = { id: ++seq, title, ...opts }
  subs.forEach((f) => f(t))
  return t.id
}
export function dismissToast(id: number) {
  subs.forEach((f) => f({ dismiss: id }))
}

const MAX = 3
const EXIT_MS = 160

const ICON: Partial<Record<Tone, typeof Check>> = { success: Check, failed: CircleAlert, waiting: CircleAlert }

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([])
  const [hover, setHover] = useState(false)
  const leave = (id: number) => setItems((s) => s.map((x) => (x.id === id ? { ...x, leaving: true } : x)))

  useEffect(() => {
    const on = (t: ToastItem | { dismiss: number }) => {
      if ('dismiss' in t) return leave(t.dismiss)
      // 超过 3 条：最早的一条先退出
      setItems((s) => {
        const live = s.filter((x) => !x.leaving)
        const drop = live.length >= MAX ? live[0]!.id : undefined
        return [...s.map((x) => (x.id === drop ? { ...x, leaving: true } : x)), t]
      })
    }
    subs.add(on)
    return () => {
      subs.delete(on)
    }
  }, [])

  // 计时：悬停时整体暂停；退出帧保留 EXIT_MS 后移除
  const started = useRef(new Map<number, number>())
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = []
    for (const t of items) {
      if (t.leaving) {
        timers.push(setTimeout(() => setItems((s) => s.filter((x) => x.id !== t.id)), prefersReducedMotion() ? 0 : EXIT_MS))
        continue
      }
      if (hover) continue
      const at = started.current.get(t.id) ?? Date.now()
      started.current.set(t.id, at)
      const left = Math.max(400, (t.duration ?? 5000) - (Date.now() - at))
      timers.push(setTimeout(() => leave(t.id), left))
    }
    return () => timers.forEach(clearTimeout)
  }, [items, hover])
  useEffect(() => {
    // 悬停期间重置计时起点：移开后重新给满时长
    if (hover) started.current.clear()
  }, [hover])

  return (
    <div className="toaster" role="status" aria-live="polite" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {items.map((t) => {
        const tone = t.tone ?? 'success'
        const Icon = ICON[tone] ?? Info
        return (
          <div key={t.id} className="toast" data-state={t.leaving ? 'exit' : 'open'} style={{ '--tone': toneVar(tone) } as CSSProperties}>
            <span className="toast-icon" aria-hidden>
              <Icon />
            </span>
            <div className="toast-text">
              <div className="toast-title">{t.title}</div>
              {t.body && <div className="toast-body">{t.body}</div>}
            </div>
            {t.undo && (
              <button
                type="button"
                className="toast-btn"
                onClick={() => {
                  leave(t.id)
                  void Promise.resolve(t.undo!()).catch((e: Error) => toast('撤销失败', { tone: 'failed', body: e.message }))
                }}
              >
                <Undo2 aria-hidden />
                撤销
              </button>
            )}
            {t.action && (
              <button
                type="button"
                className="toast-btn"
                onClick={() => {
                  leave(t.id)
                  t.action!.onClick()
                }}
              >
                {t.action.label}
              </button>
            )}
            <button type="button" className="toast-close" onClick={() => leave(t.id)} aria-label="关闭提示">
              <X aria-hidden />
            </button>
          </div>
        )
      })}
    </div>
  )
}
