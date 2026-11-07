import { useEffect, useState } from 'react'
import type { KnowledgeBaseSummary, KnowledgeEvalRun, KnowledgePublishResponse } from '@taktflow/core'
import { CircleCheck, CircleX, Rocket, ShieldAlert } from 'lucide-react'
import { useAsync, useSource } from '../../api'
import { Dialog, ReasonField, reasonOk, toast } from '../../components/ui'
import { setQuery } from '../../lib/router'

/** 发布门槛预览：最近一次包含候选版本的对比评测（发布时服务端会再判一次，以服务端为准）。 */
function GatePreview({ base, run }: { base: KnowledgeBaseSummary; run?: KnowledgeEvalRun }) {
  if (!base.version) return <div className="kb-gate ok"><CircleCheck aria-hidden />第一次发布是 v1，不需要过评测门槛。</div>
  const cmp = run?.comparison
  if (!cmp) return <div className="kb-gate warn"><ShieldAlert aria-hidden />还没有候选版本和已发布版本的对比评测，发布时会现跑一次门槛检查。</div>
  const m = run.metrics
  const worse = cmp.verdict === 'worse'
  return (
    <div className={`kb-gate ${worse ? 'bad' : 'ok'}`}>
      {worse ? <CircleX aria-hidden /> : <CircleCheck aria-hidden />}
      <span>
        最近一次对比（<span className="mono">{run.id}</span>）：Recall@10 <span className="num">{m[cmp.baseline]?.recall10.toFixed(2)}</span> → <span className="num">{m[cmp.candidate]?.recall10.toFixed(2)}</span>，胜 {cmp.wins} / 负 {cmp.losses} / 平 {cmp.ties}。{worse ? '大概率过不了门槛。' : '预计能过门槛。'}
      </span>
    </div>
  )
}

/**
 * 发布：先显示门槛（预览 → 服务端结果），不通过时列出原因；强制发布必须另写原因（进审计）。
 * inline 用在向导第 6 步，否则是对话框。
 */
export function PublishFlow({ base, onDone, inline }: { base: KnowledgeBaseSummary; onDone: (b: KnowledgeBaseSummary) => void; inline?: boolean }) {
  const ds = useSource()
  const target = base.candidateVersion ?? (base.version ? undefined : 1)
  const runs = useAsync((d) => d.knowledgeEvalRuns(base.id), [base.id])
  const run = runs.data?.find((r) => r.status === 'done' && r.variants.some((v) => v.version === base.candidateVersion))
  const [reason, setReason] = useState(target ? `发布${base.version ? '候选' : ''} v${target}` : '')
  const [forceReason, setForceReason] = useState('')
  const [gate, setGate] = useState<KnowledgePublishResponse['gate']>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  async function publish(force: boolean) {
    setBusy(true)
    setError(undefined)
    try {
      const r = await ds.publishKnowledge(base.id, { version: target, reason: force ? forceReason : reason, force })
      if (!r.gate.pass && !force) return setGate(r.gate)
      toast(`${base.name} 已发布 v${r.base.version}`, { body: force ? '门槛未过，已按原因强制发布，记入审计。' : '运行中的节点从下一次查询起使用新版本。', tone: force ? 'waiting' : 'success' })
      onDone(r.base)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!target) return <p className="kb-help">没有可发布的候选版本：先构建一次。</p>
  const body = gate ? (
    <div className="kb-gate-fail tab-panel" role="alert">
      <div className="kb-gate bad">
        <CircleX aria-hidden />
        <span>
          门槛没有通过，v{target} 没有发布。{gate.evalRunId && <button type="button" className="kb-link" onClick={() => setQuery({ tab: 'eval', run: gate.evalRunId })}>看评测 {gate.evalRunId}</button>}
        </span>
      </div>
      <ol className="kb-gate-reasons">
        {gate.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ol>
      <ReasonField risk="dangerous" value={forceReason} onChange={setForceReason} placeholder="为什么要绕过门槛发布：例如召回下降来自已知的文档删除" />
    </div>
  ) : (
    <div className="ov-form">
      <div className="kb-publish-what">
        <Rocket aria-hidden />
        <span>
          发布 <strong className="num">v{target}</strong>
          {base.version ? <> 替换已发布的 <span className="num">v{base.version}</span></> : null}；运行时只用已发布版本。
        </span>
      </div>
      <GatePreview base={base} run={run} />
      <ReasonField value={reason} onChange={setReason} />
    </div>
  )
  const actions = gate ? (
    <>
      <button type="button" className="btn" onClick={() => setGate(undefined)} disabled={busy}>
        返回
      </button>
      <button type="button" className="btn btn-danger" disabled={busy || !reasonOk(forceReason)} onClick={() => void publish(true)}>
        强制发布
      </button>
    </>
  ) : (
    <button type="button" className="btn btn-primary" disabled={busy || !reasonOk(reason)} onClick={() => void publish(false)}>
      <Rocket />
      发布 v{target}
    </button>
  )
  return (
    <div className={inline ? 'kb-publish-inline' : 'kb-publish'}>
      {body}
      {error && <p className="ov-error">{error}</p>}
      <div className="kb-publish-actions">{actions}</div>
    </div>
  )
}

export function PublishDialog({ base, open, onClose, onDone }: { base: KnowledgeBaseSummary; open: boolean; onClose: () => void; onDone: () => void }) {
  // 每次打开重置表单；关闭时保留内容，让退出动画有最后一帧
  const [n, setN] = useState(0)
  useEffect(() => {
    if (open) setN((x) => x + 1)
  }, [open])
  return (
    <Dialog open={open} onClose={onClose} title={`发布 ${base.name}`} description="发布前先过评测门槛：Recall@10 不能显著下降，缺陷用例必须全部通过。">
      <PublishFlow key={n} base={base} onDone={() => (onDone(), onClose())} />
    </Dialog>
  )
}
