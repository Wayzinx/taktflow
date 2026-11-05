import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { CornerDownLeft, Search } from 'lucide-react'
import type { CommandInfo } from '@taktflow/core'
import { usePresence } from '../lib/motion'
import { TaktLoader } from './takt'
import { trapKeys, useRestoreFocus } from './ui/dialog'
import { RISK } from './ui/reason-dialog'
import { CommandForm } from './command-palette/command-form'
import { filterItems, usePaletteData, type Item } from './command-palette/items'
import './ui/overlay.css'
import './command-palette.css'

// ---------------------------------------------------------------- 开关：⌘K / Ctrl+K、顶栏按钮，或别的界面直接打开某条命令

interface PaletteState {
  open: boolean
  /** 直接打开到某条命令的表单（openCommand） */
  direct?: { id: string; input?: Record<string, unknown> }
}
let state: PaletteState = { open: false }
const subs = new Set<() => void>()
function set(next: PaletteState) {
  state = next
  subs.forEach((f) => f())
}
export function setPaletteOpen(v: boolean) {
  set(v ? { open: true } : { ...state, open: false })
}
/**
 * 打开 ⌘K 并直接进入某条命令的表单，input 预填参数（如 openCommand('run.cancel', { runId })）。
 * Esc 直接关闭，不回到列表。
 */
export function openCommand(id: string, input?: Record<string, unknown>) {
  set({ open: true, direct: { id, input } })
}
function usePaletteState() {
  return useSyncExternalStore(
    (f) => {
      subs.add(f)
      return () => subs.delete(f)
    },
    () => state,
  )
}

export function CommandPalette() {
  const s = usePaletteState()
  const p = usePresence(s.open, 150)
  useRestoreFocus(s.open)
  // ?cmdk=1 首屏直接打开；?cmdk=<命令 id> 直接进该命令表单（截图与端到端测试用）。挂载时读，模块加载不碰 location
  useEffect(() => {
    const initial = new URLSearchParams(location.search).get('cmdk')
    if (initial) set({ open: true, direct: initial !== '1' ? { id: initial } : undefined })
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen(!state.open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  if (!p.mounted) return null
  return createPortal(
    <div className="cmdk-scrim presence-scrim" data-state={p.state} onMouseDown={() => setPaletteOpen(false)}>
      {/* 每次全新打开重置输入；退出途中重开保留 */}
      <PaletteDialog presence={p.state} direct={s.direct} />
    </div>,
    document.body,
  )
}

type Step = { kind: 'list' } | { kind: 'form'; cmd: CommandInfo; input?: Record<string, unknown>; direct: boolean }

function PaletteDialog({ presence, direct }: { presence: string; direct?: PaletteState['direct'] }) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const [step, setStep] = useState<Step>({ kind: 'list' })
  const data = usePaletteData(true)
  const results = useMemo(() => filterItems(data.items, q), [data.items, q])
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const close = () => setPaletteOpen(false)

  // openCommand：命令列表到了就进表单
  const directKey = direct ? `${direct.id}:${JSON.stringify(direct.input ?? {})}` : ''
  useEffect(() => {
    if (!direct) return
    const cmd = data.items.find((i) => i.command?.id === direct.id)?.command
    if (cmd) setStep({ kind: 'form', cmd, input: direct.input, direct: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directKey, data.items])

  useEffect(() => setSel(0), [q])
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const pick = (it: Item | undefined) => {
    if (!it) return
    if (it.command) {
      setStep({ kind: 'form', cmd: it.command, direct: false })
      return
    }
    close()
    it.run?.()
  }
  const back = () => {
    if (step.kind === 'form' && step.direct) return close()
    setStep({ kind: 'list' })
    requestAnimationFrame(() => inputRef.current?.focus())
  }
  const onListKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown') setSel((s) => Math.min(s + 1, results.length - 1))
    else if (e.key === 'ArrowUp') setSel((s) => Math.max(s - 1, 0))
    else if (e.key === 'Enter') pick(results[sel])
    else return
    e.preventDefault()
  }

  const waitingDirect = !!direct && step.kind === 'list' && data.loading
  let lastGroup = ''
  return (
    <div
      className="cmdk presence-dialog"
      data-state={presence}
      role="dialog"
      aria-modal="true"
      aria-label="命令面板"
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => trapKeys(e, step.kind === 'form' ? back : close)}
    >
      {step.kind === 'form' ? (
        <CommandForm key={step.cmd.id} cmd={step.cmd} given={step.input} data={data} onBack={back} onDone={close} backLabel={step.direct ? '关闭' : '返回列表'} />
      ) : waitingDirect ? (
        <TaktLoader compact label="正在读取命令" />
      ) : (
        <div className="cmdk-step" onKeyDown={onListKey}>
          <div className="cmdk-input-row">
            <Search aria-hidden />
            <input
              ref={inputRef}
              autoFocus
              className="cmdk-input"
              placeholder="搜索需求、运行、页面或命令…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              role="combobox"
              aria-expanded="true"
              aria-controls="cmdk-list"
              aria-activedescendant={results[sel] ? `cmdk-${sel}` : undefined}
            />
            <span className="kbd">Esc</span>
          </div>
          <div className="cmdk-list" id="cmdk-list" role="listbox" ref={listRef}>
            {results.map((it, i) => {
              const head = it.group !== lastGroup ? it.group : null
              lastGroup = it.group
              const Icon = it.icon
              return (
                <div key={it.id} role="presentation">
                  {head && <div className="cmdk-group">{head}</div>}
                  <div
                    id={`cmdk-${i}`}
                    data-idx={i}
                    role="option"
                    aria-selected={i === sel}
                    className={`cmdk-item${i === sel ? ' on' : ''}${it.command?.risk === 'dangerous' ? ' danger' : ''}`}
                    title={it.command ? `${RISK[it.command.risk].label}：${RISK[it.command.risk].hint}` : undefined}
                    onMouseMove={() => i !== sel && setSel(i)}
                    onClick={() => pick(it)}
                  >
                    <Icon className="cmdk-icon" style={it.tone ? { color: it.tone } : undefined} aria-hidden />
                    {it.code && !it.command && <span className="mono cmdk-code">{it.code}</span>}
                    <span className="truncate cmdk-label">{it.label}</span>
                    {it.command && <span className="mono cmdk-code cmdk-code-dim">{it.code}</span>}
                    {it.hint && <span className={`cmdk-hint${it.inContext ? ' ctx' : ''}`}>{it.hint}</span>}
                    {i === sel && <CornerDownLeft className="cmdk-enter" aria-hidden />}
                  </div>
                </div>
              )
            })}
            {!results.length && (data.loading ? <TaktLoader compact label="正在读取需求、运行与命令" /> : <div className="cmdk-empty">没有匹配“{q}”的需求、运行、页面或命令</div>)}
          </div>
          <div className="cmdk-foot">
            <span>
              <span className="kbd">↑</span> <span className="kbd">↓</span> 选择
            </span>
            <span>
              <span className="kbd">↵</span> {results[sel]?.command ? '填写参数' : '打开'}
            </span>
            <span className="cmdk-foot-count num">{results.length} 项</span>
          </div>
        </div>
      )}
    </div>
  )
}
