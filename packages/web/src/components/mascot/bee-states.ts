// 节拍蜂状态表（docs/design/27 §2）：每个状态 = 默认表情 + 基础循环（bee.css）+ 一池小动作（洗牌轮换 / 加权随机触发）。
// 动作字段：fx 部件 → 关键帧（bee-a-*）；face 临时表情；ov 叠加物（'-x' 表示暂时去掉 x）；
// seq [毫秒, 补丁] 动作中途换表情；look [毫秒, x, y] 眼珠路径；prop 只在拿着该道具时可用；tools 只在可换工具时可用；logo 品牌标也能用。
import type { BeeProp } from './bee-markup'

export type BeeState = 'idle' | 'greet' | 'work' | 'think' | 'ask' | 'done' | 'failed' | 'sleep'
export type BeeEyes = 'open' | 'wide' | 'focus' | 'sad' | 'closed' | 'happy' | 'x' | 'squeeze' | 'wink' | 'peek'
export type BeeMouth = 'smile' | 'o' | 'wave' | 'big' | 'flat' | 'yawn' | 'cat' | 'pout' | 'sad'
export type BeePart = 'act' | 'breath' | 'wl' | 'wr' | 'aL' | 'aR' | 'hl' | 'hr' | 'pr'
export interface BeeFace {
  eyes?: BeeEyes
  mouth?: BeeMouth
  blush?: boolean
}
export interface BeeAct {
  id: string
  name: string
  w?: number
  dur: number
  fx?: Partial<Record<BeePart, string>>
  face?: BeeFace
  ov?: string[]
  seq?: Array<[number, BeeFace & { nextTool?: boolean }]>
  look?: Array<[number, number, number]>
  prop?: BeeProp
  tools?: boolean
  logo?: boolean
}
export interface BeeStateDef {
  label: string
  face: Required<Pick<BeeFace, 'eyes' | 'mouth'>>
  look?: [number, number]
  ov?: string[]
  gap: [number, number]
  enter?: string
  acts: BeeAct[]
}

export const OPEN_EYES = new Set<string>(['open', 'wide', 'focus', 'sad'])

export const STATES: Record<BeeState, BeeStateDef> = {
  idle: {
    label: '待命', face: { eyes: 'open', mouth: 'smile' }, gap: [1600, 3800],
    acts: [
      { id: 'look', name: '左右张望', w: 3, dur: 2300, logo: true, look: [[0, -1.6, .2], [800, 1.6, .2], [1700, 0, 0]] },
      { id: 'antwig', name: '天线抖一抖', w: 3, dur: 900, logo: true, fx: { aL: 'antwig', aR: 'antwig' } },
      { id: 'yawn', name: '打哈欠', w: 2, dur: 1900, fx: { breath: 'yawn' }, face: { eyes: 'closed', mouth: 'yawn' }, seq: [[1500, { eyes: 'open', mouth: 'smile' }]] },
      { id: 'stretch', name: '伸伸翅膀', w: 2, dur: 1400, logo: true, fx: { wl: 'stretch', wr: 'stretch' }, face: { eyes: 'happy' } },
      { id: 'hop', name: '原地小跳', w: 2, dur: 800, logo: true, fx: { act: 'hop' } },
      { id: 'hum', name: '哼小曲', w: 2, dur: 2400, fx: { act: 'sway' }, face: { eyes: 'closed', mouth: 'cat' }, ov: ['note'] },
      { id: 'loop', name: '绕个小圈', w: 1, dur: 1200, logo: true, fx: { act: 'loop', wl: 'flutter', wr: 'flutter' } },
      { id: 'tilt', name: '歪头看你', w: 2, dur: 1600, fx: { act: 'tilt' }, face: { mouth: 'cat', blush: true }, look: [[0, 0, .6]] },
      { id: 'scratch', name: '挠挠头', w: 1, dur: 1500, fx: { hl: 'scratch' }, face: { eyes: 'happy', mouth: 'flat' } },
    ],
  },
  greet: {
    label: '打招呼', face: { eyes: 'happy', mouth: 'big' }, gap: [1000, 2400], enter: 'wave',
    acts: [
      { id: 'wave', name: '挥挥手', w: 4, dur: 1600, fx: { hr: 'wave' } },
      { id: 'wink', name: '眨个眼', w: 2, dur: 1000, fx: { act: 'tilt' }, face: { eyes: 'wink', mouth: 'smile' } },
      { id: 'bow', name: '鞠个躬', w: 2, dur: 1300, fx: { act: 'bow', aL: 'ding', aR: 'ding' }, face: { eyes: 'closed', mouth: 'smile' } },
      { id: 'heart', name: '冒个爱心', w: 2, dur: 1400, fx: { act: 'bounce2' }, face: { mouth: 'cat', blush: true }, ov: ['heart'] },
      { id: 'hop', name: '蹦一下', w: 1, dur: 800, fx: { act: 'hop' } },
      { id: 'twirl', name: '转个圈', w: 1, dur: 1100, fx: { act: 'spin' }, face: { eyes: 'squeeze' } },
    ],
  },
  work: {
    label: '干活', face: { eyes: 'open', mouth: 'flat' }, gap: [1000, 2600],
    acts: [
      { id: 'swap', name: '换个工具', w: 3, dur: 900, tools: true, fx: { pr: 'toss' }, face: { eyes: 'wide', mouth: 'o' }, seq: [[450, { nextTool: true }]] },
      { id: 'twist', name: '拧一拧', w: 3, dur: 1200, prop: 'wrench', fx: { pr: 'twist' }, face: { eyes: 'focus' } },
      { id: 'scan', name: '放大镜扫一扫', w: 3, dur: 2000, prop: 'lens', fx: { hr: 'scan' }, face: { eyes: 'wide', mouth: 'o' }, look: [[200, 1, 0], [700, -1, 0], [1500, 0, 0]] },
      { id: 'read', name: '翻翻笔记', w: 3, dur: 2000, prop: 'note', fx: { hr: 'read' }, look: [[200, 1.2, 1], [700, .5, 1], [1100, 1.2, 1], [1500, .5, 1], [1800, 0, 0]] },
      { id: 'shake', name: '摇摇试管', w: 3, dur: 1100, prop: 'tube', fx: { pr: 'shaketube' }, face: { eyes: 'focus', mouth: 'o' } },
      { id: 'send', name: '派出去', w: 3, dur: 1200, prop: 'mail', fx: { pr: 'send', act: 'flinch' }, face: { eyes: 'happy', mouth: 'smile' } },
      { id: 'conduct', name: '打拍子', w: 3, dur: 2400, prop: 'baton', fx: { pr: 'conduct', act: 'nod' }, face: { eyes: 'happy' } },
      { id: 'gavel', name: '敲一槌', w: 3, dur: 900, prop: 'gavel', fx: { pr: 'gavel' }, seq: [[420, { eyes: 'squeeze' }], [680, { eyes: 'open' }]] },
      { id: 'ring', name: '摇摇铃', w: 3, dur: 1000, prop: 'bell', fx: { pr: 'ring' }, face: { eyes: 'happy', mouth: 'o' } },
      { id: 'measure', name: '量一量', w: 3, dur: 1400, prop: 'ruler', fx: { hr: 'measure' }, face: { eyes: 'focus' }, look: [[200, 1, .8], [1200, 0, 0]] },
      { id: 'focus', name: '盯紧', w: 2, dur: 1600, fx: { act: 'focus' }, face: { eyes: 'focus' } },
      { id: 'wipe', name: '擦擦汗', w: 1, dur: 1500, fx: { hl: 'wipe' }, face: { eyes: 'closed', mouth: 'wave' }, ov: ['sweat'] },
      { id: 'ding', name: '天线一亮', w: 2, dur: 700, fx: { aL: 'ding', aR: 'ding' }, face: { eyes: 'wide' }, ov: ['ding'] },
      { id: 'nod', name: '跟拍点头', w: 2, dur: 1200, fx: { act: 'nod' } },
    ],
  },
  think: {
    label: '思考', face: { eyes: 'open', mouth: 'flat' }, look: [1.1, -1.4], ov: ['think'], gap: [1400, 3200],
    acts: [
      { id: 'headtap', name: '拍拍脑袋', w: 3, dur: 1400, fx: { hl: 'headtap' }, face: { eyes: 'focus' } },
      { id: 'dart', name: '眼珠转一转', w: 3, dur: 1800, look: [[0, -1.4, -1.2], [450, 1.4, -1.4], [900, -1.2, 0], [1350, 1.1, -1.4]] },
      { id: 'tilt', name: '歪头琢磨', w: 2, dur: 1600, fx: { act: 'tilt' }, face: { mouth: 'wave' } },
      { id: 'swirl', name: '天线转圈', w: 2, dur: 1200, fx: { aL: 'swirl', aR: 'swirl' } },
      { id: 'hmm', name: '嗯……', w: 2, dur: 1400, fx: { breath: 'hmm' }, face: { eyes: 'focus', mouth: 'wave' } },
      { id: 'idea', name: '灵光一闪', w: 1, dur: 1700, fx: { act: 'hop', aL: 'ding', aR: 'ding' }, face: { eyes: 'wide', mouth: 'o' }, ov: ['bulb', '-think'], look: [[0, 0, -1]], seq: [[600, { eyes: 'happy', mouth: 'big' }]] },
    ],
  },
  ask: {
    label: '求助', face: { eyes: 'open', mouth: 'o' }, look: [.3, .3], ov: ['ask'], gap: [1200, 2800], enter: 'raise',
    acts: [
      { id: 'raise', name: '举手', w: 3, dur: 1700, fx: { hr: 'raise' }, face: { eyes: 'wide' } },
      { id: 'bounce', name: '跳着催', w: 2, dur: 1000, fx: { act: 'bounce2' } },
      { id: 'peek', name: '探头看你', w: 2, dur: 1600, fx: { act: 'lean' }, face: { mouth: 'smile' }, look: [[0, -.4, .6]] },
      { id: 'flutter', name: '扑扑翅膀', w: 2, dur: 900, fx: { wl: 'flutter', wr: 'flutter' } },
      { id: 'plead', name: '眼巴巴', w: 2, dur: 1900, fx: { breath: 'hmm' }, face: { eyes: 'wide', mouth: 'wave', blush: true } },
      { id: 'ding', name: '天线竖起来', w: 1, dur: 700, fx: { aL: 'ding', aR: 'ding' }, ov: ['ding'] },
    ],
  },
  done: {
    label: '完成', face: { eyes: 'happy', mouth: 'big' }, ov: ['stars'], gap: [800, 2000], enter: 'hop',
    acts: [
      { id: 'hop', name: '蹦一下', w: 3, dur: 800, fx: { act: 'hop' } },
      { id: 'spin', name: '空翻', w: 2, dur: 1100, fx: { act: 'spin' }, face: { eyes: 'squeeze' } },
      { id: 'double', name: '连蹦两下', w: 2, dur: 1300, fx: { act: 'double' } },
      { id: 'yeah', name: '举手比耶', w: 2, dur: 1200, fx: { hr: 'yeah' }, face: { eyes: 'wink' } },
      { id: 'confetti', name: '撒花', w: 2, dur: 1400, fx: { act: 'bounce2' }, ov: ['confetti'] },
      { id: 'clap', name: '扑翅欢呼', w: 2, dur: 1000, fx: { wl: 'clap', wr: 'clap' } },
      { id: 'wiggle', name: '扭一扭', w: 2, dur: 1200, fx: { act: 'wiggle' }, face: { mouth: 'cat' } },
    ],
  },
  failed: {
    label: '失败', face: { eyes: 'sad', mouth: 'wave' }, look: [0, .6], ov: ['drop'], gap: [2000, 4200], enter: 'sigh',
    acts: [
      { id: 'sigh', name: '叹口气', w: 3, dur: 1800, fx: { breath: 'sigh' }, face: { eyes: 'closed', mouth: 'o' }, ov: ['puff'], seq: [[1300, { eyes: 'sad', mouth: 'wave' }]] },
      { id: 'shake', name: '摇摇头', w: 2, dur: 900, fx: { act: 'shake' }, face: { eyes: 'squeeze', mouth: 'sad' } },
      { id: 'dizzy', name: '眼冒金星', w: 1, dur: 2000, fx: { act: 'wiggle' }, face: { eyes: 'x' }, ov: ['dizzy', '-drop'] },
      { id: 'tear', name: '抹眼泪', w: 2, dur: 1700, fx: { hl: 'rub' }, face: { eyes: 'closed', mouth: 'sad' }, ov: ['tear'] },
      { id: 'perk', name: '打起精神', w: 2, dur: 1700, fx: { act: 'perk', aL: 'ding', aR: 'ding' }, face: { eyes: 'focus', mouth: 'flat' }, ov: ['-drop'], seq: [[1200, { eyes: 'sad', mouth: 'wave' }]] },
      { id: 'droop', name: '天线耷拉', w: 2, dur: 1100, fx: { aL: 'droop', aR: 'droop' }, face: { mouth: 'sad' } },
    ],
  },
  sleep: {
    label: '睡着', face: { eyes: 'closed', mouth: 'o' }, ov: ['z'], gap: [2600, 5000],
    acts: [
      { id: 'snore', name: '吹鼻涕泡', w: 3, dur: 2400, face: { mouth: 'smile' }, ov: ['snore', '-z'] },
      { id: 'mumble', name: '说梦话', w: 2, dur: 1600, fx: { breath: 'hmm' }, face: { mouth: 'wave' }, seq: [[500, { mouth: 'cat' }], [1000, { mouth: 'wave' }]] },
      { id: 'twitch', name: '天线抽一下', w: 2, dur: 700, fx: { aR: 'twitch' } },
      { id: 'roll', name: '翻个身', w: 2, dur: 2400, fx: { act: 'roll' }, face: { mouth: 'cat' } },
      { id: 'peek', name: '眯眼偷看', w: 1, dur: 1500, face: { eyes: 'peek', mouth: 'flat' }, look: [[0, .6, .4]] },
      { id: 'dip', name: '打瞌睡点头', w: 2, dur: 1700, fx: { act: 'dip' }, seq: [[1040, { eyes: 'wide', mouth: 'o' }], [1360, { eyes: 'closed' }]] },
    ],
  },
}

// 点击（戳）和悬停的反应，任何状态都能触发
export const REACTIONS: Record<string, BeeAct> = {
  giggle: { id: 'giggle', name: '咯咯笑', dur: 900, fx: { act: 'jiggle' }, face: { eyes: 'squeeze', mouth: 'big', blush: true } },
  boing: { id: 'boing', name: '吓一跳', dur: 900, fx: { act: 'jump', wl: 'flutter', wr: 'flutter' }, face: { eyes: 'wide', mouth: 'o' }, ov: ['bang'] },
  squish: { id: 'squish', name: '被捏扁', dur: 800, fx: { act: 'squish' }, face: { eyes: 'squeeze', mouth: 'cat' } },
  grump: { id: 'grump', name: '别戳啦', dur: 1400, fx: { act: 'shake' }, face: { eyes: 'focus', mouth: 'pout', blush: true } },
  wake: { id: 'wake', name: '被戳醒', dur: 1400, fx: { act: 'jump', wl: 'flutter', wr: 'flutter' }, face: { eyes: 'wide', mouth: 'o' }, ov: ['bang', '-z'], seq: [[950, { eyes: 'peek', mouth: 'flat' }]] },
  notice: { id: 'notice', name: '注意到你', dur: 800, fx: { aL: 'ding', aR: 'ding' }, face: { eyes: 'wide', mouth: 'smile' } },
}

export const EASE: Record<string, string> = {
  hop: 'cubic-bezier(.3,.7,.4,1)', double: 'cubic-bezier(.3,.7,.4,1)', jump: 'cubic-bezier(.3,.7,.4,1)', spin: 'cubic-bezier(.45,0,.3,1)',
  squish: 'cubic-bezier(.2,.8,.3,1)', loop: 'linear', toss: 'cubic-bezier(.4,0,.3,1)', send: 'cubic-bezier(.4,0,.3,1)', flutter: 'linear', ring: 'linear', shaketube: 'linear',
}

/** 干活时轮换的工具，对应运行事件里的工具调用类型（lib/actions.ts）。 */
export const TOOLS: BeeProp[] = ['note', 'lens', 'wrench', 'tube', 'mail']
