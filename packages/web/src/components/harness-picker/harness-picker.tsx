import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronDown, ChevronRight, Search, Settings2 } from 'lucide-react'
import { BrandIcon } from '../brand/brand-icon'
import { Link } from '../../lib/router'
import { Popover, SkeletonRows } from '../ui'
import { sameModel, type Effort, type PickerHarness, type PickerModel, type PickerValue } from './types'
import './harness-picker.css'

export { sameModel, type Effort, type PickerGroup, type PickerHarness, type PickerModel, type PickerValue } from './types'

const EFFORT_LABEL: Record<Effort, string> = { low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高' }
const same = (h: string, m: PickerModel, v?: PickerValue | null) => !!v && v.harness === h && sameModel(m, v)

/** 按钮上的短名：图标 + harness · 模型，推理强度单独一段（名字长了只截名字，强度总看得见）。 */
function triggerText(harnesses: PickerHarness[], v?: PickerValue | null): { icon?: string; name: string; label: string; effort?: string; text: string } | undefined {
  if (!v) return undefined
  const h = harnesses.find((x) => x.id === v.harness)
  const m = h?.groups.flatMap((g) => g.models).find((x) => same(v.harness, x, v))
  const name = h?.name ?? v.harness
  const model = m ? (m.model ? m.label : undefined) : v.model
  // 没单独选档时写这个模型的默认档；模型也没说默认档就写「默认」，让人知道强度可以选
  const level = v.effort ?? (m?.efforts?.length ? m.defaultEffort : undefined)
  const effort = level ? EFFORT_LABEL[level] : m?.efforts?.length ? '默认' : undefined
  const label = [name, model].filter(Boolean).join(' · ')
  return { icon: h?.icon, name, label, effort, text: [label, effort && `思考 ${effort}`].filter(Boolean).join(' · ') }
}

/**
 * Harness × 模型两级选择器（docs/design/32 §6）：左栏 harness，右栏该 harness 能用的模型（自带 + 各 provider），选中的模型支持 effort 时再选档。
 * value 为空表示跟随默认；defaultLabel 写默认是什么。
 */
export function HarnessPicker({
  harnesses,
  value,
  onChange,
  defaultLabel,
  defaultValue,
  allowDefault = true,
  manageHref,
  placement = 'top-start',
  loading,
  className,
  ariaLabel = 'harness 与模型',
  hideEffort,
  disabled,
}: {
  harnesses: PickerHarness[]
  value?: PickerValue | null
  onChange: (next: PickerValue | null) => void
  defaultLabel?: string
  /** 跟随默认时实际用的组合：按钮上画它的图标 */
  defaultValue?: PickerValue
  allowDefault?: boolean
  manageHref?: string
  placement?: 'top-start' | 'bottom-start'
  loading?: boolean
  className?: string
  ariaLabel?: string
  /** 旁边另有强度下拉（设置里的路由）时，按钮上不再重复写强度 */
  hideEffort?: boolean
  disabled?: boolean
}) {
  const btn = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [showDown, setShowDown] = useState(false)
  const [active, setActive] = useState<string>()
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState<{ harness: string; model: PickerModel }>()
  const list = useRef<HTMLDivElement>(null)
  const models = useRef<HTMLDivElement>(null)

  const up = harnesses.filter((h) => h.available)
  const down = harnesses.filter((h) => !h.available)
  const shown = showDown ? [...up, ...down] : up
  const current = triggerText(harnesses, value)
  const fallback = value ? undefined : triggerText(harnesses, defaultValue)
  const activeH = harnesses.find((h) => h.id === active) ?? harnesses.find((h) => h.id === value?.harness) ?? up[0]

  // 打开时停在当前选中的 harness 上；选中的模型能调推理强度时直接展开档位，不用再点一次模型
  useEffect(() => {
    if (!open) return
    setActive(value?.harness ?? up[0]?.id)
    setQuery('')
    const h = harnesses.find((x) => x.id === value?.harness)
    const m = h?.groups.flatMap((g) => g.models).find((x) => same(h.id, x, value))
    setPending(h && m?.efforts?.length ? { harness: h.id, model: m } : undefined)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // 网关常列几十个模型：已选 / 正在选档的那个连同档位行滚进视野
  useEffect(() => {
    if (!open) return
    const id = requestAnimationFrame(() => models.current?.querySelector('.hp-model.is-pending, .hp-model.is-on')?.closest('.hp-model-wrap')?.scrollIntoView({ block: 'nearest' }))
    return () => cancelAnimationFrame(id)
  }, [open, pending])

  const groups = useMemo(() => {
    if (!activeH) return []
    const q = query.trim().toLowerCase()
    return activeH.groups
      .map((g) => ({ ...g, models: q ? g.models.filter((m) => `${m.label} ${m.model ?? ''} ${m.aliases?.join(' ') ?? ''} ${g.label}`.toLowerCase().includes(q)) : g.models }))
      .filter((g) => g.models.length)
  }, [activeH, query])
  const total = activeH?.groups.reduce((n, g) => n + g.models.length, 0) ?? 0

  const commit = (h: PickerHarness, m: PickerModel, effort?: Effort) => {
    onChange({ harness: h.id, provider: m.provider, model: m.model, effort })
    setOpen(false)
  }
  const pick = (h: PickerHarness, m: PickerModel, effort?: Effort) => {
    if (!m.available || !h.available) return
    // 支持 effort 的先停在面板上选档；不支持的直接选中
    if (m.efforts?.length && !effort) {
      setPending({ harness: h.id, model: m })
      return
    }
    commit(h, m, effort)
  }

  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const ids = shown.map((h) => h.id)
    const i = ids.indexOf(activeH?.id ?? '')
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = ids[(i + (e.key === 'ArrowDown' ? 1 : ids.length - 1)) % ids.length]
      setActive(next)
      list.current?.querySelector<HTMLButtonElement>(`[data-harness="${next}"]`)?.focus()
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      list.current?.parentElement?.querySelector<HTMLButtonElement>('.hp-model:not(:disabled)')?.focus()
    }
  }

  const effortFor = pending && same(pending.harness, pending.model, value) ? value?.effort : undefined

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={['btn btn-ghost btn-sm hp-trigger', className].filter(Boolean).join(' ')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${ariaLabel}：${current?.text ?? defaultLabel ?? '默认'}${value ? '' : '（默认）'}`}
        title={`换${ariaLabel}`}
        disabled={disabled || (loading && !harnesses.length)}
        onClick={() => setOpen(true)}
      >
        <BrandIcon k={(current ?? fallback)?.icon} label={(current ?? fallback)?.name ?? defaultLabel ?? '默认'} size={14} />
        <span className="truncate">{current?.label ?? defaultLabel ?? '默认'}</span>
        {current?.effort && !hideEffort && (
          <span className="hp-trigger-effort" title="推理强度">
            思考 {current.effort}
          </span>
        )}
        <ChevronDown className="hp-chev" aria-hidden />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={btn} placement={placement} className="hp-pop" role="dialog" ariaLabel={`选择${ariaLabel}`}>
        <div className="hp">
          <div className="hp-side" ref={list} onKeyDown={onListKey}>
            <div className="hp-head">选择 harness</div>
            {allowDefault && (
              <button type="button" className={`hp-harness hp-default${value ? '' : ' is-on'}`} onClick={() => { onChange(null); setOpen(false) }}>
                <span className="hp-h-main">
                  <b>跟随默认</b>
                  <span className="hp-sub truncate">{defaultLabel ?? '按空间配置'}</span>
                </span>
                {!value && <Check className="hp-check" aria-hidden />}
              </button>
            )}
            <div className="hp-hlist" role="listbox" aria-label="harness">
              {loading && up.length === 0 && <SkeletonRows rows={3} gap={10} />}
              {shown.map((h) => {
                const on = h.id === activeH?.id
                const chosen = value?.harness === h.id
                return (
                  <button
                    key={h.id}
                    type="button"
                    role="option"
                    aria-selected={on}
                    data-harness={h.id}
                    className={`hp-harness${on ? ' is-active' : ''}${h.available ? '' : ' is-down'}`}
                    onMouseEnter={() => setActive(h.id)}
                    onFocus={() => setActive(h.id)}
                    onClick={() => setActive(h.id)}
                  >
                    <BrandIcon k={h.icon} label={h.name} size={20} />
                    <span className="hp-h-main">
                      <span className="hp-h-title">
                        <b className="truncate">{h.name}</b>
                        {h.badge && <span className="hp-badge">{h.badge}</span>}
                      </span>
                      <span className="hp-sub truncate" title={h.available ? undefined : h.reason}>
                        {h.available ? (chosen && current ? current.text.slice(h.name.length + 3) || h.own : h.own) ?? '接入的 LLM API' : h.reason ?? '不可用'}
                      </span>
                    </span>
                    {chosen ? <Check className="hp-check" aria-hidden /> : <ChevronRight className="hp-go" aria-hidden />}
                  </button>
                )
              })}
            </div>
            <div className="hp-foot">
              {down.length > 0 && (
                <button type="button" className="hp-link" onClick={() => setShowDown((x) => !x)}>
                  {showDown ? '收起不可用' : `显示不可用（${down.length}）`}
                </button>
              )}
              {manageHref && (
                <Link to={manageHref} className="hp-link" onClick={() => setOpen(false)}>
                  <Settings2 aria-hidden />
                  管理
                </Link>
              )}
            </div>
          </div>

          <div className="hp-main" aria-label={activeH ? `${activeH.name} 的模型` : undefined}>
            {activeH ? (
              <>
                <div className="hp-head">
                  <BrandIcon k={activeH.icon} label={activeH.name} size={14} />
                  {activeH.name} · 选模型
                </div>
                {total > 12 && (
                  <label className="hp-search">
                    <Search aria-hidden />
                    <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索模型" aria-label="搜索模型" />
                  </label>
                )}
                <div className="hp-models" ref={models}>
                  {!activeH.available && <p className="hp-empty">{activeH.reason ?? '这个 harness 现在不可用'}</p>}
                  {activeH.available && groups.length === 0 && <p className="hp-empty">{query ? '没有匹配的模型' : '没有能搭配的模型：去设置里接入一个 LLM API'}</p>}
                  {groups.map((g) => (
                    <section key={g.key} className="hp-group">
                      <div className="hp-group-head">
                        {g.icon && <BrandIcon k={g.icon} label={g.label} size={12} />}
                        <span className="truncate">{g.label}</span>
                        {g.note && <span className="hp-note">{g.note}</span>}
                      </div>
                      {g.hint && <p className="hp-group-hint">{g.hint}</p>}
                      {g.models.map((m) => {
                        const chosen = same(activeH.id, m, value)
                        const isPending = pending?.harness === activeH.id && pending.model.key === m.key && pending.model.provider === m.provider
                        return (
                          <div key={m.key} className="hp-model-wrap">
                            <button
                              type="button"
                              className={`hp-model${chosen ? ' is-on' : ''}${isPending ? ' is-pending' : ''}${m.info ? ' is-info' : ''}`}
                              disabled={!m.available || !activeH.available || m.info}
                              title={m.available ? m.model : m.reason}
                              onClick={() => pick(activeH, m)}
                            >
                              <span className="hp-m-main">
                                <span className="truncate">{m.label}</span>
                                {m.detail && <span className="hp-sub mono truncate">{m.detail}</span>}
                                {!m.available && m.reason && <span className="hp-sub truncate">{m.reason}</span>}
                              </span>
                              {m.tags?.map((t) => (
                                <span key={t} className="hp-tag">{t}</span>
                              ))}
                              {chosen && <Check className="hp-check" aria-hidden />}
                            </button>
                            {isPending && m.efforts && (
                              <div className="hp-efforts" role="group" aria-label="推理强度" title="强度越高想得越久，回复越慢；日常问答用低或中就够">
                                <span className="hp-sub">推理强度</span>
                                {m.effortGuess && (
                                  <button type="button" className={`hp-effort${effortFor ? '' : ' is-on'}`} onClick={() => commit(activeH, m)}>
                                    默认
                                  </button>
                                )}
                                {/* 已经选了目录里没列的档（手写进配置、或是猜的档位外）：也列出来，不然看不出当前是哪档 */}
                                {(effortFor && !m.efforts.includes(effortFor) ? [...m.efforts, effortFor] : m.efforts).map((e) => (
                                  <button key={e} type="button" className={`hp-effort${(effortFor ?? m.defaultEffort) === e ? ' is-on' : ''}`} onClick={() => pick(activeH, m, e)}>
                                    {EFFORT_LABEL[e]}
                                    <span className="mono">{e}</span>
                                  </button>
                                ))}
                                {m.effortGuess && <p className="hp-effort-note">这个模型没写明支持哪些档。不确定就选默认；模型不支持时指定的档可能被忽略或报错</p>}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </section>
                  ))}
                </div>
              </>
            ) : (
              loading ? <SkeletonRows rows={3} gap={10} icon={false} /> : <p className="hp-empty">没有可用的 harness</p>
            )}
          </div>
        </div>
      </Popover>
    </>
  )
}
