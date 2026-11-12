import { useState } from 'react'
import { ArrowUpRight, Check, CornerDownLeft, FileClock, Gauge, GitBranch, History, Lightbulb, MessageSquareText, PencilLine, RefreshCcwDot, ShieldAlert, TriangleAlert, Undo2, UserRound, UserRoundCheck, Workflow, X } from 'lucide-react'
import type { AttentionItem } from '@taktflow/core'
import { invalidate, useAsync, useSource } from '../api'
import { actorName, fmtRelative, tidyText } from '../lib/format'
import { Link, navigate, useSpaceHref } from '../lib/router'
import { answerOutcome } from './attention-outcome'
import { TimeboxBar } from './timebox'
import { toast } from './ui'
import './attention-card.css'

const FORM_META = {
  approve: { label: '审批', icon: UserRoundCheck },
  answer: { label: '回答', icon: MessageSquareText },
  choice: { label: '裁决', icon: ShieldAlert },
} as const

/** 引擎产生的待办类别（预算、重复失败、改档、流程变更）优先于表单类型显示。 */
const KIND_META = {
  budget: { label: '预算', icon: Gauge },
  retry: { label: '重复失败', icon: RefreshCcwDot },
  route: { label: '改档', icon: GitBranch },
  workflow_change: { label: '流程变更', icon: Workflow },
  assumption: { label: '待确认假设', icon: Lightbulb },
} as const

/** 待办的类别标签：引擎类别优先，否则按表单类型。 */
export const attentionMeta = (item: AttentionItem) => (item.kind && item.kind !== 'node' ? KIND_META[item.kind] : undefined) ?? FORM_META[item.form]

const artifactHref = (r: NonNullable<AttentionItem['boundTo']>[number]) => `/req/${r.workspace}?tab=artifacts&path=${encodeURIComponent(r.path)}${r.version ? `&v=${r.version}` : ''}`

/** 职责无人承担、已兜底转给需求负责人时的说明。 */
export interface AssigneeFallback {
  duty: string
  ownerName: string
}

/** 派给谁（职责 → 成员）与绑定的产物版本；产物之后有新版本时提示"审批对象已更新"。 */
function AttentionContext({ item, answered, fallback }: { item: AttentionItem; answered: boolean; fallback?: AssigneeFallback }) {
  const bound = item.boundTo ?? []
  const assignees = item.assignees ?? []
  if (!assignees.length && !item.owner && !bound.length) return null
  return (
    <>
      <div className="att-ctx">
        {(assignees.length > 0 || item.owner) && (
          <span className="att-ctx-item" title={item.owner ? `节点职责 ${item.owner}，按空间成员的职责标签派发` : undefined}>
            <UserRound />
            <span className="faint">派给</span>
            {assignees.length ? (
              <span className="att-assignees">{assignees.join('、')}</span>
            ) : fallback ? (
              <span className="att-assignees att-fallback">
                无人承担 <span className="mono">{fallback.duty}</span> → 已转给负责人 {fallback.ownerName}
              </span>
            ) : (
              <span className="faint">还没有成员承担此职责</span>
            )}
            {item.owner && <span className="att-duty mono">{item.owner}</span>}
          </span>
        )}
        {bound.length > 0 && (
          <span className="att-ctx-item">
            <FileClock />
            <span className="faint">{answered ? '审批时看到' : '审批对象'}</span>
            {bound.map((r) => (
              <Link key={r.path} to={artifactHref(r)} className="att-bound mono" title={`${r.workspace} · ${r.path}${r.version ? ` 第 ${r.version} 版` : ''}`}>
                {r.path}
                {r.version !== undefined && <span className="num">@v{r.version}</span>}
              </Link>
            ))}
          </span>
        )}
      </div>
      {item.stale && (
        <div className="att-stale" role="note">
          <History />
          <span>
            <b>审批对象已更新</b>
            <span className="att-stale-sub">{answered ? '这次确认针对的是旧版本，已过期；下游会按 stale 规则重跑。' : '上面的版本之后又有新版本，处理前请先看最新内容；提交时绑定最新版本。'}</span>
          </span>
          {bound[0] && (
            <Link to={`/req/${bound[0].workspace}?tab=artifacts&path=${encodeURIComponent(bound[0].path)}`} className="att-stale-link">
              看最新版本
              <ArrowUpRight />
            </Link>
          )}
        </div>
      )}
    </>
  )
}

function answerLabel(item: AttentionItem): string {
  if (item.kind === 'assumption') return item.answer === item.assumption ? '已确认假设' : '已改答'
  if (item.handedBack) return '已按假设交还'
  if (item.decision === 'approve') return '已通过'
  if (item.decision === 'reject') return '已打回'
  if (item.decision === 'choice') return '已裁决'
  return item.decision ?? '已回答'
}

/**
 * 待确认假设（docs/design/26 §3）：没等到回答，系统按提问方给的假设作答并继续了。
 * 人确认（回答 = 假设原文）或改答；改答会让这个节点与依赖它的节点过期，需要恢复运行后重跑。
 */
function AssumptionBody({ item, busy, compact, onSubmit }: { item: AttentionItem; busy: boolean; compact?: boolean; onSubmit: (body: { answer: string }, label: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(item.assumption ?? '')
  const changed = text.trim() && text.trim() !== item.assumption
  if (!editing)
    return (
      <div className="att-actions">
        <button className="btn btn-sm btn-primary" disabled={busy || !item.assumption} onClick={() => onSubmit({ answer: item.assumption! }, '已确认假设')}>
          <Check />
          确认假设
        </button>
        <button className="btn btn-sm" disabled={busy} onClick={() => setEditing(true)}>
          <PencilLine />
          改答
        </button>
      </div>
    )
  return (
    <div className="att-body">
      <textarea className="textarea" rows={compact ? 2 : 3} value={text} onChange={(e) => setText(e.target.value)} autoFocus aria-label="改答内容" />
      <p className="att-warn">
        <TriangleAlert />
        <span>
          改答后 <span className="mono">{item.nodeId}</span> 与依赖它的节点会标为过期，需要在运行页恢复运行后重跑。
        </span>
      </p>
      <div className="att-actions end">
        <button className="btn btn-sm" onClick={() => (setEditing(false), setText(item.assumption ?? ''))}>
          取消
        </button>
        <button className="btn btn-sm btn-primary" disabled={busy || !changed} onClick={() => onSubmit({ answer: text.trim() }, '已改答')}>
          <CornerDownLeft />
          提交改答
        </button>
      </div>
    </div>
  )
}

/** 原问题与交还时间：从被按假设作答的原待办取。 */
function AssumptionOrigin({ item }: { item: AttentionItem }) {
  const q = useAsync((s) => (item.assumedFor ? s.attention().then((l) => l.find((a) => a.requestId === item.assumedFor)) : Promise.resolve(undefined)), [item.assumedFor ?? ''])
  const origin = q.data
  return (
    <>
      {origin && (
        <p className="att-ask">
          <span className="att-label">原问题</span>
          {tidyText(origin.ask)}
        </p>
      )}
      <p className="att-assume">
        <Lightbulb />
        <span>
          <b>{item.answeredAt ? '当时按的假设：' : '系统按这个假设推进了：'}</b>
          {item.assumption}
        </span>
      </p>
      {origin?.answeredAt && (
        <p className="att-handback faint">
          <Undo2 />
          {fmtRelative(origin.answeredAt)}没等到回答，按假设交还给 Agent
          {origin.remindedAt?.length ? `（之前提醒过 ${origin.remindedAt.length} 次）` : ''}
        </p>
      )}
    </>
  )
}

const LONG_ASK = 360

/** 一条待办：审批 / 回答 / 选择，可以直接在卡片里处理。 */
export function AttentionCard({ item, reqTitle, compact, fallback }: { item: AttentionItem; reqTitle?: string; compact?: boolean; fallback?: AssigneeFallback }) {
  const ds = useSource()
  const at = useSpaceHref()
  const [text, setText] = useState('')
  const [choice, setChoice] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(!compact)
  const [full, setFull] = useState(false)
  // 长提问（例如门禁明细）先收成几行，要看再展开，免得一张卡片占满整屏
  const ask = tidyText(item.ask)
  const long = !compact && (ask.length > LONG_ASK || ask.split('\n').length > 6)
  const meta = attentionMeta(item)
  const Icon = meta.icon
  const answered = Boolean(item.answeredAt)

  async function submit(body: { decision?: string; answer?: string }, label: string) {
    setBusy(true)
    try {
      await ds.answer(item.requestId, body)
      if (label === '已改答')
        toast(`${label}：${item.requirementId} · ${item.nodeId}`, {
          body: '这个节点与依赖它的节点已标为过期，恢复运行后会按新的回答重跑。',
          action: { label: '去运行页', onClick: () => navigate(at(`/run/${item.runId}?node=${encodeURIComponent(item.nodeId)}`)) },
        })
      else if (label === '已确认假设' || ds.mock) toast(`${label}：${item.requirementId} · ${item.nodeId}`, { body: ds.mock ? '演示数据：已记入本页内存中的审计日志。' : '假设已确认，运行照常继续。', tone: 'success' })
      else {
        const outcome = answerOutcome(item, body)
        toast(`${label}：${item.requirementId} · ${item.nodeId}`, {
          body: outcome.body,
          tone: outcome.tone,
          action: outcome.stopped ? { label: '去需求页', onClick: () => navigate(at(`/req/${item.requirementId}`)) } : undefined,
        })
      }
      invalidate()
    } catch (e) {
      toast('提交失败', { body: (e as Error).message, tone: 'failed' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-steward-anchor={`${item.requestId} ${item.requirementId}`} className={`att-card${compact ? ' compact' : ''}${answered ? ' answered' : ''}${item.stale ? ' stale' : ''}`}>
      <div className="att-head">
        <span className="att-form">
          <Icon />
          {meta.label}
        </span>
        <Link to={`/req/${item.requirementId}`} className="att-req mono">
          {item.requirementId}
        </Link>
        {reqTitle && <span className="att-req-title truncate">{reqTitle}</span>}
        <span style={{ flex: 1 }} />
        {item.stale && (
          <span className="att-stale-chip" title="审批对象之后有新版本">
            <History />
            已过期
          </span>
        )}
        <span className="att-time" title={item.createdAt}>
          {fmtRelative(item.createdAt)}
        </span>
      </div>
      {item.kind === 'assumption' ? (
        <AssumptionOrigin item={item} />
      ) : (
        <>
          <p className={`att-ask${long ? (full ? ' full' : ' clamped') : ''}`}>{long && !full ? ask.slice(0, LONG_ASK * 3) : ask}</p>
          {long && (
            <button type="button" className="att-more" aria-expanded={full} onClick={() => setFull((x) => !x)}>
              {full ? '收起' : '展开全文'}
            </button>
          )}
        </>
      )}
      <div className="att-node">
        <Link to={`/run/${item.runId}?node=${encodeURIComponent(item.nodeId)}`} className="att-node-link">
          <span className="mono">{item.nodeId}</span>
          <ArrowUpRight />
        </Link>
        <span className="faint mono">{item.runId}</span>
      </div>
      <AttentionContext item={item} answered={answered} fallback={fallback} />
      {!answered && item.timebox && item.kind !== 'assumption' && <TimeboxBar createdAt={item.createdAt} timebox={item.timebox} assumption={item.assumption} form={item.form} remindedAt={item.remindedAt} compact={compact} />}

      {answered ? (
        <div className={`att-result${item.handedBack ? ' is-back' : ''}`}>
          {item.handedBack ? <Undo2 /> : <Check />}
          <span title={item.answer}>
            {answerLabel(item)}
            {item.answer && <span className="faint"> · {item.answer}</span>}
          </span>
          <span className="faint" style={{ marginLeft: 'auto' }}>
            {item.answeredBy && <span className="mono">{actorName(item.answeredBy)} · </span>}
            {fmtRelative(item.answeredAt)}
          </span>
        </div>
      ) : item.kind === 'assumption' ? (
        <AssumptionBody item={item} busy={busy} compact={compact} onSubmit={submit} />
      ) : item.form === 'approve' ? (
        <div className="att-actions">
          {!compact && <input className="input" placeholder="意见（可选，进审计）" value={text} onChange={(e) => setText(e.target.value)} />}
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => submit({ decision: 'approve', answer: text || undefined }, '已通过')}>
            <Check />
            通过
          </button>
          <button className="btn btn-sm" disabled={busy} onClick={() => submit({ decision: 'reject', answer: text || undefined }, '已打回')}>
            <X />
            打回
          </button>
        </div>
      ) : item.form === 'answer' ? (
        open ? (
          <div className="att-body">
            <textarea
              className="textarea"
              rows={compact ? 2 : 3}
              placeholder="写下答复，会同步写入 decisions/ 并进审计"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) void submit({ answer: text.trim() }, '已回答')
              }}
            />
            <div className="att-actions end">
              <span className="faint att-hint">
                <span className="kbd">⌘</span> <span className="kbd">↵</span> 提交
              </span>
              <button className="btn btn-sm btn-primary" disabled={busy || !text.trim()} onClick={() => submit({ answer: text.trim() }, '已回答')}>
                <CornerDownLeft />
                提交回答
              </button>
            </div>
          </div>
        ) : (
          <div className="att-actions">
            <button className="btn btn-sm" onClick={() => setOpen(true)}>
              <MessageSquareText />
              回答
            </button>
          </div>
        )
      ) : (
        <div className="att-body">
          <div className="att-choices">
            {(item.choices ?? []).map((c) => (
              <button key={c} className={`att-choice${choice === c ? ' on' : ''}`} onClick={() => setChoice(c)}>
                <span className="att-radio" />
                {c}
              </button>
            ))}
          </div>
          <div className="att-actions end">
            {/* 编码与 CLI `takt answer --choice` 一致：decision 固定为 'choice'，answer 是选中的选项原文 */}
            <button className="btn btn-sm btn-primary" disabled={busy || !choice} onClick={() => choice && submit({ decision: 'choice', answer: choice }, '已裁决')}>
              提交裁决
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
