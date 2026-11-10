import { useEffect, useRef, useState } from 'react'
import { FileText, UserRoundPen } from 'lucide-react'
import type { Lesson } from '@taktflow/core'
import { useSource } from '../../api'
import { StatusBadge, toast } from '../../components/ui'
import { fmtRelative } from '../../lib/format'
import { Markdown } from '../../lib/markdown'
import { useLastDefined, usePresence } from '../../lib/motion'
import { VERDICT } from '../../lib/status'
import { LESSON_STATUS, SOURCE_LABEL, TRANSITIONS, type LessonStatus } from './lesson-meta'
import { LessonRatio, LessonStats } from './lesson-parts'

function TriggerList({ trigger }: { trigger: Lesson['trigger'] }) {
  const rows: Array<[string, string[], boolean]> = [
    ['角色', trigger.roles ?? [], true],
    ['路径', trigger.paths ?? [], true],
    ['错误签名', (trigger.signatures ?? []).map((s) => `/${s}/`), true],
    ['判决类别', (trigger.categories ?? []).map((c) => VERDICT[c]?.label ?? c), false],
  ]
  const filled = rows.filter(([, v]) => v.length > 0)
  if (filled.length === 0) return <p className="faint">没有限定触发条件：每个节点都会召回。</p>
  return (
    <dl className="lesson-trigger">
      {filled.map(([k, v, mono]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>
            {v.map((x) => (
              <span key={x} className={`chip chip-sm${mono ? ' mono' : ''}`} title={x.length > 80 ? x : undefined}>
                {x}
              </span>
            ))}
          </dd>
        </div>
      ))}
      <p className="lesson-trigger-note faint">任一条件命中即召回；同时写了多类时按"或"处理。</p>
    </dl>
  )
}

/** 改状态的原因表单：点操作按钮后展开，必须写原因才能提交（写进经验文件的留痕）。 */
function ReasonForm({ lesson, to, onCancel, onDone }: { lesson: Lesson; to?: LessonStatus; onCancel(): void; onDone(l: Lesson): void }) {
  const ds = useSource()
  const p = usePresence(!!to, 140)
  const shown = useLastDefined(to)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (to) {
      setReason('')
      ref.current?.focus()
    }
  }, [to])
  if (!p.mounted || !shown) return null
  const label = TRANSITIONS[lesson.status].find((t) => t.to === shown)?.label ?? LESSON_STATUS[shown].label

  async function submit() {
    if (!reason.trim() || !shown) return
    setBusy(true)
    try {
      const l = await ds.updateLesson(lesson.id, { status: shown, reason: reason.trim() })
      toast(`${lesson.id} 已${LESSON_STATUS[shown].label}`, { body: LESSON_STATUS[shown].hint, tone: 'success' })
      onDone(l)
    } catch (e) {
      toast('修改失败', { body: (e as Error).message, tone: 'failed' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="lesson-reason"
      data-state={p.state}
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <label htmlFor={`lesson-reason-${lesson.id}`} className="field-label">
        {label}的原因（必填，会写进经验文件）
      </label>
      <textarea
        id={`lesson-reason-${lesson.id}`}
        ref={ref}
        className="textarea"
        rows={2}
        value={reason}
        placeholder={shown === 'retired' ? '例如：引导命令已包含 seed，不再需要注入' : '例如：近 5 次召回 4 次一次通过'}
        onChange={(e) => setReason(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
        }}
      />
      <div className="lesson-reason-foot">
        <span className="faint">{LESSON_STATUS[shown].hint}</span>
        <span className="spacer" />
        <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel} disabled={busy}>
          取消
        </button>
        <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !reason.trim()}>
          确认{label}
        </button>
      </div>
    </form>
  )
}

export function LessonDetail({ lesson, onChanged }: { lesson: Lesson; onChanged(l: Lesson): void }) {
  const [to, setTo] = useState<LessonStatus>()
  useEffect(() => setTo(undefined), [lesson.id])
  const meta = LESSON_STATUS[lesson.status]
  const src = lesson.source
  return (
    <article className="card lesson-detail" aria-labelledby={`lesson-title-${lesson.id}`}>
      <header className="lesson-detail-head">
        <div className="lesson-detail-title">
          <span className="mono faint">{lesson.id}</span>
          <h2 id={`lesson-title-${lesson.id}`}>{lesson.title}</h2>
        </div>
        <StatusBadge meta={meta} />
      </header>
      <div className="lesson-facts">
        <span className="chip chip-sm" title="经验来源">
          {SOURCE_LABEL[src.kind]}
          {src.ref && <span className="mono">{src.ref}</span>}
        </span>
        {src.runId && (
          <span className="mono faint truncate" title="产生这条经验的运行与节点">
            {src.runId}
            {src.nodeId ? ` · ${src.nodeId}` : ''}
          </span>
        )}
        {lesson.userStated && (
          <span className="chip chip-sm" title="人明确写下的经验：直接启用，不进对照组">
            <UserRoundPen />
            人工写下
          </span>
        )}
        <span className="spacer" />
        <span className="faint" title={lesson.updatedAt}>
          更新于 {fmtRelative(lesson.updatedAt)}
        </span>
      </div>

      <section className="lesson-section">
        <div className="section-label">召回效果</div>
        <div className="lesson-effect">
          <LessonStats stats={lesson.stats} />
          <LessonRatio stats={lesson.stats} />
        </div>
      </section>

      <section className="lesson-section">
        <div className="section-label">触发条件</div>
        <TriggerList trigger={lesson.trigger} />
      </section>

      <section className="lesson-section">
        <div className="section-label">
          <FileText aria-hidden />
          正文预览
        </div>
        <div className="lesson-body">
          <Markdown source={lesson.body} />
        </div>
      </section>

      <footer className="lesson-actions">
        <span className="faint">{meta.hint}</span>
        <span className="spacer" />
        {TRANSITIONS[lesson.status].map((t) => (
          <button key={t.to} className={`btn btn-sm${to === t.to ? ' is-on' : ''}`} aria-expanded={to === t.to} onClick={() => setTo((cur) => (cur === t.to ? undefined : t.to))}>
            {t.label}
          </button>
        ))}
      </footer>
      <ReasonForm
        lesson={lesson}
        to={to}
        onCancel={() => setTo(undefined)}
        onDone={(l) => {
          setTo(undefined)
          onChanged(l)
        }}
      />
    </article>
  )
}
