import { createContext, useContext, useEffect, useId, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { useLocation } from './router'

/**
 * 设置表单草稿：切换 Tab / 角色 / 技能后回来还能接着改。
 * 草稿只放 sessionStorage，并按空间/会话隔离；显式 scope 的草稿在切换空间后仍可恢复，
 * 不会把 A 空间的未保存内容带进 B 空间。
 */

const PREFIX = 'taktflow.settings.draft:'
const DraftScopeContext = createContext<string | undefined>(undefined)

interface Envelope {
  base: string
  value: unknown
}

function storage(): Storage | undefined {
  try {
    return window.sessionStorage
  } catch {
    return undefined
  }
}

function readEnvelope(key: string): Envelope | undefined {
  try {
    const raw = storage()?.getItem(key)
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as Partial<Envelope> | undefined
    if (!parsed || typeof parsed.base !== 'string' || !('value' in parsed)) return undefined
    return { base: parsed.base, value: parsed.value }
  } catch {
    return undefined
  }
}

function writeEnvelope(key: string, envelope: Envelope): void {
  try {
    storage()?.setItem(key, JSON.stringify(envelope))
  } catch {
    // 隐私模式或配额满：记不住草稿不影响当前编辑。
  }
}

function remove(key: string): void {
  try {
    storage()?.removeItem(key)
  } catch {
    // 同上。
  }
}

function clearScope(scope: string): void {
  const store = storage()
  if (!store) return
  const prefix = `${PREFIX}${scope}:`
  const keys: string[] = []
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i)
    if (key?.startsWith(prefix)) keys.push(key)
  }
  for (const key of keys) remove(key)
}

function compatible(value: unknown, original: unknown): boolean {
  if (Array.isArray(original)) return Array.isArray(value)
  if (original !== null && typeof original === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value)
  return typeof value === typeof original
}

/** 显式 scope 由嵌入方传入（空间路径 / 会话）；独立页面按 URL 里的空间隔离。 */
export function DraftScopeProvider({ scope, children }: { scope?: string; children: ReactNode }) {
  const auto = useId()
  const id = scope ?? `embed:${auto}`
  useEffect(() => {
    if (scope !== undefined) return
    return () => clearScope(id)
  }, [id, scope])
  return <DraftScopeContext.Provider value={id}>{children}</DraftScopeContext.Provider>
}

function useDraftScope(): string {
  const explicit = useContext(DraftScopeContext)
  const { spaceId } = useLocation()
  return explicit ?? (spaceId ? `space:${spaceId}` : 'app')
}

export interface DraftForm<T> {
  form: T
  setForm: Dispatch<SetStateAction<T>>
  dirty: boolean
  /** 丢弃草稿并回到服务端当前值。 */
  reset: () => void
  /** 保存成功、服务端返回新值前调用：下一次服务端值变化时保留保存期间的新编辑。 */
  markSaved: (submitted: T) => void
}

export function useDraftForm<T>(key: string, original: T, base = ''): DraftForm<T> {
  const scope = useDraftScope()
  const storageKey = `${PREFIX}${scope}:${key}`
  const fingerprint = `${base}\u0000${JSON.stringify(original)}`
  const [form, setForm] = useState<T>(() => {
    const saved = readEnvelope(storageKey)
    if (saved?.base === fingerprint && compatible(saved.value, original)) return saved.value as T
    return original
  })
  const previous = useRef(fingerprint)
  const submitted = useRef<T | undefined>(undefined)

  useEffect(() => {
    const current = JSON.stringify(form)
    if (previous.current !== fingerprint) {
      previous.current = fingerprint
      const saved = submitted.current
      submitted.current = undefined
      // 不是本表单保存引起的服务端变化，或保存期间没有新编辑：直接采用服务端值。
      if (saved === undefined || current === JSON.stringify(saved)) {
        setForm(original)
        remove(storageKey)
        return
      }
      // 保存期间用户又改了：保留新编辑，并按新的服务端值重新计算 dirty。
    }
    if (current !== JSON.stringify(original)) writeEnvelope(storageKey, { base: fingerprint, value: form })
    else remove(storageKey)
  }, [fingerprint, storageKey, form, original])

  return {
    form,
    setForm,
    dirty: JSON.stringify(form) !== JSON.stringify(original),
    reset: () => {
      setForm(original)
      remove(storageKey)
    },
    markSaved: (value: T) => {
      submitted.current = value
    },
  }
}

/** 有未保存改动时，关闭/刷新浏览器前让用户确认。 */
export function useUnsavedWarning(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])
}
