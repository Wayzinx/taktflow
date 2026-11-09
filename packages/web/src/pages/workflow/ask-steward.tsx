import { useEffect, useRef } from 'react'

import type { StewardContextRef } from '@taktflow/core'
import { useAsync } from '../../api'
import { withShortcut } from '../../components/ui'
import './edit-fallback.css'
import { openSteward, previewWorkflowProposal, type WorkflowStep } from '../../lib/ui-store'
import { BeeGlyph } from '../../components/identity'

/**
 * 编辑器右上角"问管家"：打开停靠面板，上下文带上 workflow 与选中节点。
 * 有针对这个 workflow 的待决定提案时显示数字：点击直接打开那个会话，并在画布上幽灵预览它的改动。
 * 挂载：pages/workflow/index.tsx 页头 actions（骨架预留）。
 */
export function AskStewardButton({ workflowId, selectedNodeId }: { workflowId: string; selectedNodeId?: string }) {
  const pending = useAsync((ds) => ds.proposals('pending').catch(() => []), [workflowId])
  const mine = (pending.data ?? []).flatMap((p) => p.steps.filter((s): s is WorkflowStep => s.kind === 'workflow' && s.workflowId === workflowId).map((step) => ({ p, step })))
  const first = mine[0]
  const context: StewardContextRef[] = [{ type: 'workflow', id: workflowId, label: workflowId }, ...(selectedNodeId ? [{ type: 'node' as const, id: selectedNodeId, parent: workflowId, label: selectedNodeId }] : [])]
  // 截图 / 演示开关：?ghost=1 时首屏直接在画布上预览第一个待决定的提案
  const auto = useRef(false)
  useEffect(() => {
    if (auto.current || !first || new URLSearchParams(location.search).get('ghost') !== '1') return
    auto.current = true
    previewWorkflowProposal({ workflowId, proposalId: first.p.id, step: first.step, threadId: first.p.threadId })
  }, [first, workflowId])
  const open = () => {
    if (first) {
        previewWorkflowProposal({ workflowId, proposalId: first.p.id, step: first.step, threadId: first.p.threadId })
      return openSteward({ threadId: first.p.threadId, context })
    }
    openSteward({ context })
  }
  const tip = first ? `有 ${mine.length} 个改这个 workflow 的提案等你决定：${first.p.title}` : `${withShortcut('问管家', 'mod+j')}：会带上这个 workflow${selectedNodeId ? `和选中的 ${selectedNodeId}` : ''}`
  return (
    <button type="button" className="btn btn-sm" title={tip} onClick={open}>
      <BeeGlyph />
      问管家
      {mine.length > 0 && (
        <span className="wf-ask-count num" aria-label={`${mine.length} 个提案待决定`}>
          {mine.length}
        </span>
      )}
    </button>
  )
}
