import { useEffect, useState } from 'react'
import type { KnowledgeBaseSummary, KnowledgeIntent, KnowledgeKindInfo, KnowledgeTestResult } from '@taktflow/core'
import { ArrowLeft, ArrowRight, Check } from 'lucide-react'
import { useAsync, useSource } from '../../api'
import { Dialog, ErrorState, SkeletonGrid, toast } from '../../components/ui'
import { navigate } from '../../lib/router'
import type { PendingFile } from './fields'
import { KindCards } from './kind-cards'
import { defaultsOf, missingFields, type Schema } from './schema-form'
import { compactConfig } from './schema-config'
import { StepBuild, StepData, StepTest } from './wizard-steps'
import { QueryPanel } from './query-panel'
import { PublishFlow } from './publish'
import { kbId } from './meta'

const STEPS = ['类型', '数据', '测试', '构建', '检索测试', '发布'] as const

function Stepper({ step, reached, onGo }: { step: number; reached: number; onGo: (i: number) => void }) {
  return (
    <span className="kb-stepper" role="list" aria-label="步骤">
      {STEPS.map((s, i) => (
        <span key={s} role="listitem" data-state={i === step ? 'current' : i < reached ? 'done' : 'todo'}>
          <button type="button" disabled={i > reached || i === step} onClick={() => onGo(i)} aria-current={i === step ? 'step' : undefined}>
            <span className="kb-step-n num">{i < reached && i !== step ? <Check aria-hidden /> : i + 1}</span>
            {s}
          </button>
        </span>
      ))}
    </span>
  )
}

export interface WizardDraft {
  kind?: KnowledgeKindInfo
  name: string
  description: string
  intents: KnowledgeIntent[]
  config: Record<string, unknown>
  files: PendingFile[]
}

/** 新建知识库向导：类型 → 数据 → 测试 → 构建 → 检索测试 → 发布；第 2 步起已存为草稿，随时可以退出。 */
export function CreateWizard({ open, initialKind, onClose, onCreated }: { open: boolean; initialKind?: string; onClose: () => void; onCreated: () => void }) {
  const ds = useSource()
  const kinds = useAsync((d) => d.knowledgeKinds(), [])
  const [step, setStep] = useState(0)
  const [reached, setReached] = useState(0)
  const [draft, setDraft] = useState<WizardDraft>({ name: '', description: '', intents: [], config: {}, files: [] })
  const [base, setBase] = useState<KnowledgeBaseSummary>()
  const [test, setTest] = useState<KnowledgeTestResult>()
  const [built, setBuilt] = useState(false)
  const [buildId, setBuildId] = useState<string>()
  const [fallbackId] = useState(() => `kb-${Date.now().toString(36)}`)
  const id = kbId(draft.name, fallbackId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const pick = (k: KnowledgeKindInfo) => {
    if (draft.kind?.kind !== k.kind) setDraft((d) => ({ ...d, kind: k, intents: k.intents, config: defaultsOf(k.configSchema as Schema), files: [] }))
    go(1)
  }
  useEffect(() => {
    const k = kinds.data?.find((x) => x.kind === initialKind && x.available)
    if (k && !draft.kind) pick(k)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kinds.data, initialKind])

  function go(i: number) {
    setError(undefined)
    setStep(i)
    setReached((r) => Math.max(r, i))
  }

  /** 第 2 步 → 第 3 步：创建（或更新）草稿并上传文件。 */
  async function saveDraft(): Promise<KnowledgeBaseSummary | undefined> {
    const k = draft.kind
    if (!k) return
    setBusy(true)
    setError(undefined)
    try {
      const body = { name: draft.name.trim(), description: draft.description.trim(), intents: draft.intents, config: compactConfig(draft.config) }
      const b = base ? await ds.updateKnowledgeBase(base.id, { ...body, reason: '新建向导：修改数据源' }) : await ds.createKnowledgeBase({ ...body, id, kind: k.kind, reason: '新建向导：创建草稿' })
      if (draft.files.length) await ds.uploadKnowledge(b.id, { files: draft.files.map((f) => ({ path: f.path, content: f.content })) })
      setBase(b)
      if (!base) onCreated()
      return b
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function next() {
    if (step === 1) {
      const b = await saveDraft()
      if (b) (setTest(undefined), go(2))
    } else go(step + 1)
  }

  function exit(b = base) {
    if (b) toast(`「${b.name}」已保存为草稿`, { body: '随时可以在详情页继续构建和发布。', action: { label: '打开', onClick: () => navigate(`/knowledge/${b.id}`) } })
    onClose()
  }
  /** 第 2 步还没创建时，先建草稿再退出。 */
  async function saveAndExit() {
    const b = base ?? (await saveDraft())
    if (b) exit(b)
  }

  const missing = draft.kind ? missingFields(draft.kind.kind, draft.config, draft.files.length, draft.kind.configSchema as Schema, !!base?.stats?.docs) : []
  const canNext = step === 0 ? !!draft.kind : step === 1 ? !!draft.name.trim() && missing.length === 0 : step === 2 ? !!test : step === 3 ? built || !draft.kind?.needsBuild : true
  const nextLabel = step === 1 ? (base ? '保存并测试' : '创建草稿并测试') : step === 2 && test && !test.ok ? '仍然继续' : step === 4 ? '下一步：发布' : '下一步'

  let body
  if (step === 0) body = kinds.error ? <ErrorState compact error={kinds.error} onRetry={kinds.reload} /> : !kinds.data ? <SkeletonGrid count={6} min={200} /> : <KindCards kinds={kinds.data} value={draft.kind?.kind} onPick={pick} />
  else if (step === 1 && draft.kind) body = <StepData id={id} kind={draft.kind} draft={draft} onChange={(p) => setDraft((d) => ({ ...d, ...p }))} missing={missing} />
  else if (step === 2 && base) body = <StepTest base={base} result={test} onResult={setTest} onEdit={() => go(1)} onBase={setBase} />
  else if (step === 3 && base && draft.kind) body = <StepBuild base={base} needsBuild={draft.kind.needsBuild} buildId={buildId} onStarted={setBuildId} onBuilt={(b) => (setBase(b), setBuilt(true))} />
  else if (step === 4 && base) body = <QueryPanel compact base={base} example={draft.kind?.example} />
  else if (step === 5 && base) body = <PublishFlow inline base={base} onDone={(b) => (onCreated(), onClose(), navigate(`/knowledge/${b.id}`))} />

  return (
    <Dialog
      open={open}
      onClose={() => exit()}
      size="lg"
      dismissible={step === 0}
      className="kb-wizard"
      title="新建知识库"
      description={<Stepper step={step} reached={reached} onGo={go} />}
      footer={
        <>
          {(base || (step === 1 && draft.name.trim())) && step < 5 && (
            <button type="button" className="btn btn-ghost kb-wizard-save" disabled={busy} onClick={() => void saveAndExit()}>
              保存草稿并退出
            </button>
          )}
          {error && <span className="ov-error kb-wizard-err">{error}</span>}
          {step > 0 && (
            <button type="button" className="btn" onClick={() => go(step - 1)} disabled={busy}>
              <ArrowLeft />
              上一步
            </button>
          )}
          {step > 0 && step < 5 && (
            <button type="button" className="btn btn-primary" disabled={!canNext || busy} onClick={() => void next()} title={missing.length && step === 1 ? `还差：${missing.join('、')}` : undefined}>
              {nextLabel}
              <ArrowRight />
            </button>
          )}
        </>
      }
    >
      <div key={step} className="kb-wizard-body tab-panel">
        {body}
      </div>
    </Dialog>
  )
}
