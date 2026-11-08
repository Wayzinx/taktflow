/** 时间轴：可见窗口 [t0, t1]（毫秒）到百分比 / 像素的换算，以及按宽度挑刻度步长。 */

export type Window = readonly [number, number]

export const pct = (t: number, [t0, t1]: Window) => ((t - t0) / Math.max(1, t1 - t0)) * 100

const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400].map((s) => s * 1000)

/** 刻度间距至少 minPx 像素；返回落在窗口内的整步刻度。 */
export function ticks([t0, t1]: Window, widthPx: number, minPx = 88): { step: number; at: number[] } {
  const span = Math.max(1, t1 - t0)
  const step = STEPS.find((s) => (s / span) * widthPx >= minPx) ?? STEPS[STEPS.length - 1]!
  // 按本地时区对齐整点（小时以下按 UTC 对齐即可，与本地相同）
  const off = new Date(t0).getTimezoneOffset() * 60_000
  const first = Math.ceil((t0 - off) / step) * step + off
  const at: number[] = []
  for (let t = first; t <= t1; t += step) at.push(t)
  return { step, at }
}

const p2 = (n: number) => String(n).padStart(2, '0')
export function tickLabel(t: number, step: number): string {
  const d = new Date(t)
  return step < 60_000 ? `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}` : `${p2(d.getHours())}:${p2(d.getMinutes())}`
}

/** 缩放到以 at 为中心、跨度乘以 factor 的窗口，限制在 [minSpan, 整体跨度 × 1.2] 内。 */
export function zoomAround([t0, t1]: Window, at: number, factor: number, full: Window, minSpan = 4000): Window {
  const fullSpan = full[1] - full[0]
  const span = Math.min(fullSpan * 1.2, Math.max(minSpan, (t1 - t0) * factor))
  const f = (at - t0) / Math.max(1, t1 - t0)
  return clampPan([at - span * f, at + span * (1 - f)], full)
}

/** 平移时不让窗口完全离开运行区间（两端各留 5%）。 */
export function clampPan([t0, t1]: Window, full: Window): Window {
  const span = t1 - t0
  const pad = (full[1] - full[0]) * 0.05
  const lo = full[0] - pad
  const hi = full[1] + pad
  if (span >= hi - lo) return [lo + (hi - lo - span) / 2, hi - (hi - lo - span) / 2]
  if (t0 < lo) return [lo, lo + span]
  if (t1 > hi) return [hi - span, hi]
  return [t0, t1]
}
