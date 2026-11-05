import type { EditableValue, NodeKind } from '@taktflow/core'
import { code, lit } from '../../../api/workflow-edit'

export interface PaletteItem {
  kind: NodeKind
  label: string
  hint: string
  /** 只放在顶层（loop 不能嵌套）。 */
  topOnly?: boolean
  /** 不含 id / title / stage，由放置位置补齐。 */
  defaults: () => Record<string, EditableValue>
}

export const PALETTE: PaletteItem[] = [
  { kind: 'agent', label: 'Agent', hint: '让某个角色按 prompt 产出', defaults: () => ({ role: lit('dev'), prompt: lit('') }) },
  { kind: 'review', label: '交叉评审', hint: '多评审者轮次评审，可打回', defaults: () => ({}) },
  { kind: 'human', label: '人工', hint: '审批、回答或选择', defaults: () => ({ form: lit('approve'), ask: lit('请确认后继续。') }) },
  { kind: 'script', label: '脚本', hint: '确定性的命令或函数', defaults: () => ({ run: lit('npm test') }) },
  { kind: 'gate', label: '门禁', hint: '一组检查，不通过即停', defaults: () => ({ checks: lit([{ id: 'check-1', kind: 'command', run: 'npm run lint' }]), onFail: lit('stop') }) },
  { kind: 'judge', label: '判决', hint: '按失败根因路由到修复节点', defaults: () => ({ role: lit('judge'), target: lit(''), routes: lit({ unknown: 'human' }) }) },
  { kind: 'loop', label: 'Loop', hint: '循环体整体重跑直到收敛', topOnly: true, defaults: () => ({ maxIterations: lit(3), onExhausted: lit('human'), until: code('(ctx) => false') }) },
  { kind: 'planner', label: '规划', hint: '模型拆任务，代码决定展开形状', defaults: () => ({ role: lit('architect'), prompt: lit(''), maxItems: lit(8), allowedRoles: lit(['dev']), expand: code('(item) => []') }) },
]

export const DRAG_MIME = 'application/x-taktflow-node'

export const paletteItem = (kind: string) => PALETTE.find((p) => p.kind === kind)
