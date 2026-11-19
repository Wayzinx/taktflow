export type TeamMode = 'chat' | 'workflow' | 'vibe'

export interface TeamMessage {
  id: string
  role: 'human' | 'steward'
  author: string
  text: string
  at: string
  requirementId?: string
  runId?: string
  jobId?: string
}

export interface TeamNode {
  id: string
  harness: string
  online: boolean
}

export interface TeamJob {
  id: string
  nodeId: string
  harness: string
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  result?: unknown
}

export interface TeamSnapshot {
  messages: TeamMessage[]
  nodes: TeamNode[]
  jobs: TeamJob[]
}

export type TeamPost = { requestId: string; text: string } & (
  | { mode: 'chat' }
  | { mode: 'workflow'; workflowId: string; includeDiscussion?: boolean }
  | { mode: 'vibe'; nodeId: string; harness: string }
)
