import type { NodeActivity, NodeStatus } from '@taktflow/core'
import { actionKind } from '../lib/actions'
import { Bee, type BeeFace, type BeeProp, type BeeState } from './mascot'
import './agent-mark.css'

/**
 * Agent 形象（docs/design/25 §2 → 27 §2）：节拍蜂。状态：待命、干活、求助（头顶符号）、完成、失败；
 * 不用任何第三方品牌图形；颜色按 harness 稳定分配，名字在 label / 悬停提示里。
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

const KNOWN: Record<string, number> = { native: 1, codex: 2, gemini: 6, 'claude-code': 4, cursor: 5, qwen: 3, kimi: 3, opencode: 2, pi: 6, dsh: 1, mock: 7 }
/** 同一个 harness 全站同色：认识的固定，其它按名字哈希到图表色板。 */
export function harnessHue(harness?: string): string {
  if (!harness) return 'var(--c-7)'
  const n = KNOWN[harness] ?? 1 + ([...harness].reduce((s, c) => s + c.charCodeAt(0), 0) % 6)
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

/**
 * Agent 形象 = 节拍蜂，身体按 harness 着色。只有在跑 / 等人的会自己挑小动作，其余安静（只在切状态时播入场动作：完成蹦一下、失败叹气）。
 * 小尺寸（≤ 24px）蜂身上的叠加物不画，头顶符号用角标补上。
 */
export function AgentMark({ state, sign, act, hue = 'var(--c-7)', size = 22, label, className }: { state: MarkState; sign?: MarkSign; act?: MarkAct; hue?: string; size?: number; label?: string; className?: string }) {
  const look = state === 'work' && act ? ACT_LOOK[act] : undefined
  const busy = state === 'work' || state === 'ask'
  return (
    <span className={`amark${className ? ` ${className}` : ''}`} data-state={state} style={{ width: size, height: size }} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} title={label}>
      <Bee state={look?.state ?? state} prop={look?.prop} face={look?.face} hue={hue} size={size} calm={!busy} />
      {sign && size <= 24 && (
        <span className="amark-sign" data-sign={sign} aria-hidden>
          {sign}
        </span>
      )}
    </span>
  )
}
