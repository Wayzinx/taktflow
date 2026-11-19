import type { Viewer, WorkflowSummary } from '@taktflow/core'
import type { TeamMode, TeamNode, TeamPost } from '../../api/team'

export interface TeamDraft {
  mode: TeamMode
  text: string
  includeDiscussion?: boolean
  workflowId: string
  nodeKey: string
}

export const initialDraft: TeamDraft = { mode: 'chat', text: '', workflowId: '', nodeKey: '' }
export const nodeKey = ({ id, harness }: TeamNode) => JSON.stringify([id, harness])

export function teamPost(draft: TeamDraft, workflows: readonly WorkflowSummary[], nodes: readonly TeamNode[], requestId: string): TeamPost | undefined {
  const text = draft.text.trim()
  if (!text) return
  const mode = draft.mode
  if (mode === 'chat') return { requestId, mode, text }
  if (mode === 'workflow') {
    if (workflows.some(({ id }) => id === draft.workflowId)) return { requestId, mode, text, workflowId: draft.workflowId, ...(draft.includeDiscussion ? { includeDiscussion: true } : {}) }
    return
  }
  const node = nodes.find((node) => node.online && nodeKey(node) === draft.nodeKey)
  if (node) return { requestId, mode, text, nodeId: node.id, harness: node.harness }
}

export function canPostTeam(viewer: Viewer | undefined, demo: boolean): boolean {
  const role = viewer?.member?.role
  return !demo && (role === 'owner' || role === 'maintainer' || role === 'member')
}
