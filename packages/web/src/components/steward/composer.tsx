import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowUp, AtSign, FileText, Paperclip, Square, SquareSlash, X } from 'lucide-react'
import type { StewardContextRef, StewardPostRequest } from '@taktflow/core'
import { useSource } from '../../api'
import { Chips, Popover, SkeletonRows, toast } from '../ui'
import { commandItems, filterItems, findMentions, loadMentions, triggerAt, useLazy, type PickItem } from './mentions'

type Attachment = NonNullable<StewardPostRequest['attachments']>[number]
const MAX_FILE = 200_000
const refKey = (c: StewardContextRef) => `${c.type}:${c.id}`
const CTX_LABEL: Record<StewardContextRef['type'], string> = { space: '空间', requirement: '需求', run: '运行', node: '节点', workflow: '流水线', knowledge: '知识库', file: '文件' }

export interface ComposerProps {
  draft: string
  onDraft: (v: string) => void
  context: StewardContextRef[]
  onContext: (next: StewardContextRef[]) => void
  /** 返回 false 表示没发出去，草稿保留。 */
  onSend: (text: string, extra: { context: StewardContextRef[]; attachments: Attachment[] }) => Promise<boolean> | boolean
  busy?: boolean
  /** 管家正在回复时给：发送键换成停止键，Esc 也能停。 */
  onStop?: () => void
  placeholder?: string
  autoFocus?: boolean
  /** @ 跨全部空间找（服务端 find 排序）；否则只列当前空间的对象。 */
  globalMentions?: boolean
  /** 工具栏左侧附件按钮之后的额外控件（管家的 harness × 模型选择器）。 */
  tools?: ReactNode
}

/** 跨空间 @：输入停 160ms 再查；查询期间保留上一批结果，免得每敲一个字就闪成骨架。 */
function useFoundMentions(q: string | undefined): PickItem[] | undefined {
  const ds = useSource()
  const [found, setFound] = useState<PickItem[]>()
  useEffect(() => {
    if (q === undefined) return
    let alive = true
    const t = setTimeout(() => void findMentions(ds, q).then((items) => alive && setFound(items)), q ? 160 : 0)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [ds, q])
  return q === undefined ? undefined : found
}

/**
 * 管家输入框（docs/design/22 §1.3）：@ 引用对象、/ 选命令、附件（按钮或拖入，文本文件）、Enter 发送、Shift+Enter 换行。
 * 上下文标签在输入框上方，可删；@ 选中的对象会加进上下文。
 */
export function Composer({ draft, onDraft, context, onContext, onSend, busy, onStop, placeholder = '问管家，或让它帮你做点什么', autoFocus, globalMentions, tools }: ComposerProps) {
  const ds = useSource()
  const box = useRef<HTMLDivElement>(null)
  const ta = useRef<HTMLTextAreaElement>(null)
  const file = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<Attachment[]>([])
  const [drag, setDrag] = useState(false)
  const [caret, setCaret] = useState(0)
  const [sel, setSel] = useState(0)
  const [dismissed, setDismissed] = useState<number>()
  const trig = triggerAt(draft, caret)
  const mentions = useLazy(() => loadMentions(ds), trig?.kind === '@' && !globalMentions)
  const found = useFoundMentions(globalMentions && trig?.kind === '@' ? trig.query : undefined)
  const commands = useLazy(() => ds.commands().then(commandItems).catch(() => [] as PickItem[]), trig?.kind === '/')
  const pool = trig?.kind === '@' ? (globalMentions ? found : mentions) : trig?.kind === '/' ? commands : undefined
  // 跨空间时服务端已经按编号 / 标题 / 最近排好序
  const items = trig && pool ? (globalMentions && trig.kind === '@' ? pool : filterItems(pool, trig.query)) : []
  const pickerOpen = !!trig && dismissed !== trig.start && (pool === undefined || items.length > 0)

  useEffect(() => setSel(0), [trig?.kind, trig?.query])
  // 高度跟内容走（最多 8 行），不做过渡
  useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 8 * 22 + 16)}px`
  }, [draft])
  useEffect(() => {
    if (autoFocus) ta.current?.focus({ preventScroll: true })
  }, [autoFocus])

  const pick = (it: PickItem | undefined) => {
    if (!it || !trig) return
    const next = draft.slice(0, trig.start) + it.insert + (it.insert.endsWith(' ') ? '' : ' ') + draft.slice(caret)
    onDraft(next)
    if (it.ref && !context.some((c) => refKey(c) === refKey(it.ref!))) onContext([...context, it.ref])
    const pos = trig.start + it.insert.length + (it.insert.endsWith(' ') ? 0 : 1)
    requestAnimationFrame(() => {
      ta.current?.focus()
      ta.current?.setSelectionRange(pos, pos)
      setCaret(pos)
    })
  }

  const send = async () => {
    const text = draft.trim()
    if (!text || busy) return
    const sentFiles = files
    onDraft('')
    setFiles([])
    const ok = await onSend(text, { context, attachments: sentFiles })
    if (!ok) {
      onDraft(text)
      setFiles(sentFiles)
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (pickerOpen && items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setSel((s) => (s + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        return pick(items[sel])
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        return setDismissed(trig!.start)
      }
    }
    if (e.key === 'Escape' && onStop) {
      e.preventDefault()
      return onStop()
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  const addFiles = async (list: FileList | null) => {
    for (const f of Array.from(list ?? [])) {
      if (f.size > MAX_FILE) {
        toast(`${f.name} 太大`, { tone: 'failed', body: '附件只收 200KB 以内的文本文件' })
        continue
      }
      const content = await f.text()
      setFiles((cur) => [...cur.filter((x) => x.name !== f.name), { name: f.name, content }])
    }
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDrag(false)
    void addFiles(e.dataTransfer.files)
  }
  const insertTrigger = (ch: '@' | '/') => {
    const el = ta.current
    const at = el?.selectionStart ?? draft.length
    const pre = draft.slice(0, at)
    const glue = pre && !/\s$/.test(pre) ? ' ' : ''
    onDraft(pre + glue + ch + draft.slice(at))
    const pos = at + glue.length + 1
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(pos, pos)
      setCaret(pos)
      setDismissed(undefined)
    })
  }

  return (
    <div
      ref={box}
      className="stw-composer"
      data-drag={drag || undefined}
      data-busy={onStop ? true : undefined}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDrag(true)
      }}
      onDragLeave={(e) => {
        if (!box.current?.contains(e.relatedTarget as Node)) setDrag(false)
      }}
      onDrop={onDrop}
    >
      {(context.length > 0 || files.length > 0) && (
        <div className="stw-composer-ctx">
          {context.length > 0 && <Chips items={context.map((c) => ({ id: refKey(c), label: c.label ?? c.id, title: `${CTX_LABEL[c.type]}：${c.id}` }))} onRemove={(id) => onContext(context.filter((c) => refKey(c) !== id))} />}
          {files.map((f) => (
            <span key={f.name} className="ui-chip stw-file">
              <FileText aria-hidden />
              <span className="truncate">{f.name}</span>
              <button type="button" className="ui-chip-x" aria-label={`移除 ${f.name}`} onClick={() => setFiles((cur) => cur.filter((x) => x.name !== f.name))}>
                <X />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={ta}
        className="stw-input"
        rows={1}
        value={draft}
        placeholder={placeholder}
        aria-label="给管家的消息"
        data-autofocus
        onChange={(e) => {
          onDraft(e.target.value)
          setCaret(e.target.selectionStart)
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={onKey}
      />
      <div className="stw-composer-bar">
        <button type="button" className="btn btn-ghost btn-icon btn-sm" title="引用空间、需求、运行、流水线、知识库（@）" aria-label="引用" onClick={() => insertTrigger('@')}>
          <AtSign />
        </button>
        <button type="button" className="btn btn-ghost btn-icon btn-sm" title="选命令（/）" aria-label="命令" onClick={() => insertTrigger('/')}>
          <SquareSlash />
        </button>
        <button type="button" className="btn btn-ghost btn-icon btn-sm" title="添加附件（也可以拖进来）" aria-label="添加附件" onClick={() => file.current?.click()}>
          <Paperclip />
        </button>
        <input ref={file} type="file" multiple hidden accept=".md,.txt,.json,.ts,.tsx,.js,.yaml,.yml,.csv,.log,text/*" onChange={(e) => void addFiles(e.target.files).then(() => (e.target.value = ''))} />
        {tools}
        <span className="stw-composer-hint faint">{onStop ? '管家正在回复 · Esc 停止' : 'Enter 发送 · Shift+Enter 换行'}</span>
        {onStop ? (
          <button type="button" className="btn btn-icon btn-sm stw-send stw-stop" title="停止（Esc）" aria-label="停止回复" onClick={onStop}>
            <Square />
          </button>
        ) : (
          <button type="button" className="btn btn-primary btn-icon btn-sm stw-send" title="发送（Enter）" aria-label="发送" disabled={!draft.trim() || busy} onClick={() => void send()}>
            <ArrowUp />
          </button>
        )}
      </div>
      {drag && <div className="stw-drop">松开即可添加附件</div>}
      <Popover open={pickerOpen} onClose={() => setDismissed(trig?.start)} anchor={box} placement="top-start" matchWidth className="stw-picker" role="listbox" ariaLabel={trig?.kind === '@' ? '引用' : '命令'}>
        {pool === undefined ? (
          <div className="stw-picker-sk">
            <SkeletonRows rows={3} gap={10} />
          </div>
        ) : (
          <div className="ov-menu-list">
            {items.map((it, i) => {
              const Icon = it.icon
              return (
                <div key={it.key}>
                  {(i === 0 || items[i - 1]!.section !== it.section) && <div className="ov-mi-section">{it.section}</div>}
                  <div role="option" aria-selected={i === sel} className={`ov-mi${i === sel ? ' on' : ''}`} onMouseEnter={() => setSel(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(it)}>
                    <Icon className="ov-mi-icon" aria-hidden />
                    <span className="ov-mi-label truncate">{it.label}</span>
                    {it.hint && <span className="ov-mi-hint mono">{it.hint}</span>}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Popover>
    </div>
  )
}
