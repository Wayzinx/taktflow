import type { CSSProperties } from 'react'
import type { NodeStatus } from '@taktflow/core'
import './agent-mark.css'

/**
 * Agent 形象（docs/design/25 §2）：原创小形象——圆角方块 + 头顶一根节拍刻度 + 两只眼。
 * 眼睛表达状态：待命闭眼、干活睁眼（按节拍眨眼）、求助上看 + 头顶符号、完成眯眼笑、失败 ✕。
 * 不用任何第三方品牌图形；颜色按 harness 稳定分配，名字在 label / 悬停提示里。
 */
export type MarkState = 'idle' | 'work' | 'ask' | 'done' | 'failed'
export type MarkSign = '!' | '?' | '✕' | 'z'

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

const EYES: Record<MarkState, string> = {
  // 两条短横
  idle: 'M7.4 14.2h3.2M13.4 14.2h3.2',
  // 两个圆点（用零长度圆头线画，便于统一 stroke）
  work: 'M9 13.6v.01M15 13.6v.01',
  ask: 'M9.4 12.4v.01M15.4 12.4v.01',
  // 两道上弧 ^ ^
  done: 'M7.4 14.6q1.6-2.2 3.2 0M13.4 14.6q1.6-2.2 3.2 0',
  // 两个小叉
  failed: 'M7.8 12.4l2.4 2.4M10.2 12.4l-2.4 2.4M13.8 12.4l2.4 2.4M16.2 12.4l-2.4 2.4',
}

export function AgentMark({ state, sign, hue = 'var(--c-7)', size = 22, label, className }: { state: MarkState; sign?: MarkSign; hue?: string; size?: number; label?: string; className?: string }) {
  const dots = state === 'work' || state === 'ask'
  return (
    <span className={`amark${className ? ` ${className}` : ''}`} data-state={state} style={{ '--amark-hue': hue, width: size, height: size } as CSSProperties} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} title={label}>
      <svg viewBox="0 0 24 24" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <g className="amark-body">
          <path className="amark-tick" d="M12 6.2V3.4" />
          <rect className="amark-head" x="3.6" y="6.2" width="16.8" height="14.6" rx="5.4" />
          <path className="amark-eyes" d={EYES[state]} strokeWidth={dots ? 3.1 : 1.7} />
        </g>
      </svg>
      {sign && (
        <span className="amark-sign" data-sign={sign} aria-hidden>
          {sign}
        </span>
      )}
    </span>
  )
}
