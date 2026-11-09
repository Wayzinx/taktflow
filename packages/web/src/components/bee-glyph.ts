import { createLucideIcon } from 'lucide-react'

/** 节拍蜂的线稿图标：圆身、两道纹、带圆点的触角；24 网格、2px 描边、圆角端点，和 lucide 图标放在一起不跳。翅膀在 14px 下会糊成一团，线稿里不画。 */
export const BeeGlyph = createLucideIcon('BeeGlyph', [
  ['circle', { cx: '12', cy: '14.5', r: '6.5', key: 'body' }],
  ['path', { d: 'M5.7 13h12.6', key: 's1' }],
  ['path', { d: 'M6.3 17h11.4', key: 's2' }],
  ['path', { d: 'M10 8.3 8.8 4.6', key: 'al' }],
  ['path', { d: 'M14 8.3l1.2-3.7', key: 'ar' }],
  ['circle', { cx: '8.5', cy: '3.6', r: '.4', key: 'tl' }],
  ['circle', { cx: '15.5', cy: '3.6', r: '.4', key: 'tr' }],
])
