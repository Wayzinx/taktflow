import { describe, expect, it } from 'vitest'
import type { SpaceMember, Viewer, WorkflowSummary } from '@taktflow/core'
import type { TeamNode } from '../../api/team'
import { canPostTeam, initialDraft, nodeKey, teamPost } from './model'

const workflow: WorkflowSummary = { id: 'delivery', title: '交付', file: 'delivery.workflow.ts', rev: 'r1', editable: false, updatedAt: '', nodes: 5, runs: 0 }
const codex: TeamNode = { id: 'dev', harness: 'codex', online: true }
const claude: TeamNode = { id: 'dev', harness: 'claude-code', online: false }
const draft = { ...initialDraft, text: '  确认进度  ', workflowId: workflow.id, nodeKey: nodeKey(codex) }

describe('团队消息目标和权限', () => {
  it('聊天消息不携带其他模式的目标，空白不能发送', () => {
    expect(teamPost(draft, [workflow], [codex], 'req-1')).toEqual({ requestId: 'req-1', mode: 'chat', text: '确认进度' })
    expect(teamPost({ ...draft, text: ' \n ' }, [workflow], [codex], 'req-1')).toBeUndefined()
  })

  it('编排开发仅发送当前空间实际选中的流水线', () => {
    const task = { ...draft, mode: 'workflow' } as const
    expect(teamPost(task, [workflow], [codex], 'req-2')).toEqual({ requestId: 'req-2', mode: 'workflow', text: '确认进度', workflowId: 'delivery' })
    expect(teamPost(task, [], [codex], 'req-2')).toBeUndefined()
    expect(teamPost({ ...task, workflowId: '' }, [workflow], [codex], 'req-2')).toBeUndefined()
  })

  it('直接开发要求所选机器与 Harness 组合在线', () => {
    const task = { ...draft, mode: 'vibe' } as const
    expect(teamPost(task, [workflow], [codex, claude], 'req-3')).toEqual({ requestId: 'req-3', mode: 'vibe', text: '确认进度', nodeId: 'dev', harness: 'codex' })
    expect(teamPost({ ...task, nodeKey: nodeKey(claude) }, [], [codex, claude], 'req-3')).toBeUndefined()
    expect(teamPost(task, [], [{ ...codex, online: false }, { ...claude, online: true }], 'req-3')).toBeUndefined()
  })

  it('确认有 member 或更高权限才开放写入，演示始终只读', () => {
    const viewer = (role?: SpaceMember['role']): Viewer => ({ id: 'lin', name: '小林', member: role ? { id: 'lin', name: '小林', role } : undefined })
    expect(canPostTeam(undefined, false)).toBe(false)
    expect(canPostTeam(viewer(), false)).toBe(false)
    expect(canPostTeam(viewer('viewer'), false)).toBe(false)
    for (const role of ['member', 'maintainer', 'owner'] as const) {
      expect(canPostTeam(viewer(role), false)).toBe(true)
      expect(canPostTeam(viewer(role), true)).toBe(false)
    }
  })
})
