import { useState } from 'react'
import { Check, Lock, Wand2 } from 'lucide-react'
import type { WorkflowConvertResult } from '@taktflow/core'
import { useSource } from '../../api'
import { WorkflowConflictError } from '../../api/source'
import { DiffView } from '../../components/steward/tool-card'
import { Dialog, toast } from '../../components/ui'
import { askSteward } from '../../lib/ui-store'
import type { WorkflowDocState } from './state'
import './edit-fallback.css'
import { BeeGlyph } from '../../components/identity'

/** baseRev：预览 diff 时的文件版本；写入时带上，文件在这之后被改过服务端会 409，避免写入没审阅过的改写。 */
type Preview = { result: WorkflowConvertResult; baseRev?: string }
type Phase = { kind: 'idle' } | { kind: 'checking' } | ({ kind: 'preview' } & Preview) | ({ kind: 'writing' } & Preview) | { kind: 'failed'; reason: string } | { kind: 'done' }

/**
 * workflow 编辑兜底（docs/design/22 §2.3）：源文件不是 defineWorkflow 写法时，画布只读，顶部横幅说明原因。
 * "转换为可编辑格式" → 先 dryRun 弹出 diff → 确认后写入并重新加载 → 转换不了时改成"让管家转换"（管家出一份文件提案）。
 * 挂载：pages/workflow/index.tsx 页头之后；wf.readOnly 为 false 时不渲染。演示：?mockConvert=fail 模拟改写失败。
 */
export function EditFallbackBanner({ workflowId, wf }: { workflowId: string; wf: WorkflowDocState }) {
  const ds = useSource()
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  if (!wf.readOnly) return null

  const check = async () => {
    setPhase({ kind: 'checking' })
    const baseRev = wf.doc?.rev
    try {
      const r = await ds.convertWorkflow(workflowId, { dryRun: true })
      setPhase(r.ok ? { kind: 'preview', result: r, baseRev } : { kind: 'failed', reason: r.reason ?? '这个文件没法确定性改写' })
    } catch (e) {
      setPhase({ kind: 'failed', reason: (e as Error).message })
    }
  }
  const write = async ({ result, baseRev }: Preview) => {
    setPhase({ kind: 'writing', result, baseRev })
    try {
      const r = await ds.convertWorkflow(workflowId, { dryRun: false, baseRev, reason: '转换为 defineWorkflow 写法，以便可视化编辑' })
      if (!r.ok) return setPhase({ kind: 'failed', reason: r.reason ?? '写入时改写失败' })
      setPhase({ kind: 'done' })
      toast('已转换为可编辑格式', { tone: 'success', body: `${workflowId} 现在可以在画布上直接编辑；改动已记入修订历史` })
      await wf.reload()
    } catch (e) {
      if ((e as { status?: number }).status === 409 || e instanceof WorkflowConflictError) {
        toast('文件在预览后被改过', { tone: 'waiting', body: '已按最新文件重新生成 diff，请再看一遍再确认' })
        await wf.reload()
        return void check()
      }
      setPhase({ kind: 'preview', result, baseRev })
      toast('写入失败', { tone: 'failed', body: (e as Error).message })
    }
  }
  const askConvert = () =>
    askSteward(`把 workflow ${workflowId} 转换成 defineWorkflow 写法，保持节点和依赖不变，出一份文件提案给我确认`, [{ type: 'workflow', id: workflowId, label: wf.doc?.file ?? workflowId }])

  const failed = phase.kind === 'failed'
  const busy = phase.kind === 'checking' || phase.kind === 'writing'
  const preview = phase.kind === 'preview' || phase.kind === 'writing' ? { result: phase.result, baseRev: phase.baseRev } : undefined
  return (
    <>
      <div className="wf-fallback" role="note" data-tone={failed ? 'failed' : undefined}>
        <span className="wf-fallback-icon" aria-hidden>
          {phase.kind === 'done' ? <Check /> : <Lock />}
        </span>
        <div className="wf-fallback-text">
          <strong>{phase.kind === 'done' ? '已转换，正在重新加载' : failed ? '没法自动转换' : '画布只读：这个文件不是可视化编辑的写法'}</strong>
          <span>{failed ? phase.reason : (wf.readOnlyReason ?? '源文件不是 defineWorkflow({...}) 写法')}</span>
        </div>
        {failed ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={askConvert}>
            <BeeGlyph />
            让管家转换
          </button>
        ) : (
          phase.kind !== 'done' && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void check()} disabled={busy}>
              <Wand2 className={phase.kind === 'checking' ? 'spin' : undefined} />
              {phase.kind === 'checking' ? '正在检查' : '转换为可编辑格式'}
            </button>
          )
        )}
      </div>
      <Dialog
        open={!!preview}
        onClose={() => phase.kind !== 'writing' && setPhase({ kind: 'idle' })}
        size="lg"
        title="转换为可编辑格式"
        description="只改写法，不改流程：节点、依赖和参数保持原样。确认后写入文件并记一条修订，随时可以回滚。"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setPhase({ kind: 'idle' })} disabled={phase.kind === 'writing'}>
              取消
            </button>
            <button type="button" className="btn btn-primary" onClick={() => preview && void write(preview)} disabled={phase.kind === 'writing'} data-autofocus>
              <Check />
              {phase.kind === 'writing' ? '正在写入' : '确认写入'}
            </button>
          </>
        }
      >
        <div className="wf-fallback-diff">
          <div className="wf-fallback-file mono">{wf.doc?.file ?? `workflows/${workflowId}.workflow.ts`}</div>
          {preview?.result.diff ? <DiffView diff={preview.result.diff} maxHeight={360} /> : <p className="faint">没有需要改动的行</p>}
        </div>
      </Dialog>
    </>
  )
}
