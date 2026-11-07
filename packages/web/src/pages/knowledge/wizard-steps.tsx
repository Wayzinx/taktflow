import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { KnowledgeBaseSummary, KnowledgeBuild, KnowledgeKindInfo, KnowledgeTestResult } from '@taktflow/core'
import { CircleCheck, CircleX, PencilLine, RotateCw, Zap } from 'lucide-react'
import { useSource } from '../../api'
import { ErrorState, SkeletonRows, SkeletonText, toast } from '../../components/ui'
import { BuildProgress } from './build-progress'
import { KindGlyph, useLiveBuild } from './card'
import { INTENTS } from './meta'
import { OpsPicker } from './ops-picker'
import { SchemaForm, type Schema } from './schema-form'
import type { WizardDraft } from './wizard'


export function StepData({ kind, draft, onChange, missing, id }: { kind: KnowledgeKindInfo; draft: WizardDraft; onChange: (p: Partial<WizardDraft>) => void; missing: string[]; id: string }) {
  const toggle = (id: (typeof INTENTS)[number]['id']) => onChange({ intents: draft.intents.includes(id) ? draft.intents.filter((x) => x !== id) : [...draft.intents, id] })
  return (
    <div className="kb-step-data">
      <div className="kb-step-kind">
        <KindGlyph kind={kind.kind} size={28} />
        <span>
          <strong>{kind.title}</strong>
          <span className="faint"> · {kind.summary}</span>
        </span>
      </div>
      <div className="ov-form">
        <div className="kb-row-2">
          <label className="ov-field">
            <span className="ov-field-label">
              名字 <span className="ov-req">必填</span>
              {draft.name.trim() && <span className="ov-field-hint mono">id：{id}</span>}
            </span>
            <input className="input" autoFocus data-autofocus value={draft.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="例如 商城文档" />
          </label>
          <div className="ov-field">
            <span className="ov-field-label">能回答的问题</span>
            <div className="kb-intent-toggles" role="group" aria-label="能回答的问题">
              {INTENTS.map((i) => (
                <button key={i.id} type="button" className={`kb-toggle pressable${draft.intents.includes(i.id) ? ' on' : ''}`} aria-pressed={draft.intents.includes(i.id)} title={i.hint} onClick={() => toggle(i.id)}>
                  {i.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <label className="ov-field">
          <span className="ov-field-label">
            说明<span className="ov-field-hint">给路由器和人看：能回答什么、不能回答什么</span>
          </span>
          <textarea className="textarea" rows={2} value={draft.description} onChange={(e) => onChange({ description: e.target.value })} placeholder="例如：商城前后端的开发规范与接口文档；不含运维值班信息" />
        </label>
        <SchemaForm kind={kind.kind} schema={kind.configSchema as Schema} value={draft.config} onChange={(config) => onChange({ config })} files={draft.files} onFiles={(files) => onChange({ files })} />
        {missing.length > 0 && <p className="kb-help">还差：{missing.join('、')}</p>}
      </div>
    </div>
  )
}

/** 第 3 步：进来就测一次（连接 / 读第一个文档），预览前几项。 */
export function StepTest({ base, result, onResult, onEdit, onBase }: { base: KnowledgeBaseSummary; result?: KnowledgeTestResult; onResult: (r: KnowledgeTestResult) => void; onEdit: () => void; onBase: (b: KnowledgeBaseSummary) => void }) {
  const ds = useSource()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error>()
  const started = useRef(false)
  const [allow, setAllow] = useState<string[]>(() => (base.config.allow as string[] | undefined) ?? [])
  // api：测试读出的操作就地勾选，写进 config.allow（服务端只放行 allow 里的 GET）
  async function saveAllow(next: string[]) {
    setAllow(next)
    try {
      onBase(await ds.updateKnowledgeBase(base.id, { config: { ...base.config, allow: next }, reason: '新建向导：勾选允许调用的操作' }))
    } catch (e) {
      toast('没能保存勾选', { tone: 'failed', body: (e as Error).message })
    }
  }
  async function run() {
    setBusy(true)
    setError(undefined)
    try {
      onResult(await ds.testKnowledgeBase(base.id))
    } catch (e) {
      setError(e as Error)
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    if (!result && !started.current) (started.current = true), void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (error) return <ErrorState compact error={error} onRetry={() => void run()} title="测试没有跑起来" />
  if (busy || !result)
    return (
      <div className="kb-test" aria-busy="true">
        <div className="kb-test-head">
          <span className="shimmer-text">正在测试连接，读取前几项</span>
        </div>
        <SkeletonRows rows={3} />
      </div>
    )
  return (
    <div className="kb-test">
      <div className={`kb-gate ${result.ok ? 'ok' : 'bad'}`} role={result.ok ? 'status' : 'alert'}>
        {result.ok ? <CircleCheck aria-hidden /> : <CircleX aria-hidden />}
        <span>{result.message}</span>
        <span className="kb-spacer" />
        {!result.ok && (
          <button type="button" className="btn btn-sm" onClick={onEdit}>
            <PencilLine />
            回去修改
          </button>
        )}
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => void run()}>
          <RotateCw />
          再测一次
        </button>
      </div>
      {base.kind === 'api' && result.ok && (
        <div className="ov-field">
          <span className="ov-field-label">允许调用的操作</span>
          <OpsPicker result={result} value={allow} onChange={(v) => void saveAllow(v)} />
        </div>
      )}
      {base.kind !== 'api' && !!result.preview?.length && (
        <ul className="kb-preview">
          {result.preview.map((p, i) => (
            <li key={p.ref} className="stagger-item" style={{ '--stagger-delay': `${i * 24}ms` } as CSSProperties}>
              <strong>{p.title}</strong>
              <span className="mono faint">{p.ref}</span>
              <span className="muted">{p.snippet}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** 第 4 步：进来就开始构建（不需要构建的类型直接说明）；构建结束后取回带候选版本的知识库。 */
export function StepBuild({ base, needsBuild, buildId, onStarted, onBuilt }: { base: KnowledgeBaseSummary; needsBuild: boolean; buildId?: string; onStarted: (id: string) => void; onBuilt: (b: KnowledgeBaseSummary) => void }) {
  const ds = useSource()
  const [error, setError] = useState<Error>()
  const started = useRef(false)
  const done = async (b: KnowledgeBuild) => {
    if (b.status === 'succeeded') onBuilt(await ds.knowledgeBase(base.id))
  }
  const live = useLiveBuild(base.id, buildId, (b) => void done(b))
  async function start() {
    setError(undefined)
    try {
      const b = await ds.startKnowledgeBuild(base.id, '新建向导：首次构建')
      onStarted(b.id)
    } catch (e) {
      setError(e as Error)
    }
  }
  useEffect(() => {
    if (needsBuild && !buildId && !started.current) (started.current = true), void start()
    if (!needsBuild) onBuilt(base)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (!needsBuild)
    return (
      <div className="kb-gate ok">
        <Zap aria-hidden />
        这个类型不需要构建：查询时实时读取。下一步直接试检索。
      </div>
    )
  if (error) return <ErrorState compact error={error} onRetry={() => void start()} title="构建没有启动" />
  if (!live) return <SkeletonText lines={4} />
  return (
    <div className="kb-step-build">
      <BuildProgress build={live} />
      {live.status === 'running' && <p className="kb-help">构建在后台跑：可以先保存草稿退出，进度会显示在列表卡片上。</p>}
      {live.status === 'cancelled' || live.status === 'failed' ? (
        <button type="button" className="btn" onClick={() => void start()}>
          <RotateCw />
          重新构建
        </button>
      ) : null}
    </div>
  )
}
