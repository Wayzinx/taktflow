import type { BeeProp } from './bee-markup'
import { EASE, OPEN_EYES, REACTIONS, STATES, type BeeAct, type BeeFace, type BeePart, type BeeState } from './bee-states'

/** 'bag' 洗牌轮换（一轮内每个动作按权重出现、不连着重复）/ 'random' 加权随机（不连续重复）/ 'off' 只留基础循环与眨眼。 */
export type BeeMode = 'bag' | 'random' | 'off'

export interface BeeOptions {
  state: BeeState
  mode?: BeeMode
  /** 角色道具（固定拿着）。 */
  prop?: BeeProp
  /** 干活时轮换的工具；给了就忽略 prop。 */
  tools?: readonly BeeProp[]
  /** 状态之上的常驻表情（例如节点"压缩上下文"时眯眼）。 */
  face?: BeeFace
  /** 品牌标：只用标了 logo 的轻量动作。 */
  logo?: boolean
  /** 间隔倍数：品牌标等次要位置拉长。 */
  gapScale?: number
  /** 眼睛跟随指针。 */
  follow?: boolean
  onAct?: (act: BeeAct | null) => void
}

const PARTS: BeePart[] = ['act', 'breath', 'wl', 'wr', 'aL', 'aR', 'hl', 'hr', 'pr']
const reduce = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined
/** 减少动态效果或标签页在后台（pulse 维护 data-tab-hidden）时不挑新动作、不眨眼。 */
const motionOff = () => Boolean(reduce?.matches) || document.documentElement.hasAttribute('data-tab-hidden')
const rand = (a: number, b: number) => a + Math.random() * (b - a)

/**
 * 一只蜂一个引擎：状态决定默认表情和基础循环（CSS），空闲时按抖动的间隔挑一个小动作播放，眨眼单独随机。
 * 只改根节点 data-* 与部件的 style.animation，不触发 React 重渲染。
 */
export class BeeEngine {
  state: BeeState
  cur: BeeAct | null = null
  tool: BeeProp | undefined
  private parts: Partial<Record<BeePart, SVGElement>> = {}
  private actT: Array<ReturnType<typeof setTimeout>> = []
  private nextT?: ReturnType<typeof setTimeout>
  private blinkT?: ReturnType<typeof setTimeout>
  private lookBackT?: ReturnType<typeof setTimeout>
  private bag: BeeAct[] = []
  private last: BeeAct | null = null
  private actFace: BeeFace | null = null
  private actOv: string[] = []
  private pokes: number[] = []
  private visible = true
  private cleanup: Array<() => void> = []

  constructor(
    private svg: SVGSVGElement,
    private o: BeeOptions,
  ) {
    for (const p of PARTS) this.parts[p] = svg.querySelector<SVGElement>(`.${p}`) ?? undefined
    this.tool = o.tools?.[0]
    this.state = o.state
    if (typeof IntersectionObserver === 'function') {
      const io = new IntersectionObserver(([e]) => (this.visible = e?.isIntersecting ?? true))
      io.observe(svg)
      this.cleanup.push(() => io.disconnect())
    }
    if (o.follow) this.followPointer()
    this.setState(o.state, false)
    this.blinkLoop()
  }

  private get def() {
    return STATES[this.state]
  }

  /** 改选项；状态变了就带入场动作切过去。 */
  update(next: BeeOptions) {
    const prev = this.o
    this.o = next
    if (next.tools !== prev.tools) this.tool = next.tools?.[0]
    if (next.state !== this.state) return this.setState(next.state, true)
    if (next.mode !== prev.mode || next.logo !== prev.logo) {
      this.bag = []
      this.schedule()
    }
    this.apply()
  }

  destroy() {
    this.stopAct()
    clearTimeout(this.nextT)
    clearTimeout(this.blinkT)
    clearTimeout(this.lookBackT)
    this.cleanup.forEach((f) => f())
  }

  setState(s: BeeState, enter: boolean) {
    this.stopAct()
    this.state = s
    this.bag = []
    this.last = null
    this.svg.dataset.state = s
    this.apply()
    this.setLook(this.def.look ?? [0, 0])
    if (enter && this.def.enter && !motionOff()) this.later(() => this.play(this.def.enter!), 160)
    else this.schedule()
  }

  // ── 挑动作 ──
  private prop() {
    return this.state === 'work' && this.o.tools ? this.tool : this.o.prop
  }
  private pool() {
    const prop = this.prop()
    return this.def.acts.filter((a) => (!a.prop || a.prop === prop) && (!a.tools || this.o.tools) && (!this.o.logo || a.logo))
  }
  private pick(): BeeAct | undefined {
    const pool = this.pool()
    if (!pool.length) return undefined
    if (this.o.mode === 'random') {
      const cand = pool.length > 1 ? pool.filter((a) => a !== this.last) : pool
      let r = Math.random() * cand.reduce((n, a) => n + (a.w ?? 1), 0)
      return cand.find((a) => (r -= a.w ?? 1) < 0) ?? cand[0]
    }
    if (!this.bag.length) {
      const b = pool.flatMap((a) => Array<BeeAct>(Math.max(1, Math.round((a.w ?? 1) / 1.5))).fill(a))
      for (let i = b.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[b[i], b[j]] = [b[j]!, b[i]!]
      }
      // pop 从尾部取：相邻不重复，也别接上一轮最后一个
      const prev = (i: number) => (i === b.length - 1 ? this.last : b[i + 1])
      for (let i = b.length - 1; i >= 0; i--) {
        if (b[i] !== prev(i)) continue
        const k = b.findIndex((a, j) => j < i && a !== b[i] && a !== prev(i))
        if (k >= 0) [b[i], b[k]] = [b[k]!, b[i]!]
      }
      this.bag = b
    }
    return this.bag.pop()
  }
  private schedule() {
    clearTimeout(this.nextT)
    if ((this.o.mode ?? 'bag') === 'off' || this.cur) return
    const [a, b] = this.def.gap
    this.nextT = setTimeout(
      () => {
        if (!this.visible || motionOff() || this.cur) return this.schedule()
        const act = this.pick()
        if (act) this.play(act)
        else this.schedule()
      },
      rand(a, b) * (this.o.gapScale ?? 1),
    )
  }

  // ── 播放 ──
  play(ref: BeeAct | string) {
    const act = typeof ref === 'string' ? (this.def.acts.find((a) => a.id === ref) ?? REACTIONS[ref]) : ref
    if (!act || motionOff()) return
    this.stopAct()
    clearTimeout(this.nextT)
    this.cur = act
    this.last = act
    this.actFace = { ...act.face }
    this.actOv = act.ov ?? []
    this.svg.dataset.act = act.id
    for (const [part, kf] of Object.entries(act.fx ?? {}) as Array<[BeePart, string]>) {
      const el = this.parts[part]
      if (!el) continue
      el.style.animation = 'none'
      void el.getBoundingClientRect()
      el.style.animation = `bee-a-${kf} ${act.dur}ms ${EASE[kf] ?? 'ease-in-out'} both`
    }
    this.apply()
    for (const [t, x, y] of act.look ?? []) this.later(() => this.setLook([x, y]), t)
    for (const [t, patch] of act.seq ?? []) {
      this.later(() => {
        const { nextTool, ...face } = patch
        const tools = this.o.tools
        if (nextTool && tools?.length) this.tool = tools[(tools.indexOf(this.tool!) + 1) % tools.length]
        Object.assign(this.actFace!, face)
        this.apply()
      }, t)
    }
    this.later(() => this.endAct(), act.dur)
    this.o.onAct?.(act)
  }
  private endAct() {
    this.stopAct()
    this.setLook(this.def.look ?? [0, 0])
    this.o.onAct?.(null)
    this.schedule()
  }
  private stopAct() {
    this.actT.forEach(clearTimeout)
    this.actT = []
    if (!this.cur) return
    for (const part of Object.keys(this.cur.fx ?? {}) as BeePart[]) {
      const el = this.parts[part]
      if (el) el.style.animation = ''
    }
    this.cur = null
    this.actFace = null
    this.actOv = []
    delete this.svg.dataset.act
    this.apply()
  }
  private later(fn: () => void, ms: number) {
    this.actT.push(setTimeout(fn, ms))
  }

  // ── 表情、叠加物、道具：只写根节点 data-* ──
  private apply() {
    const f = { ...this.def.face, ...this.o.face, ...this.actFace }
    const ov = new Set(this.def.ov ?? [])
    for (const x of this.actOv) {
      if (x.startsWith('-')) ov.delete(x.slice(1))
      else ov.add(x)
    }
    const d = this.svg.dataset
    d.eyes = f.eyes
    d.mouth = f.mouth
    d.blush = f.blush ? '1' : ''
    d.ov = [...ov].join(' ')
    d.prop = this.prop() ?? ''
  }
  private setLook([x, y]: readonly [number, number]) {
    this.svg.style.setProperty('--lx', String(x))
    this.svg.style.setProperty('--ly', String(y))
  }

  // ── 眨眼：独立的随机节律，两成概率连眨两下 ──
  private blinkLoop() {
    this.blinkT = setTimeout(
      () => {
        if (!motionOff() && this.visible && OPEN_EYES.has(this.svg.dataset.eyes ?? '')) {
          this.blink()
          if (Math.random() < 0.22) setTimeout(() => this.blink(), 240)
        }
        this.blinkLoop()
      },
      rand(2200, 5600),
    )
  }
  private blink() {
    this.svg.dataset.blink = '1'
    setTimeout(() => delete this.svg.dataset.blink, 130)
  }

  // ── 互动 ──
  /** 点一下：咯咯笑 / 吓一跳 / 被捏扁；2.6 秒内连点四下"别戳啦"；睡着时被戳醒。 */
  poke() {
    const now = performance.now()
    this.pokes = this.pokes.filter((t) => now - t < 2600).concat(now)
    if (this.state === 'sleep') return this.play('wake')
    if (this.pokes.length >= 4) {
      this.pokes = []
      return this.play('grump')
    }
    const opts = ['giggle', 'boing', 'squish'].filter((k) => k !== this.cur?.id && k !== this.last?.id)
    this.play(opts[Math.floor(Math.random() * opts.length)]!)
  }
  /** 指针移进来：待命 / 打招呼时注意到你，睡着时眯眼偷看。 */
  hover() {
    if (this.cur || motionOff()) return
    if (this.state === 'idle' || this.state === 'greet') this.play('notice')
    else if (this.state === 'sleep') this.play('peek')
  }
  private followPointer() {
    const onMove = (e: PointerEvent) => {
      if (this.cur?.look || !OPEN_EYES.has(this.svg.dataset.eyes ?? '')) return
      const r = this.svg.getBoundingClientRect()
      const dx = e.clientX - (r.left + r.width / 2)
      const dy = e.clientY - (r.top + r.height / 2)
      const k = Math.min(1, Math.hypot(dx, dy) / (r.width * 1.2))
      const a = Math.atan2(dy, dx)
      this.setLook([+(Math.cos(a) * 1.6 * k).toFixed(2), +(Math.sin(a) * 1.4 * k).toFixed(2)])
      clearTimeout(this.lookBackT)
      this.lookBackT = setTimeout(() => !this.cur && this.setLook(this.def.look ?? [0, 0]), 2500)
    }
    addEventListener('pointermove', onMove, { passive: true })
    this.cleanup.push(() => removeEventListener('pointermove', onMove))
  }
}
