import { AgentMark, harnessHue, type MarkAct, type MarkSign, type MarkState } from './agent-mark'

/**
 * 身份只有一套画法（docs/design/30 §1）：
 * - 人：首字母实色头像（ui.tsx 的 Avatar）；
 * - 管家、Lead、每个 Agent：节拍蜂（AgentMark），角色定道具、harness 定身体色；
 * - 按钮、菜单、标签里要一个"管家"图标时：BeeGlyph（和 lucide 同规格的线稿），不再用 ✦ / 机器人。
 */

export { BeeGlyph } from './bee-glyph'

/** 管家：拿小铃铛的蜂蜜色蜂。 */
export function StewardMark({ size = 22, state = 'idle', act, sign, label = '管家', className }: { size?: number; state?: MarkState; act?: MarkAct; sign?: MarkSign; label?: string; className?: string }) {
  return <AgentMark state={state} act={act} sign={sign} role="steward" hue="var(--honey)" size={size} label={label} className={className} />
}

/** 需求群的 Lead：拿指挥棒，按它用的 harness 着色。 */
export function LeadMark({ size = 22, state = 'idle', harness, label = 'Lead', className }: { size?: number; state?: MarkState; harness?: string; label?: string; className?: string }) {
  return <AgentMark state={state} role="lead" hue={harness ? harnessHue(harness) : 'var(--honey)'} size={size} label={label} className={className} />
}
