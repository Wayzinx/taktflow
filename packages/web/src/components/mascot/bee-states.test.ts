import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { beeMarkup, PROPS } from './bee-markup'
import { REACTIONS, STATES, TOOLS, type BeeAct } from './bee-states'

const css = readFileSync(new URL('./bee.css', import.meta.url), 'utf8')
const markup = beeMarkup()
const all: Array<[string, BeeAct]> = [...Object.entries(STATES).flatMap(([s, d]) => d.acts.map((a) => [s, a] as [string, BeeAct])), ...Object.values(REACTIONS).map((a) => ['reaction', a] as [string, BeeAct])]

describe('节拍蜂状态表', () => {
  it('动作用到的关键帧都在 bee.css 里', () => {
    const missing = all.flatMap(([s, a]) => Object.values(a.fx ?? {}).filter((kf) => !css.includes(`@keyframes bee-a-${kf} {`)).map((kf) => `${s}.${a.id}: bee-a-${kf}`))
    expect(missing).toEqual([])
  })

  it('叠加物、道具都画了，并且有显示规则', () => {
    const ovs = new Set(all.flatMap(([, a]) => (a.ov ?? []).map((x) => x.replace(/^-/, ''))).concat(Object.values(STATES).flatMap((d) => d.ov ?? [])))
    for (const ov of ovs) {
      expect(markup, ov).toContain(`ov-${ov}"`)
      expect(css, ov).toContain(`[data-ov~="${ov}"] .ov-${ov}`)
    }
    for (const p of [...TOOLS, ...all.map(([, a]) => a.prop).filter(Boolean)]) {
      expect(PROPS).toHaveProperty(p!)
      expect(css, p).toContain(`[data-prop="${p}"] .pp-${p}`)
    }
  })

  it('入场动作存在；同一状态里动作 id 不重复；表情都有显示规则', () => {
    for (const [s, d] of Object.entries(STATES)) {
      if (d.enter) expect(d.acts.map((a) => a.id), s).toContain(d.enter)
      expect(new Set(d.acts.map((a) => a.id)).size, s).toBe(d.acts.length)
      const faces = [d.face, ...d.acts.flatMap((a) => [a.face ?? {}, ...(a.seq ?? []).map(([, f]) => f)])]
      for (const f of faces) {
        if (f.eyes) expect(css, `${s} eyes ${f.eyes}`).toContain(`[data-eyes="${f.eyes}"]`)
        if (f.mouth) expect(css, `${s} mouth ${f.mouth}`).toContain(`[data-mouth="${f.mouth}"] .mo-${f.mouth}`)
      }
    }
  })

  it('品牌标至少有几个轻量动作；中途变化都发生在动作结束前', () => {
    expect(STATES.idle.acts.filter((a) => a.logo).length).toBeGreaterThanOrEqual(4)
    for (const [s, a] of all) for (const [t] of [...(a.seq ?? []), ...(a.look ?? [])]) expect(t, `${s}.${a.id}`).toBeLessThan(a.dur)
  })
})
