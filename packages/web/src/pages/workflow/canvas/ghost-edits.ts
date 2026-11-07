import type { WorkflowEdit } from '@taktflow/core'
import type { WorkflowPreview } from '../../../lib/ui-store'

/** 幽灵预览要画的改动：提案步骤里的 edits。 */
export function ghostEdits(p: WorkflowPreview): WorkflowEdit[] {
  return p.step.edits
}
