import { useEffect, useRef, useState } from 'react'
import { Copy, MoreHorizontal, Pencil, Plus, Star, Trash2, Workflow as WorkflowIcon } from 'lucide-react'
import type { SpaceSettings, WorkflowSummary } from '@taktflow/core'
import { useAsync, useSource } from '../api'
import { PageHeader, useCrumbs } from '../components/layout'
import { Dialog } from '../components/ui/dialog'
import { Menu } from '../components/ui/popover'
import { ReasonDialog } from '../components/ui/reason-dialog'
import { EmptyState, ErrorState, toast } from '../components/ui'
import { navigate } from '../lib/router'
import { AskLead, Field } from './settings/settings-kit'
import { UpgradeBanner } from './settings/upgrade-banner'
import { WorkflowTable } from './workflows-list-table'

type Action = { kind: 'copy' | 'rename' | 'default' | 'delete'; workflow: WorkflowSummary }

/** /workflows：当前空间的流程列表——新建（模板 / 复制）、改名、设默认、删除；点进去是画布编辑器。 */
export function WorkflowsListPage() {
  useCrumbs([{ label: 'Workflow' }], [])
  const ds = useSource()
  const q = useAsync((d) => d.workflows(), [])
  const st = useAsync((d) => d.settings(), [])
  const [creating, setCreating] = useState<{ from?: string }>()
  const [action, setAction] = useState<Action>()
  const reload = () => { q.reload(); st.reload() }
  const defaultId = st.data?.workflows.find((w) => w.default)?.id
  const count = q.data?.length ?? 0

  return (
    <div className="page wf-page fade-in">
      <PageHeader
        title="Workflow"
        sub={q.data ? `空间里的交付流程，共 ${count} 个。每次修改都有修订记录，可以回滚；正在跑的运行不受影响。` : '空间里的交付流程。'}
        actions={
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setCreating({})} disabled={!st.data}>
            <Plus />
            新建流程
          </button>
        }
      />
      <AskLead page="workflows" placeholder="告诉 Lead 你想怎么改，例如：PRD 交叉评审最多 2 轮；研发之后加一个安全评审节点" />
      {st.data?.layout.legacy && <UpgradeBanner issues={st.data.layout.issues} onUpgraded={reload} />}
      <div className="card">
        {q.error && !q.data ? (
          <ErrorState error={q.error} onRetry={q.reload} />
        ) : q.data && q.data.length === 0 ? (
          <EmptyState
            icon={WorkflowIcon}
            title="这个空间还没有流程"
            hint="从模板新建一个：完整的标准交付流水线、精简 SDLC，或者小改动用的轻量流程。"
            action={<button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating({})} disabled={!st.data}><Plus />从模板新建</button>}
          />
        ) : (
          <WorkflowTable
            workflows={q.data}
            defaultId={defaultId}
            renderActions={(w) => <RowMenu workflow={w} isDefault={w.id === defaultId} onAction={(kind) => (kind === 'copy' ? setCreating({ from: w.id }) : setAction({ kind, workflow: w }))} />}
          />
        )}
      </div>
      <p className="wf-page-foot">
        {ds.host?.askLead ? '画布改不了的结构（带代码的节点）可以直接告诉 Lead，Lead 改源码，同样留修订、可回滚。' : '带代码结构的流程画布只读，可以看图和源码，改源码同样留修订。'}
      </p>

      {st.data && <NewWorkflowDialog open={!!creating} copyFrom={creating?.from} settings={st.data} workflows={q.data ?? []} onClose={() => setCreating(undefined)} onCreated={(id) => { setCreating(undefined); reload(); navigate(`/workflows/${encodeURIComponent(id)}`) }} />}
      <RenameDialog workflow={action?.kind === 'rename' ? action.workflow : undefined} onClose={() => setAction(undefined)} onDone={reload} />
      <ReasonDialog
        open={action?.kind === 'default'}
        onClose={() => setAction(undefined)}
        title={`把「${action?.workflow.title}」设为默认流程？`}
        description="Lead 开始交付但没说用哪个流程时，用默认流程。"
        confirmLabel="设为默认"
        onSubmit={async (reason) => {
          await ds.updateWorkflowMeta(action!.workflow.id, { default: true, reason })
          toast(`默认流程改为 ${action!.workflow.title}`)
          reload()
        }}
      />
      <ReasonDialog
        open={action?.kind === 'delete'}
        onClose={() => setAction(undefined)}
        title={`删除流程「${action?.workflow.title}」？`}
        description="流程文件会删除，历史运行记录不受影响；修订历史保留。还有未结束的运行时会被拒绝。"
        risk="dangerous"
        confirmLabel="删除"
        onSubmit={async (reason) => {
          await ds.deleteWorkflow(action!.workflow.id, reason)
          toast(`已删除 ${action!.workflow.title}`)
          reload()
        }}
      />
    </div>
  )
}

function RowMenu({ workflow, isDefault, onAction }: { workflow: WorkflowSummary; isDefault: boolean; onAction: (kind: Action['kind']) => void }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button ref={anchor} type="button" className="btn btn-ghost btn-sm btn-icon" aria-label={`${workflow.title} 的操作`} aria-haspopup="menu" onClick={(e) => { e.stopPropagation(); setOpen(true) }}>
        <MoreHorizontal />
      </button>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        placement="bottom-end"
        ariaLabel="流程操作"
        items={[
          { id: 'copy', label: '复制为新流程', icon: Copy, onSelect: () => onAction('copy') },
          { id: 'rename', label: '改名', icon: Pencil, disabled: !workflow.editable, hint: workflow.editable ? undefined : '只读流程', onSelect: () => onAction('rename') },
          { id: 'default', label: isDefault ? '已是默认流程' : '设为默认', icon: Star, disabled: isDefault, onSelect: () => onAction('default') },
          { id: 'delete', label: '删除', icon: Trash2, danger: true, onSelect: () => onAction('delete') },
        ]}
      />
    </>
  )
}

function NewWorkflowDialog({ open, copyFrom, settings, workflows, onClose, onCreated }: {
  open: boolean
  copyFrom?: string
  settings: SpaceSettings
  workflows: WorkflowSummary[]
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const ds = useSource()
  const [source, setSource] = useState('')
  const [id, setId] = useState('')
  const [title, setTitle] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) return
    setSource(copyFrom ? `workflow:${copyFrom}` : `template:${settings.templates[0]?.id ?? ''}`)
    setId(''); setTitle(''); setReason(''); setError(undefined)
  }, [open, copyFrom, settings.templates])
  const taken = new Set(workflows.map((w) => w.id))
  const idOk = /^[a-z0-9][a-z0-9-]{0,63}$/.test(id) && !taken.has(id)
  const valid = idOk && reason.trim() && source
  const submit = async () => {
    if (!valid || busy) return
    setBusy(true); setError(undefined)
    const [kind, ref] = source.split(':') as ['template' | 'workflow', string]
    try {
      await ds.createWorkflow({ id, ...(title.trim() ? { title: title.trim() } : {}), from: kind === 'template' ? { template: ref } : { workflow: ref }, reason: reason.trim() })
      toast(`已新建流程 ${title.trim() || id}`)
      onCreated(id)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Dialog open={open} onClose={onClose} title="新建流程" description="从模板开始，或复制一个现有流程再改。新建后进入画布编辑。" size="md" dismissible={!id && !reason}
      footer={<>
        {error && <span className="ov-error">{error}</span>}
        <button type="button" className="btn btn-sm" onClick={onClose}>取消</button>
        <button type="button" className="btn btn-sm btn-primary" disabled={!valid || busy} onClick={() => void submit()}>{busy ? '新建中…' : '新建'}</button>
      </>}>
      <div className="sk-section-body" style={{ gridTemplateColumns: '1fr' }}>
        <div className="sk-field">
          <span className="field-label">从哪里开始</span>
          <div className="sk-choice">
            {settings.templates.map((t) => (
              <button key={t.id} type="button" className={`sk-choice-item${source === `template:${t.id}` ? ' on' : ''}`} aria-pressed={source === `template:${t.id}`} onClick={() => setSource(`template:${t.id}`)}>
                <span className="sk-choice-title">{t.title}</span>
                <span className="sk-choice-desc">{t.description || '模板'}</span>
              </button>
            ))}
          </div>
          {workflows.length > 0 && (
            <select className="select" value={source.startsWith('workflow:') ? source : ''} onChange={(e) => e.target.value && setSource(e.target.value)} aria-label="复制现有流程">
              <option value="">或者复制现有流程…</option>
              {workflows.map((w) => <option key={w.id} value={`workflow:${w.id}`}>{w.title}（{w.id}）</option>)}
            </select>
          )}
        </div>
        <Field label="流程 id" hint={id && !idOk ? (taken.has(id) ? 'id 已被占用' : '小写字母、数字和连字符') : '文件名和运行记录里用它，例如 hotfix。'}>
          <input className="input mono" value={id} onChange={(e) => setId(e.target.value.toLowerCase())} placeholder="hotfix" data-autofocus />
        </Field>
        <Field label="名称（可选）">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="线上热修" />
        </Field>
        <Field label="原因">
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如：线上问题需要更短的流程" onKeyDown={(e) => { if (e.key === 'Enter') void submit() }} />
        </Field>
      </div>
    </Dialog>
  )
}

function RenameDialog({ workflow, onClose, onDone }: { workflow?: WorkflowSummary; onClose: () => void; onDone: () => void }) {
  const ds = useSource()
  const [title, setTitle] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (workflow) { setTitle(workflow.title); setReason(''); setError(undefined) } }, [workflow])
  const valid = title.trim() && title.trim() !== workflow?.title && reason.trim()
  const submit = async () => {
    if (!valid || busy || !workflow) return
    setBusy(true); setError(undefined)
    try {
      await ds.updateWorkflowMeta(workflow.id, { title: title.trim(), reason: reason.trim() })
      toast('已改名')
      onClose(); onDone()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Dialog open={!!workflow} onClose={onClose} title="流程改名" size="sm"
      footer={<>
        {error && <span className="ov-error">{error}</span>}
        <button type="button" className="btn btn-sm" onClick={onClose}>取消</button>
        <button type="button" className="btn btn-sm btn-primary" disabled={!valid || busy} onClick={() => void submit()}>{busy ? '保存中…' : '保存'}</button>
      </>}>
      <div className="sk-section-body" style={{ gridTemplateColumns: '1fr' }}>
        <Field label="名称"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} data-autofocus /></Field>
        <Field label="原因"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void submit() }} /></Field>
      </div>
    </Dialog>
  )
}
