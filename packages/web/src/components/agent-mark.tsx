import type { NodeActivity, NodeStatus } from '@taktflow/core'
import { actionKind } from '../lib/actions'
import { roleHue, roleProp } from '../lib/roles'
import { Bee, type BeeFace, type BeeProp, type BeeState } from './mascot'
import { PROPS } from './mascot/bee-markup'
import './agent-mark.css'

/**
 * Agent 形象（docs/design/25 §2 → 27 §2）：节拍蜂。状态：待命、干活、求助（头顶符号）、完成、失败；
 * 不用任何第三方品牌图形；颜色和道具都按角色稳定分配，名字在 label / 悬停提示里。
 */
export type MarkState = 'idle' | 'work' | 'ask' | 'done' | 'failed'
// ux-audit: ok '…' 是形象头顶的符号（长时间没有新动作），不是加载文案
export type MarkSign = '!' | '?' | '✕' | 'z' | '…'
/** 运行中细分（docs/design/26 §1）：思考看上方、读搜眼睛左右扫、改低头、跑命令专注、压缩眯眼、等工具半闭眼。 */
export type MarkAct = 'think' | 'read' | 'edit' | 'run' | 'compact' | 'wait'

export function actOf(a: NodeActivity | undefined): MarkAct | undefined {
  if (!a) return undefined
  if (a.state === 'thinking') return 'think'
  if (a.state === 'compacting') return 'compact'
  if (a.state === 'waiting_tool') return 'wait'
  const k = actionKind(a.tool ?? '')
  return k === 'read' || k === 'search' || k === 'web' || k === 'knowledge' ? 'read' : k === 'edit' ? 'edit' : 'run'
}

/** 长步骤：同一状态持续 15 秒以上。 */
export const LONG_STEP_MS = 15_000

export function markOf(status: NodeStatus, form?: 'approve' | 'answer' | 'choice'): { state: MarkState; sign?: MarkSign } {
  switch (status) {
    case 'running':
      return { state: 'work' }
    case 'waiting_human':
      return { state: 'ask', sign: form === 'approve' || !form ? '!' : '?' }
    case 'blocked':
      return { state: 'ask', sign: '!' }
    case 'succeeded':
      return { state: 'done' }
    case 'failed':
      return { state: 'failed', sign: '✕' }
    default:
      return { state: 'idle' }
  }
}

/**
 * harness 的颜色（时间线的调用条按它着色；蜂的身体色按角色，见 roleHue）。同一家的 CLI 与 ACP 入口同色；
 * --c-4（琥珀）和管家的蜂蜜色太近，不分给 harness。
 */
const KNOWN: Record<string, number> = { native: 1, codex: 2, 'codex-acp': 2, gemini: 6, 'gemini-acp': 6, 'claude-code': 8, 'claude-acp': 8, cursor: 5, qwen: 3, kimi: 3, opencode: 2, pi: 6, dsh: 1, mock: 7 }
const POOL = [1, 2, 3, 5, 6, 8]
/** 同一个 harness 全站同色：认识的固定，其它按名字哈希到图表色板。 */
export function harnessHue(harness?: string): string {
  if (!harness) return 'var(--c-7)'
  const n = KNOWN[harness] ?? POOL[[...harness].reduce((s, c) => s + c.charCodeAt(0), 0) % POOL.length]
  return `var(--c-${n})`
}

/** 运行中细分 → 蜂的状态、手里的工具与常驻表情（docs/design/27 §2）。 */
const ACT_LOOK: Record<MarkAct, { state: BeeState; prop?: BeeProp; face?: BeeFace }> = {
  think: { state: 'think' },
  read: { state: 'work', prop: 'lens' },
  edit: { state: 'work', prop: 'wrench' },
  run: { state: 'work', prop: 'tube', face: { eyes: 'focus' } },
  compact: { state: 'work', face: { eyes: 'squeeze', mouth: 'flat' } },
  wait: { state: 'work', face: { eyes: 'focus', mouth: 'flat' } },
}

/** 小于这个尺寸蜂的手不画，角色道具改成右下角的角标。 */
const HAND_MIN = 40

/**
 * Agent 形象 = 节拍蜂：角色定道具和身体色（一眼认出是谁，同一个角色全站同色）；hue 只在要特意着色时传（管家、Lead）。
 * 只有在跑 / 等人的会自己挑小动作，其余安静（只在切状态时播入场动作：完成蹦一下、失败叹气）。
 * 大尺寸道具拿在手里（干活时换成手上的工具），小尺寸画成右下角的道具角标；头顶符号同样用角标补上。
 */
export function AgentMark({ state, sign, act, role, prop, hue, size = 22, label, className }: { state: MarkState; sign?: MarkSign; act?: MarkAct; role?: string; prop?: BeeProp; hue?: string; size?: number; label?: string; className?: string }) {
  const look = state === 'work' && act ? ACT_LOOK[act] : undefined
  const busy = state === 'work' || state === 'ask'
  const own = prop ?? roleProp(role)
  const hand = size >= HAND_MIN
  return (
    <span className={`amark${className ? ` ${className}` : ''}`} data-state={state} style={{ width: size, height: size }} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} title={label}>
      <Bee state={look?.state ?? state} prop={hand ? (look?.prop ?? own) : undefined} face={look?.face} hue={hue ?? roleHue(role)} size={size} calm={!busy} />
      {own && !hand && <PropBadge prop={own} size={size} />}
      {sign && size <= 24 && (
        <span className="amark-sign" data-sign={sign} aria-hidden>
          {sign}
        </span>
      )}
    </span>
  )
}

/** 道具角标：蜂身上那套道具画法，缩进一个小圆里。 */
export function PropBadge({ prop, size }: { prop: BeeProp; size: number }) {
  const d = Math.max(10, Math.round(size * 0.5))
  // 尺寸写在 style 上：放进 .btn 等容器时不被通用的 svg 尺寸规则改掉
  return <svg className="amark-prop" viewBox="-1.5 -1.5 19 19" style={{ width: d, height: d }} aria-hidden dangerouslySetInnerHTML={{ __html: PROPS[prop] }} />
}
