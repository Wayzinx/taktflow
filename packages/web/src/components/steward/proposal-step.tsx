import { Eye, EyeOff, FileText, SquareTerminal, Workflow } from 'lucide-react'
import type { Proposal, ProposalStep } from '@taktflow/core'
import { navigate, useLocation } from '../../lib/router'
import { previewWorkflowProposal, useWorkflowPreview } from '../../lib/ui-store'
import { DiffView } from './tool-card'

type Preview = NonNullable<Proposal['previews']>[number]

const STEP_ICON = { command: SquareTerminal, workflow: Workflow, file: FileText }

type Kind = 'boolean' | 'number' | 'string' | 'json'
const kindOf = (v: unknown): Kind => (typeof v === 'boolean' ? 'boolean' : typeof v === 'number' ? 'number' : typeof v === 'string' || v === null || v === undefined ? 'string' : 'json')

/**
 * 命令参数表单：字符串 / 数字 / 布尔直接改，复杂值只读。
 * 控件与取值类型按管家给出的原始参数（original）定，而不是按当前值：数字清空后是"未填"（去掉这个键），
 * 不会变成 null 再被当成文本框、把 5 提交成 "5"。
 */
function ParamForm({ input, original, editable, onChange }: { input: Record<string, unknown>; original: Record<string, unknown>; editable: boolean; onChange: (next: Record<string, unknown>) => void }) {
  const set = (k: string, v: unknown) => {
    const next = { ...input }
    if (v === undefined) delete next[k]
    else next[k] = v
    onChange(next)
  }
  const keys = [...new Set([...Object.keys(original), ...Object.keys(input)])]
  return (
    <div className="stw-form">
      {keys.map((k) => {
        const v = input[k]
        const kind = kindOf(k in original ? original[k] : v)
        return (
          <label key={k} className="stw-form-row">
            <span className="stw-form-key mono">{k}</span>
            {kind === 'boolean' ? (
              <span className="stw-switch">
                <input type="checkbox" checked={v === true} disabled={!editable} onChange={(e) => set(k, e.target.checked)} />
                <span>{v === true ? '是' : '否'}</span>
              </span>
            ) : kind === 'number' ? (
              <input className="input stw-form-input num" type="number" value={typeof v === 'number' ? v : ''} placeholder="未填" disabled={!editable} onChange={(e) => set(k, e.target.value === '' ? undefined : Number(e.target.value))} />
            ) : kind === 'string' ? (
              <input className="input stw-form-input" value={typeof v === 'string' ? v : ''} disabled={!editable} onChange={(e) => set(k, e.target.value)} />
            ) : (
              <code className="stw-form-json truncate">{JSON.stringify(v)}</code>
            )}
          </label>
        )
      })}
    </div>
  )
}

function WorkflowPreviewButton({ proposalId, threadId, step }: { proposalId: string; threadId: string; step: Extract<ProposalStep, { kind: 'workflow' }> }) {
  const active = useWorkflowPreview(step.workflowId)
  const { path } = useLocation()
  const on = active?.proposalId === proposalId
  const onEditor = path === `/workflows/${step.workflowId}`
  return (
    <button
      type="button"
      className="btn btn-sm"
      aria-pressed={on}
      onClick={() => {
        if (on && onEditor) return previewWorkflowProposal(undefined)
        previewWorkflowProposal({ workflowId: step.workflowId, proposalId, step, threadId })
        if (!onEditor) navigate(step.spaceId ? `/s/${step.spaceId}/workflows/${step.workflowId}` : `/workflows/${step.workflowId}`)
      }}
    >
      {on && onEditor ? <EyeOff /> : <Eye />}
      {on && onEditor ? '关闭画布预览' : '在画布上预览'}
    </button>
  )
}

/** 提案里的一步：标题 + 对应预览（命令 → 参数表单，workflow → diff + 画布幽灵预览，文件 → diff）。 */
export function ProposalStepView({ index, step, original, preview, proposalId, threadId, editable, onChange }: { index: number; step: ProposalStep; original?: ProposalStep; preview?: Preview; proposalId: string; threadId: string; editable: boolean; onChange: (s: ProposalStep) => void }) {
  const Icon = STEP_ICON[step.kind]
  const title = step.title ?? (step.kind === 'command' ? step.commandId : step.kind === 'workflow' ? `修改 workflow ${step.workflowId}` : `写入 ${step.path}`)
  const target = step.kind === 'command' ? step.commandId : step.kind === 'workflow' ? `${step.workflowId}@${step.baseRev.slice(0, 7)}` : step.path
  return (
    <li className="stw-step">
      <div className="stw-step-head">
        <span className="stw-step-n num">{index + 1}</span>
        <Icon className="stw-step-icon" aria-hidden />
        <span className="stw-step-title">{title}</span>
        {target !== title && <span className="stw-step-target mono truncate">{target}</span>}
      </div>
      <div className="stw-step-body">
        {step.kind === 'command' && <ParamForm input={step.input} original={original?.kind === 'command' ? original.input : step.input} editable={editable} onChange={(input) => onChange({ ...step, input })} />}
        {step.kind === 'command' && preview?.kind === 'text' && <p className="stw-step-note">{preview.body}</p>}
        {step.kind !== 'command' && preview?.kind === 'diff' && <DiffView diff={preview.body} />}
        {step.kind === 'file' && !preview && <DiffView diff={step.content.split('\n').map((l) => `+${l}`).join('\n')} />}
        {preview?.kind === 'text' && step.kind !== 'command' && <p className="stw-step-note">{preview.body}</p>}
        {step.kind === 'workflow' && (
          <div className="stw-step-actions">
            <WorkflowPreviewButton proposalId={proposalId} threadId={threadId} step={step} />
            <span className="faint">新增节点与新依赖绿色虚线、删除红色划线、去掉的依赖红 ×、改动琥珀角标</span>
          </div>
        )}
      </div>
    </li>
  )
}

/** previews 与 steps 一一对应；只有一份 form 预览且命令步骤没有对应时按标题匹配。 */
export function previewFor(p: Proposal, i: number): Preview | undefined {
  const pv = p.previews?.[i]
  const s = p.steps[i]
  if (!pv || !s) return pv
  if (pv.kind === 'form' && s.kind !== 'command') return undefined
  return pv
}

/** 删除 / 取消一类不可逆的命令（设计 22 §1.5：高风险与删除类提案批准前要手动输入名称确认）。 */
const DESTRUCTIVE = /(^|\.)(delete|remove|purge|cancel|archive)$/

/** 需要输入确认时返回要输入的目标（id / 名称）；不需要时 undefined。 */
export function confirmTargetOf(p: Pick<Proposal, 'risk' | 'steps'>): string | undefined {
  const risky = p.steps.find((s) => s.kind === 'command' && DESTRUCTIVE.test(s.commandId))
  if (p.risk !== 'high' && !risky) return undefined
  const s = risky ?? p.steps[0]
  if (!s) return undefined
  if (s.kind === 'workflow') return s.workflowId
  if (s.kind === 'file') return s.path
  const v = ['id', 'runId', 'requirementId', 'baseId', 'spaceId', 'name'].map((k) => s.input[k]).find((x) => typeof x === 'string' && x)
  return (v as string | undefined) ?? s.commandId
}
