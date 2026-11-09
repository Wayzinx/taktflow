/**
 * 设置页表单的公共件（docs/design/21）：分节、字段、标签输入、保存条、修改记录、“告诉 Lead”。
 * 所有写操作都要一句修改原因：它和改动一起进修订记录与审计。
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { History, MessageSquareText, Plus, RotateCcw, Save, Send, X } from 'lucide-react'
import type { SpaceFileRevision, SpaceRevisionKind } from '@taktflow/core'
import { useAsync, useSource } from '../../api'
import { Dialog } from '../../components/ui/dialog'
import { ReasonDialog } from '../../components/ui/reason-dialog'
import { EmptyState, ErrorState, SkeletonRows, toast } from '../../components/ui'
import { fmtDate, fmtRelative } from '../../lib/format'
import { splitTagDraft } from './settings-tags'
import './settings-kit.css'

export function Section({ title, hint, actions, children }: { title: ReactNode; hint?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="sk-section">
      <header className="sk-section-head">
        <div className="sk-section-text">
          <h3 className="sk-section-title">{title}</h3>
          {hint && <p className="sk-section-hint">{hint}</p>}
        </div>
        {actions && <div className="sk-section-actions">{actions}</div>}
      </header>
      <div className="sk-section-body">{children}</div>
    </section>
  )
}

export function Field({ label, hint, error, children, wide }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`sk-field${wide ? ' wide' : ''}`}>
      <span className="field-label">{label}</span>
      {children}
      {error && <span className="sk-field-error" role="alert">{error}</span>}
      {hint && <span className="sk-field-hint">{hint}</span>}
    </label>
  )
}

/**
 * 字符串列表输入：默认回车或逗号添加，退格删最后一个；presets 是一键添加的常用值。
 * split="enter" 用于命令等本身就带空格/逗号的精确值：只按回车添加，整条保留。
 * Enter 和失焦使用同一套切分规则，避免“回车切成三段、失焦又成一整条”。
 */
export function TagInput({ value, onChange, placeholder, presets, mono, ariaLabel, split = 'comma' }: {
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  presets?: Array<{ label: string; values: string[] }>
  mono?: boolean
  ariaLabel?: string
  split?: 'comma' | 'enter'
}) {
  const [draft, setDraft] = useState('')
  const add = (items: string[]) => {
    const next = [...value]
    for (const item of items.map((x) => x.trim()).filter(Boolean)) if (!next.includes(item)) next.push(item)
    onChange(next)
  }
  const commit = () => {
    add(splitTagDraft(draft, split))
    setDraft('')
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || (split === 'comma' && (e.key === ',' || e.key === '，'))) {
      e.preventDefault()
      commit()
    } else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1))
  }
  return (
    <div className="sk-tags-wrap">
      <div className="sk-tags input" onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()}>
        {value.map((item) => (
          <span key={item} className={`chip sk-tag${mono ? ' mono' : ''}`}>
            {item}
            <button type="button" className="sk-tag-x" aria-label={`移除 ${item}`} onClick={() => onChange(value.filter((x) => x !== item))}>
              <X />
            </button>
          </span>
        ))}
        <input
          className={`sk-tags-input${mono ? ' mono' : ''}`}
          value={draft}
          aria-label={ariaLabel}
          placeholder={value.length ? '' : placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          onBlur={commit}
        />
      </div>
      {presets && presets.length > 0 && (
        <div className="sk-presets">
          {presets.map((p) => {
            const on = p.values.every((v) => value.includes(v))
            return (
              <button key={p.label} type="button" className={`btn btn-ghost btn-sm sk-preset${on ? ' on' : ''}`} disabled={on} onClick={() => add(p.values)}>
                <Plus />
                {p.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** 底部保存条：有改动才可保存，原因必填；⌘S 保存。 */
export function SaveBar({ dirty, busy, onSave, onReset, extra, savedHint }: {
  dirty: boolean
  busy?: boolean
  onSave: (reason: string) => Promise<void> | void
  onReset: () => void
  extra?: ReactNode
  savedHint?: ReactNode
}) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const reasonRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (!dirty) setReason('') }, [dirty])
  const can = dirty && reason.trim() !== '' && !saving && !busy
  const save = async () => {
    if (!can) return
    setSaving(true)
    try { await onSave(reason.trim()) } finally { setSaving(false) }
  }
  const requestSave = () => {
    if (!dirty || saving || busy) return
    if (!reason.trim()) {
      reasonRef.current?.focus()
      toast('先填写修改原因', { body: '保存会写进修改记录，原因必填。' })
      return
    }
    void save()
  }
  const requestSaveRef = useRef(requestSave)
  requestSaveRef.current = requestSave
  // 快捷键挂在 document 上：焦点在正文表单里也能保存；嵌套编辑器（源文件）先 preventDefault 时不重复触发。
  useEffect(() => {
    if (!dirty) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 's') return
      if (e.defaultPrevented) return
      if ((e.target as HTMLElement | null)?.closest('[role="dialog"]')) return
      e.preventDefault()
      requestSaveRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [dirty])
  return (
    <div className={`sk-savebar${dirty ? ' dirty' : ''}`}>
      {extra}
      <span className="spacer" />
      {dirty ? (
        <>
          <input ref={reasonRef} className="input sk-reason" placeholder="修改原因（必填，写进修改记录）" value={reason} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') requestSave() }} aria-label="修改原因" />
          <button type="button" className="btn btn-sm" onClick={onReset} disabled={saving}>还原</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={requestSave} disabled={!can} title="⌘S / Ctrl+S">
            <Save />
            {saving ? '保存中…' : '保存'}
          </button>
        </>
      ) : (
        <span className="faint sk-saved">{savedHint ?? '没有未保存的修改'}</span>
      )}
    </div>
  )
}

/** 修改记录：列出修订，选一个恢复（恢复本身也记一条修订）。 */
export function RevisionsButton({ kind, name, label = '修改记录', onRestored }: { kind: SpaceRevisionKind; name?: string; label?: string; onRestored: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>
        <History />
        {label}
      </button>
      {open && <RevisionsDialog kind={kind} name={name} onClose={() => setOpen(false)} onRestored={onRestored} />}
    </>
  )
}

function RevisionsDialog({ kind, name, onClose, onRestored }: { kind: SpaceRevisionKind; name?: string; onClose: () => void; onRestored: () => void }) {
  const ds = useSource()
  const q = useAsync((d) => d.fileRevisions(kind, name), [kind, name])
  const [target, setTarget] = useState<SpaceFileRevision>()
  const list = q.data ?? []
  return (
    <Dialog open onClose={onClose} title="修改记录" description="每次保存都会留一条记录；恢复到某个版本也会记一条新的。" size="md">
      {q.error && !q.data ? (
        <ErrorState error={q.error} onRetry={q.reload} />
      ) : !q.data ? (
        <SkeletonRows rows={4} />
      ) : list.length === 0 ? (
        <EmptyState icon={History} title="还没有修改记录" hint="在这里保存过一次之后就会出现。" compact />
      ) : (
        <ol className="sk-revs">
          {list.map((r, i) => (
            <li key={`${r.rev}-${i}`} className="sk-rev">
              <div className="sk-rev-main">
                <div className="sk-rev-title">
                  {r.summary}
                  {i === 0 && <span className="chip sk-rev-now">当前</span>}
                </div>
                <div className="sk-rev-meta">
                  <span>{actorLabel(r.author)}</span>
                  <span className="dot-sep" />
                  <span title={fmtDate(r.at)}>{fmtRelative(r.at)}</span>
                  <span className="dot-sep" />
                  <span className="truncate">{r.reason}</span>
                </div>
              </div>
              {i > 0 && (
                <button type="button" className="btn btn-sm" onClick={() => setTarget(r)}>
                  <RotateCcw />
                  恢复
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
      <ReasonDialog
        open={!!target}
        onClose={() => setTarget(undefined)}
        title="恢复到这个版本？"
        description={target ? `${target.summary} · ${fmtDate(target.at)}` : undefined}
        confirmLabel="恢复"
        onSubmit={async (reason) => {
          await ds.rollbackFile(kind, name, target!.rev, reason)
          toast('已恢复', { body: '恢复操作也记进了修改记录。' })
          q.reload()
          onRestored()
        }}
      />
    </Dialog>
  )
}

function actorLabel(actor: SpaceFileRevision['author']): string {
  if (actor.type === 'human') return actor.id
  if (actor.type === 'agent') return actor.onBehalfOf ? `${actor.role}（代 ${actor.onBehalfOf}）` : actor.role
  return actor.id === 'space-settings' ? '修改前' : actor.id
}

/** 宿主提供 askLead 时显示：一句话交给 Lead 去改，改完回到这里看结果。 */
export function AskLead({ page, placeholder, target }: { page: string; placeholder: string; target?: string }) {
  const ds = useSource()
  const host = ds.host
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  if (!host?.askLead) return null
  const send = async () => {
    const value = text.trim()
    if (!value || busy) return
    setBusy(true)
    try {
      const { sessionId } = await host.askLead!(value, { page, target })
      setText('')
      toast('已交给 Lead', { body: 'Lead 改完会在会话里说明改了什么、怎么撤回；这里的修改记录也能看到。' })
      host.openSession?.(sessionId)
    } catch (e) {
      toast('没能交给 Lead', { body: (e as Error).message, tone: 'failed' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="sk-asklead" onSubmit={(e) => { e.preventDefault(); void send() }}>
      <MessageSquareText aria-hidden />
      <input ref={input} className="sk-asklead-input" value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} aria-label="告诉 Lead 你想怎么改" maxLength={2000} />
      <button type="submit" className="btn btn-sm btn-primary" disabled={!text.trim() || busy}>
        <Send />
        {busy ? '发送中…' : '交给 Lead'}
      </button>
    </form>
  )
}

/** 把 ApiError 的 409 引用列表变成一句人话。 */
export function errorText(e: unknown): string {
  const err = e as { message?: string; detail?: { references?: unknown[] } }
  return err.message ?? String(e)
}
