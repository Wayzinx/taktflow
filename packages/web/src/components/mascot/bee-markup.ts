// 节拍蜂的 SVG 内部结构（docs/design/27）。静态、无用户输入，按实例只换 clipPath id。
// 部件类名（act / breath / wl / wr / aL / aR / hl / hr / pr）就是动作表 fx 的键；表情、叠加物、道具都由根节点 data-* 切换（bee.css）。
export type BeeProp = 'baton' | 'note' | 'ruler' | 'wrench' | 'lens' | 'tube' | 'gavel' | 'bell' | 'mail'

const L = 'var(--m-line)'
let uid = 0

export const PROPS: Record<BeeProp, string> = {
  baton: `<path d="M2.5 13.5 13.5 2.5" stroke="${L}" stroke-width="1.6" stroke-linecap="round"/><circle cx="3" cy="13" r="2" fill="oklch(0.95 0.02 80)" stroke="${L}" stroke-width="1.2"/>`,
  note: `<rect x="2" y="2" width="12" height="12" rx="1.6" fill="oklch(0.9 0.12 95)" stroke="${L}" stroke-width="1.2"/><path d="M4.6 6h6.8M4.6 8.6h6.8M4.6 11.2h4" stroke="${L}" stroke-width="1" stroke-linecap="round"/>`,
  ruler: `<g transform="rotate(-32 8 8)"><rect x="0.5" y="5" width="15" height="6" rx="1.2" fill="oklch(0.88 0.1 85)" stroke="${L}" stroke-width="1.2"/><path d="M3.5 5v2.4M6.5 5v1.6M9.5 5v2.4M12.5 5v1.6" stroke="${L}" stroke-width="1"/></g>`,
  wrench: `<path d="M3 13 9.4 6.6" stroke="${L}" stroke-width="3.4" stroke-linecap="round"/><path d="M3 13 9.4 6.6" stroke="oklch(0.84 0.01 240)" stroke-width="1.6" stroke-linecap="round"/><path d="M9 4.2a3.6 3.6 0 0 1 5.2-1.4l-2.4 2.4.3 1.6 1.6.3 2.4-2.4A3.6 3.6 0 0 1 11 9z" fill="oklch(0.84 0.01 240)" stroke="${L}" stroke-width="1.1" stroke-linejoin="round"/>`,
  lens: `<path d="M9.6 9.6 14 14" stroke="${L}" stroke-width="2.8" stroke-linecap="round"/><circle cx="6.4" cy="6.4" r="4.4" fill="oklch(0.9 0.05 220 / .75)" stroke="${L}" stroke-width="1.5"/><path d="M4.4 5.2a2.4 2.4 0 0 1 2-1.6" stroke="#fff" stroke-width="1" stroke-linecap="round" fill="none"/>`,
  tube: `<g transform="rotate(22 8 8)"><rect x="5" y="0.8" width="6" height="14.4" rx="3" fill="oklch(0.98 0.005 80)" stroke="${L}" stroke-width="1.2"/><path d="M5.6 8.4h4.8v3.8a2.4 2.4 0 0 1-4.8 0z" fill="oklch(0.74 0.14 150)"/><path d="M4.4 1.2h7.2" stroke="${L}" stroke-width="1.2" stroke-linecap="round"/></g>`,
  gavel: `<path d="M7.4 8.6 14 15.2" stroke="${L}" stroke-width="2.4" stroke-linecap="round"/><g transform="rotate(-45 6 6)"><rect x="1" y="3.4" width="10" height="5.2" rx="1.3" fill="oklch(0.62 0.09 55)" stroke="${L}" stroke-width="1.2"/></g>`,
  bell: `<path d="M8 2.2c-2.8 0-4.4 2.2-4.4 5v2.6L2.4 12h11.2l-1.2-2.2V7.2c0-2.8-1.6-5-4.4-5z" fill="oklch(0.86 0.12 85)" stroke="${L}" stroke-width="1.2" stroke-linejoin="round"/><circle cx="8" cy="13.6" r="1.5" fill="${L}"/>`,
  mail: `<rect x="1.6" y="4" width="12.8" height="9" rx="1.4" fill="oklch(0.97 0.01 80)" stroke="${L}" stroke-width="1.2"/><path d="M2.4 4.8 8 9.2l5.6-4.4" fill="none" stroke="${L}" stroke-width="1.1" stroke-linejoin="round"/><circle cx="13" cy="4.6" r="2.1" fill="oklch(0.64 0.18 28)" stroke="${L}" stroke-width=".9"/>`,
}

function face(): string {
  const y = 32.6
  const side = (x: number, s: number) => {
    const k = s < 0 ? 'L' : 'R'
    const ox = x + s * 2.6
    const ix = x - s * 2.2
    const eq = s < 0 ? `M${x - 2} ${y - 2.2}l3.8 2.2-3.8 2.2` : `M${x + 2} ${y - 2.2}l-3.8 2.2 3.8 2.2`
    return `
    <g class="eye eo ${k}" style="transform-origin:${x}px ${y}px"><g class="bl" style="transform-origin:${x}px ${y}px"><g class="look">
      <ellipse cx="${x}" cy="${y}" rx="2.4" ry="3" fill="${L}"/><circle cx="${x + .9}" cy="${y - 1.1}" r=".9" fill="#fff"/></g></g></g>
    <g stroke="${L}" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round">
      <path class="eye ec ${k} ln" d="M${x - 2.5} ${y}q2.5 2.2 5 0"/>
      <path class="eye eh ${k} ln" d="M${x - 2.5} ${y + 1}q2.5-3.2 5 0"/>
      <path class="eye ex ${k} ln" d="M${x - 2} ${y - 2}l4 4m0-4-4 4"/>
      <path class="eye eq ${k} ln" d="${eq}"/>
      <path class="brow bw ${k}" stroke-width="1.5" d="M${ox} ${y - 4.4}L${ix} ${y - 5.9}"/>
      <path class="brow bf ${k}" stroke-width="1.5" d="M${ox} ${y - 5.9}L${ix} ${y - 4.3}"/>
    </g>
    <ellipse class="blush" cx="${x + s * 4}" cy="37.4" rx="2.8" ry="1.7" fill="var(--m-blush)" style="transform-origin:${x + s * 4}px 37.4px"/>`
  }
  return `${side(25.8, -1)}${side(38.2, 1)}
  <g class="mouth" stroke="${L}" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path class="mo mo-smile" d="M29.6 37.2q2.4 2.2 4.8 0"/>
    <ellipse class="mo mo-o" cx="32" cy="38" rx="1.4" ry="1.7" fill="${L}" stroke="none"/>
    <path class="mo mo-wave" d="M29 38.4q1.5-1.4 3 0t3 0"/>
    <path class="mo mo-big" d="M29.2 36.8h5.6q-.4 3.6-2.8 3.6t-2.8-3.6z" fill="oklch(0.62 0.16 25)"/>
    <path class="mo mo-flat" d="M30.4 38h3.2"/>
    <g class="mo mo-yawn" stroke="none"><ellipse cx="32" cy="38.6" rx="2.3" ry="2.9" fill="${L}"/><ellipse cx="32" cy="40.1" rx="1.4" ry=".9" fill="oklch(0.66 0.15 20)"/></g>
    <path class="mo mo-cat" d="M29 37.4q1.5 1.8 3 0q1.5 1.8 3 0"/>
    <path class="mo mo-pout" d="M31.2 36.6q1.9.7 0 1.5q1.9.7 0 1.5"/>
    <path class="mo mo-sad" d="M29.8 39.2q2.2-2 4.4 0"/>
  </g>`
}

function overlays(): string {
  const star = (x: number, y: number, s: number) => `<path class="spark" style="transform-origin:${x}px ${y}px" d="M${x} ${y - s}q.6 ${s * .7} ${s} ${s}q-${s * .4} .3 -${s} ${s}q-.6 -${s * .7} -${s} -${s}q${s * .4} -.3 ${s} -${s}z" fill="oklch(0.86 0.14 90)" stroke="${L}" stroke-width=".9"/>`
  const note = (x: number, y: number, s: number, delay: number) => `<g transform="translate(${x} ${y}) scale(${s})"><g class="n" style="animation-delay:${delay}ms"><ellipse rx="1.7" ry="1.25" transform="rotate(-20)" fill="${L}"/><path d="M1.5-.4v-6.4q2.6 1 2.4 3.6" stroke="${L}" stroke-width="1.1" fill="none" stroke-linecap="round"/></g></g>`
  const drop = (cls: string, d: string, o: string) => `<g class="ov ov-${cls}"><path style="transform-origin:${o}" d="${d}" fill="oklch(0.8 0.08 230)" stroke="${L}" stroke-width="1"/></g>`
  const CONF: Array<[number, number, number, string]> = [[-18, -12, 220, 'var(--c-1)'], [17, -14, -180, 'var(--c-5)'], [-22, 4, 160, 'var(--c-3)'], [22, 2, -240, 'var(--c-4)'], [-10, -20, 300, 'var(--c-8)'], [9, -21, -260, 'var(--c-2)'], [-26, -6, 200, 'var(--c-6)'], [26, -8, -200, 'var(--c-3)'], [-4, -24, 180, 'var(--c-4)'], [4, 10, -160, 'var(--c-1)']]
  return `
  <g class="ov ov-ask" style="transform-origin:52px 16px"><circle cx="52" cy="11" r="7" fill="var(--m-bubble)" stroke="${L}" stroke-width="1.5"/><path d="M49.7 8.9a2.4 2.4 0 1 1 3.4 2.1c-.8.4-1.1.9-1.1 1.7" stroke="${L}" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="52" cy="15.3" r="1.15" fill="${L}"/></g>
  <g class="ov ov-think"><g class="puffs" style="transform-origin:46px 20px" fill="var(--m-bubble)" stroke="${L}" stroke-width="1.2"><circle cx="45.6" cy="20.2" r="1.2"/><circle cx="48.4" cy="15.8" r="1.8"/><rect x="47" y="1.2" width="16.6" height="10.6" rx="5.3"/></g><g fill="${L}"><circle class="dot" cx="51.3" cy="6.5" r="1.15"/><circle class="dot" cx="55.3" cy="6.5" r="1.15"/><circle class="dot" cx="59.3" cy="6.5" r="1.15"/></g></g>
  <g class="ov ov-bulb" style="transform-origin:32px 12px"><g class="rays" style="transform-origin:32px 6px" stroke="oklch(0.8 0.15 85)" stroke-width="1.2" stroke-linecap="round"><path d="M25.6 4l-1.8-1M38.4 4l1.8-1M25.8 8.6l-1.8.6M38.2 8.6l1.8.6M32 -.6v-1.6"/></g><path d="M32 1.2a4.3 4.3 0 0 0-2.4 7.8v1.7h4.8V9A4.3 4.3 0 0 0 32 1.2z" fill="oklch(0.93 0.14 95)" stroke="${L}" stroke-width="1.1" stroke-linejoin="round"/><path d="M30.1 12.5h3.8" stroke="${L}" stroke-width="1.1" stroke-linecap="round"/></g>
  <g class="ov ov-z" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-weight="600" fill="var(--text-3)"><text x="46" y="18" font-size="6" style="transform-origin:47px 16px">z</text><text x="50" y="11.5" font-size="7.5" style="transform-origin:52px 9px">z</text><text x="55" y="5" font-size="9" style="transform-origin:57px 2px">z</text></g>
  <g class="ov ov-note">${note(50, 17, 1, 0)}${note(12, 19, .85, 600)}${note(56, 9, .75, 1100)}</g>
  <g class="ov ov-heart"><path style="transform-origin:51px 12px" d="M51 16.4c-4.4-3-6.4-5.2-6.4-7.6a3.2 3.2 0 0 1 6.4-1 3.2 3.2 0 0 1 6.4 1c0 2.4-2 4.6-6.4 7.6z" fill="oklch(0.7 0.18 15)" stroke="${L}" stroke-width="1.1" stroke-linejoin="round"/></g>
  ${drop('drop', 'M49 19c-1.6 2.6-2.6 4-2.6 5.2a2.6 2.6 0 0 0 5.2 0c0-1.2-1-2.6-2.6-5.2z', '49px 22px')}
  ${drop('sweat', 'M42.4 23.6c-1 1.6-1.6 2.5-1.6 3.3a1.6 1.6 0 0 0 3.2 0c0-.8-.6-1.7-1.6-3.3z', '42.4px 25px')}
  ${drop('tear', 'M23.2 35.6c-.9 1.5-1.5 2.3-1.5 3a1.5 1.5 0 0 0 3 0c0-.7-.6-1.5-1.5-3z', '23.2px 37px')}
  <g class="ov ov-stars">${star(9, 15, 3.6)}${star(55, 10, 3)}${star(57, 30, 2.4)}</g>
  <g class="ov ov-bang" style="transform-origin:53px 16px" stroke="oklch(0.62 0.18 30)" stroke-linecap="round"><path d="M53 4.4v6.4" stroke-width="2.8"/><path d="M53 15v.1" stroke-width="3.2"/><path d="M58 6.6l2-1.6M59 11.4h2.4" stroke-width="1.3"/></g>
  <g class="ov ov-puff" style="transform-origin:52px 37px" fill="var(--m-bubble)" stroke="${L}" stroke-width=".9"><circle cx="49.6" cy="37.6" r="2"/><circle cx="52.6" cy="36.4" r="2.7"/><circle cx="55.6" cy="38" r="2"/></g>
  <g class="ov ov-confetti">${CONF.map(([tx, ty, r, c], i) => i % 2 ? `<rect class="cf" x="30.8" y="22.3" width="2.6" height="1.5" rx=".4" fill="${c}" style="transform-origin:32px 23px;--tx:${tx}px;--ty:${ty}px;--r:${r}deg"/>` : `<circle class="cf" cx="32" cy="23" r="1.1" fill="${c}" style="transform-origin:32px 23px;--tx:${tx}px;--ty:${ty}px;--r:${r}deg"/>`).join('')}</g>
  <g class="ov ov-dizzy"><g transform="translate(32 19) scale(1 .38)"><g class="orbit" style="transform-origin:0 0">${[[13, 0], [-6.5, 11.3], [-6.5, -11.3]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.2" fill="oklch(0.86 0.14 90)" stroke="${L}" stroke-width="1"/>`).join('')}</g></g></g>
  <g class="ov ov-snore"><circle cx="37.8" cy="39.4" r="3.8" fill="oklch(0.9 0.05 230 / .6)" stroke="${L}" stroke-width=".8" style="transform-origin:34.4px 38.6px"/><circle cx="36.6" cy="38" r=".9" fill="#fff" opacity=".8" style="transform-origin:34.4px 38.6px"/></g>
  <g class="ov ov-ding" style="transform-origin:32px 10px" stroke="oklch(0.8 0.15 85)" stroke-width="1.3" stroke-linecap="round"><path d="M17.4 7.4l-1.8-1.6M21.4 6.2V3.8M25.2 7.2l1.6-1.8M38.8 7.2l-1.6-1.8M42.6 6.2V3.8M46.6 7.4l1.8-1.6"/></g>`
}

/** 一只蜂的 SVG 内部标记；`<svg class="bee" viewBox="0 0 64 64">` 由组件给出。 */
export function beeMarkup(): string {
  const id = `bee-clip-${++uid}`
  const wing = (d: string, vein: string) => `<path class="ln" d="${d}" fill="var(--m-wing)" stroke="${L}" stroke-width="1.3" stroke-linejoin="round"/><path class="vein" d="${vein}" stroke="${L}" stroke-width=".8" fill="none" opacity=".35" stroke-linecap="round"/>`
  const ant = (d: string, x: number) => `<path class="ln" d="${d}" stroke="${L}" stroke-width="1.8" fill="none" stroke-linecap="round"/><circle cx="${x}" cy="10.8" r="2.5" fill="${L}"/>`
  const hand = (x: number) => `<circle cx="${x}" cy="46.6" r="2.6" fill="color-mix(in oklch, var(--hue) 80%, var(--m-line))" stroke="${L}" stroke-width="1.3"/>`
  return `<ellipse class="shadow" cx="32" cy="61.6" rx="12" ry="1.7" fill="var(--m-line)" opacity=".13"/>
  <g class="act"><g class="pose"><g class="fly">
    <g class="wlP"><g class="wl">${wing('M24.5 29C15 16.5 4.6 20.6 7.6 28.6c2.2 5.6 10.8 5.6 16.9 2.6z', 'M21 28.4q-6-3.4 -10.4-2.4')}</g></g>
    <g class="wrP"><g class="wr">${wing('M39.5 29C49 16.5 59.4 20.6 56.4 28.6c-2.2 5.6-10.8 5.6-16.9 2.6z', 'M43 28.4q6-3.4 10.4-2.4')}</g></g>
    <g class="antL"><g class="aL">${ant('M27.4 24.4Q25 15 21.4 10.8', 21.4)}</g></g>
    <g class="antR"><g class="aR">${ant('M36.6 24.4Q39 15 42.6 10.8', 42.6)}</g></g>
    <g class="breath">
      <defs><clipPath id="${id}"><ellipse cx="32" cy="40" rx="18" ry="17"/></clipPath></defs>
      <ellipse cx="32" cy="40" rx="18" ry="17" fill="var(--hue)"/>
      <g clip-path="url(#${id})" fill="${L}" opacity=".86"><path d="M12 43.2q20 5 40 0v4.2q-20 5 -40 0z"/><path d="M12 50.6q20 5 40 0v4.2q-20 5 -40 0z"/></g>
      <ellipse class="ln" cx="32" cy="40" rx="18" ry="17" fill="none" stroke="${L}" stroke-width="1.8"/>
      ${face()}
    </g>
    <g class="hl">${hand(15.4)}</g>
    <g class="hr">${hand(48.6)}<g class="pr">${Object.entries(PROPS).map(([k, v]) => `<g class="pp pp-${k}"><g transform="translate(46 37) scale(.95)">${v}</g></g>`).join('')}</g></g>
    ${overlays()}
  </g></g></g>`
}
