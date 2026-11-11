import { useMemo, useState } from 'react'
import { useAsync } from '../../../api'
import { Link } from '../../../lib/router'
import { ArrowDown, Crown, GraduationCap, Pencil, Plus, Signpost, Trash2, X, type LucideIcon } from 'lucide-react'
import type { HarnessInfo, HarnessSelector, RuntimeSystemRole } from '@taktflow/core'
import { EmptyState, ReasonDialog, Segmented, toast, useFlashRows, useStagger } from '../../../components/ui'
import { EditorDrawer, EFFORTS, Field, selectorText, type RuntimeApi } from './shared'
import { BeeGlyph } from '../../../components/identity'
import { PairingPath } from './pairing-matrix'
import { HarnessPicker } from '../../../components/harness-picker/harness-picker'
import { useRuntimeCatalog } from '../../../components/harness-picker/use-catalog'
import { catalogPending, catalogToPicker, findPicked } from '../../../lib/catalog-picker'
import { harnessMeta } from '../../../lib/harness-meta'

const SYSTEM: Array<{ id: RuntimeSystemRole; label: string; hint: string; icon: LucideIcon }> = [
  { id: 'lead', label: 'Lead', hint: '需求群里接话、拆任务、派活', icon: Crown },
  { id: 'route', label: '路由判档', hint: '新需求进来时判断走哪一档流程', icon: Signpost },
  { id: 'steward', label: '管家', hint: '空间管家：查数据、起草改动、转达', icon: BeeGlyph },
  { id: 'learner', label: '经验提炼', hint: '运行结束后提炼经验条目', icon: GraduationCap },
]

type Target = { kind: 'role'; id: string; isNew?: boolean } | { kind: 'system'; id: RuntimeSystemRole }

/**
 * harness × 模型 × effort 选择器；备选、角色档案也用它（docs/design/31 §6、32 §6）。
 * 模型来自模型目录：harness 自带的 + 各 provider 实时列出的；下面一行写这个组合怎么接（直连 / 桥接）或为什么搭不上。
 * 目录里没有的模型 ID 可以手填。
 */
export function SelectorFields({ value, onChange, harnesses, compact }: { value: HarnessSelector; onChange: (v: HarnessSelector) => void; harnesses: HarnessInfo[]; models?: string[]; compact?: boolean }) {
  const h = harnesses.find((x) => x.id === value.harness)
  const cq = useRuntimeCatalog()
  const picker = useMemo(() => (cq.data ? catalogToPicker(cq.data, { keep: [value.harness] }) : []), [cq.data, value.harness])
  const picked = value.model ? findPicked(picker, value) : undefined
  // 目录拉到了、当前模型又不在里面：直接显示手填框
  const [typingState, setTyping] = useState<boolean>()
  const typing = typingState ?? Boolean(cq.data && value.model && !picked)
  const aliasProvider = cq.data?.providers.find((p) => p.models.models.some((m) => m.alias === value.model))?.id
  const provider = value.provider ?? aliasProvider ?? null
  const cur = cq.data?.pairings.find((p) => p.harness === value.harness && p.provider === (value.model && !picked && !value.provider ? null : provider))
  const efforts = picked?.efforts ?? EFFORTS
  return (
    <div className={`rt-sel-wrap${compact ? ' compact' : ''}`}>
      <div className={`rt-sel${compact ? ' compact' : ''}`}>
        <HarnessPicker
          harnesses={picker}
          value={{ harness: value.harness, model: value.model, provider: value.provider, effort: value.effort }}
          onChange={(next) => {
            if (!next) return
            setTyping(false)
            onChange({ ...value, harness: next.harness, model: next.model, provider: next.provider, effort: next.effort ?? value.effort })
          }}
          allowDefault={false}
          placement="bottom-start"
          loading={(cq.loading && !cq.data) || catalogPending(cq.data)}
          className="rt-sel-picker"
          ariaLabel="harness 与模型"
          hideEffort
        />
        {typing && (
          <span className="rt-sel-typed">
            <input className="input mono" aria-label="模型 ID" value={value.model ?? ''} placeholder="厂商模型 ID，留空用默认" autoFocus={!compact && typingState} onChange={(e) => onChange({ ...value, model: e.target.value.trim() || undefined, provider: undefined })} />
          </span>
        )}
        <select className="select mono" aria-label="effort" value={value.effort ?? ''} onChange={(e) => onChange({ ...value, effort: (e.target.value || undefined) as HarnessSelector['effort'] })}>
          <option value="">effort 默认</option>
          {efforts.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-sm btn-ghost rt-sel-type" onClick={() => setTyping(!typing)}>
          {typing ? '收起' : '手填 ID'}
        </button>
      </div>
      {cq.error && <div className="rt-sel-pair is-unavailable">模型目录取不到：{cq.error.message}</div>}
      {cur && h && (
        <div className={`rt-sel-pair is-${cur.status}`}>
          {cur.status === 'unavailable' ? (
            <span>搭不上：{cur.reason}</span>
          ) : (
            <PairingPath p={cur} harness={harnessMeta(h).name} />
          )}
        </div>
      )}
    </div>
  )
}

function RouteDrawer({ rt, harnesses, target, open, onClose }: { rt: RuntimeApi; harnesses: HarnessInfo[]; target?: Target; open: boolean; onClose: () => void }) {
  const cfg = rt.cfg!
  const init = (): { role: string; sel: HarnessSelector } => {
    const cur = target?.kind === 'role' ? cfg.roles[target.id] : target?.kind === 'system' ? cfg.system[target.id] : undefined
    return { role: target?.kind === 'role' && !target.isNew ? target.id : '', sel: structuredClone(cur ?? { harness: harnesses.find((h) => h.available && !h.override?.disabled)?.id ?? 'native' }) }
  }
  const [d, setD] = useState(init)
  const [openKey, setOpenKey] = useState(open)
  if (open !== openKey) {
    setOpenKey(open)
    if (open) setD(init())
  }
  const models = Object.keys(cfg.models).filter((m) => cfg.models[m]!.kind !== 'embedding').sort()
  const isNew = target?.kind === 'role' && target.isNew
  const roleBad = isNew && (!/^[a-z][a-z0-9-]*$/.test(d.role) || Boolean(cfg.roles[d.role]))
  const sys = target?.kind === 'system' ? SYSTEM.find((s) => s.id === target.id) : undefined
  const fallback = d.sel.fallback ?? []
  const setFallback = (f: HarnessSelector[]) => setD((x) => ({ ...x, sel: { ...x.sel, fallback: f.length ? f : undefined } }))
  const picked = harnesses.find((h) => h.id === d.sel.harness)

  const save = async (reason: string) => {
    if (target?.kind === 'system') await rt.patch({ system: { [target.id]: d.sel } }, reason)
    else await rt.patch({ roles: { [d.role]: d.sel } }, reason)
    toast(`${sys ? sys.label : `角色 ${d.role}`} 的${sys ? '路由' : '默认路由'}已更新`, { body: '新开的节点马上用新路由；正在跑的节点不受影响。' })
  }

  return (
    <EditorDrawer
      open={open}
      onClose={onClose}
      title={sys ? `系统角色：${sys.label}` : isNew ? '添加默认路由' : `默认路由：${d.role}`}
      description={sys ? sys.hint : '角色档案里没写 harness 时，这个角色的节点用哪个 harness、哪个模型。优先级：节点 > 角色档案 > 默认路由 > 内置默认。'}
      canSave={Boolean(d.sel.harness) && !roleBad && (!isNew || Boolean(d.role))}
      onSave={save}
      onReload={rt.reload}
      width={520}
    >
      {isNew && (
        <Field label="角色" req hint="和角色档案的 role 对上">
          <input className={`input mono${roleBad && d.role ? ' is-bad' : ''}`} value={d.role} placeholder="dev" onChange={(e) => setD((x) => ({ ...x, role: e.target.value.trim() }))} />
          {roleBad && d.role && <span className="rt-field-err">{cfg.roles[d.role] ? `已经有 ${d.role} 的路由了：直接编辑它` : '小写字母开头，只能用小写字母、数字和 -'}</span>}
        </Field>
      )}
      <Field label="用什么跑" req hint="harness · 模型 · effort">
        <SelectorFields value={d.sel} onChange={(sel) => setD((x) => ({ ...x, sel: { ...sel, fallback: x.sel.fallback } }))} harnesses={harnesses} models={models} />
        {picked && !picked.available && <span className="rt-field-err">{picked.id} 现在不可用：{picked.reason ?? '探测没通过'}。可以先存，等它可用后生效；建议配一个备选。</span>}
      </Field>
      <Field label="备选" hint="主选失败（不可用、超限、报错）时按顺序换">
        <ol className="rt-fallbacks">
          {fallback.map((f, i) => (
            <li key={i} className="rt-fallback">
              <ArrowDown aria-hidden className="rt-fallback-arrow" />
              <SelectorFields compact value={f} onChange={(v) => setFallback(fallback.map((x, j) => (j === i ? v : x)))} harnesses={harnesses} models={models} />
              <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label={`去掉第 ${i + 1} 个备选`} onClick={() => setFallback(fallback.filter((_, j) => j !== i))}>
                <X />
              </button>
            </li>
          ))}
        </ol>
        <button type="button" className="btn btn-sm btn-ghost rt-add-fallback" onClick={() => setFallback([...fallback, { harness: harnesses.find((h) => h.available && h.id !== d.sel.harness && !h.override?.disabled)?.id ?? d.sel.harness }])}>
          <Plus aria-hidden /> 加一个备选
        </button>
      </Field>
    </EditorDrawer>
  )
}

function SelChips({ s, harnesses }: { s?: HarnessSelector; harnesses: HarnessInfo[] }) {
  if (!s) return <span className="faint">没设 · 用空间缺省</span>
  const h = harnesses.find((x) => x.id === s.harness)
  const down = !h || !h.available
  return (
    <span className="rt-selchips">
      <span className={`rt-h mono${down ? ' down' : ''}`} title={down ? (h?.reason ?? `harness ${s.harness} 不存在`) : undefined}>
        {s.harness}
      </span>
      {s.model && <span className="mono rt-m">{s.model}</span>}
      {s.effort && <span className="chip mono">{s.effort}</span>}
      {s.fallback?.length ? (
        <span className="rt-fb faint" title={s.fallback.map((f) => [f.harness, f.model].filter(Boolean).join(' · ')).join(' → ')}>
          备选 {s.fallback.length}
        </span>
      ) : null}
    </span>
  )
}

/** 默认路由（角色档案没写 harness 时用）+ 系统角色：一行一个，点编辑开抽屉。 */
export function RoutingCard({ rt, harnesses }: { rt: RuntimeApi; harnesses: HarnessInfo[] }) {
  const cfg = rt.cfg!
  const [view, setView] = useState<'roles' | 'system'>('roles')
  const [drawer, setDrawer] = useState<{ open: boolean; target?: Target }>({ open: false })
  const [removing, setRemoving] = useState<string>()
  const roles = useMemo(() => Object.entries(cfg.roles).sort(([a], [b]) => a.localeCompare(b)), [cfg.roles])
  // 角色档案自己写了 harness 的，默认路由对它不生效（docs/design/30 §3）
  const profiles = useAsync((d) => d.agentRoles().catch(() => []), [])
  const pinned = useMemo(() => new Map((profiles.data ?? []).filter((p) => p.harness).map((p) => [p.role, p.harness!] as const)), [profiles.data])
  const flash = useFlashRows(roles.map(([r]) => r))
  const st = useStagger(roles.length)
  const open = (target: Target) => setDrawer({ open: true, target })

  return (
    <div className="card rt-card">
      <div className="card-head">
        <span className="card-title">路由</span>
        <Segmented<'roles' | 'system'>
          value={view}
          onChange={setView}
          size="sm"
          ariaLabel="默认路由 / 系统角色"
          options={[
            { value: 'roles', label: '默认路由', count: roles.length || undefined },
            { value: 'system', label: '系统角色' },
          ]}
        />
        <span className="spacer" />
        {view === 'roles' && (
          <button type="button" className="btn btn-sm" onClick={() => open({ kind: 'role', id: '', isNew: true })}>
            <Plus aria-hidden /> 添加默认路由
          </button>
        )}
      </div>
      {view === 'roles' ? (
        roles.length === 0 ? (
          <EmptyState compact title="还没有默认路由" body="给 dev、reviewer 这样的角色指定默认 harness 和模型；角色档案里写了的以档案为准。" action={<button type="button" className="btn btn-sm btn-primary" onClick={() => open({ kind: 'role', id: '', isNew: true })}>添加默认路由</button>} />
        ) : (
          <ul className="rt-rows" aria-label="默认路由">
            {roles.map(([role, s], i) => {
              const sx = st(i)
              return (
                <li key={role} className={`rt-row rt-route ${flash(role)} ${sx.className ?? ''}`} style={sx.style}>
                  <div className="rt-row-main">
                    <span className="mono rt-id">{role}</span>
                    <SelChips s={s} harnesses={harnesses} />
                    {pinned.has(role) && (
                      <Link to={`/settings?tab=agents&name=${encodeURIComponent(role)}`} className="rt-override" title={`角色档案里写了 ${selectorText(pinned.get(role)!)}，这一行对它不生效`}>
                        被角色档案覆盖
                      </Link>
                    )}
                    <span className="rt-row-acts">
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => open({ kind: 'role', id: role })}>
                        <Pencil aria-hidden /> 编辑
                      </button>
                      <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label={`删除 ${role} 的默认路由`} onClick={() => setRemoving(role)}>
                        <Trash2 />
                      </button>
                    </span>
                  </div>
                </li>
              )
            })}
          </ul>
        )
      ) : (
        <ul className="rt-rows" aria-label="系统角色">
          {SYSTEM.map(({ id, label, hint, icon: Icon }) => (
            <li key={id} className="rt-row rt-route">
              <div className="rt-row-main">
                <span className="rt-sys">
                  <Icon aria-hidden />
                  <span>
                    <b>{label}</b>
                    <span className="faint">{hint}</span>
                  </span>
                </span>
                <SelChips s={cfg.system[id]} harnesses={harnesses} />
                <span className="rt-row-acts">
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => open({ kind: 'system', id })}>
                    <Pencil aria-hidden /> 编辑
                  </button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <RouteDrawer rt={rt} harnesses={harnesses} target={drawer.target} open={drawer.open} onClose={() => setDrawer((x) => ({ ...x, open: false }))} />
      <ReasonDialog
        open={Boolean(removing)}
        onClose={() => setRemoving(undefined)}
        risk="dangerous"
        title={`删除角色 ${removing ?? ''} 的默认路由`}
        description="删除后这个角色用角色档案里写的 harness，没写就用内置默认。"
        confirmLabel="删除"
        onSubmit={async (reason) => {
          await rt.patch({ roles: { [removing!]: null } }, reason)
          toast(`已删除角色 ${removing} 的默认路由`)
        }}
      />
    </div>
  )
}
