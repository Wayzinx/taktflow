import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUpRight, MoreHorizontal, OctagonAlert, Plus, RotateCw, Save, Trash2, X } from 'lucide-react'
import type { AgentRoleView, AgentRoleWrite, HarnessSelector, SpaceDetail } from '@taktflow/core'
import { RoleConflictError, useAsync, useSource } from '../../api'
import { AgentMark } from '../../components/agent-mark'
import { ErrorState, Menu, ReasonDialog, Segmented, SkeletonRows, TagInput, ToggleChips, toast } from '../../components/ui'
import { Link } from '../../lib/router'
import { SelectorFields } from './runtime/routing'
import { selectorText } from './runtime/shared'
import './role-form.css'

/**
 * 角色表单（docs/design/30 §3）：把角色档案的 frontmatter 摊成表单，保存只写改过的字段（正文没改就不动）。
 * 优先级：节点里写的 > 角色档案 > 设置里的默认路由 > 内置默认；表单上直接标出现在生效的是哪一层。
 */

const SOURCE: Record<AgentRoleView['effective']['source'], string> = { role: '角色档案', 'space-default': '默认路由', builtin: '内置默认' }
const ORIGIN: Record<AgentRoleView['origin'], string> = { space: '空间档案', plugin: '插件', builtin: '内置' }

interface Draft {
  title: string
  description: string
  /** 档案里自己写 harness；否则跟随默认路由。 */
  own: boolean
  harness: HarnessSelector
  skills: string[]
  /** 不写 knowledge：能读空间绑定的全部知识库。 */
  kbAll: boolean
  knowledge: string[]
  writeScope: string[]
  readScope: string[]
  allowBash: boolean
  instructions: string
}

const draftOf = (v: AgentRoleView): Draft => ({
  title: v.title,
  description: v.description,
  own: !!v.harness,
  harness: structuredClone(v.harness ?? v.effective.harness),
  skills: [...v.skills],
  kbAll: !v.knowledge,
  knowledge: [...(v.knowledge ?? [])],
  writeScope: [...v.writeScope],
  readScope: [...(v.readScope ?? [])],
  allowBash: !!v.allowBash,
  instructions: v.instructions,
})

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const cleanSel = (s: HarnessSelector): HarnessSelector => JSON.parse(JSON.stringify({ ...s, fallback: s.fallback?.length ? s.fallback : undefined }))

const FIELD_LABEL: Record<string, string> = { title: '名字', description: '描述', harness: '用什么跑', skills: '技能', knowledge: '知识库', writeScope: '写范围', readScope: '读范围', allowBash: 'bash', instructions: '说明' }

/** 只带改过的字段；null 表示删掉该字段，回到下一层的默认。 */
function diff(v: AgentRoleView, d: Draft): Omit<AgentRoleWrite, 'reason' | 'baseRevision'> {
  const w: Omit<AgentRoleWrite, 'reason' | 'baseRevision'> = {}
  if (d.title.trim() !== v.title) w.title = d.title.trim()
  if (d.description.trim() !== v.description) w.description = d.description.trim()
  const own = d.own ? cleanSel(d.harness) : undefined
  if (!same(own, v.harness)) w.harness = own ?? null
  if (!same(d.skills, v.skills)) w.skills = d.skills
  const kb = d.kbAll ? undefined : d.knowledge
  if (!same(kb, v.knowledge)) w.knowledge = kb ?? null
  if (!same(d.writeScope, v.writeScope)) w.writeScope = d.writeScope
  const rs = d.readScope.length ? d.readScope : undefined
  if (!same(rs, v.readScope)) w.readScope = rs ?? null
  if (d.allowBash !== !!v.allowBash) w.allowBash = d.allowBash ? true : null
  if (d.instructions !== v.instructions) w.instructions = d.instructions
  return w
}

const globError = (g: string) => (g.startsWith('/') ? '用相对路径（相对空间根目录），不要以 / 开头' : g.includes('..') ? '不能包含 ..' : undefined)

function Sec({ title, hint, children, aside }: { title: string; hint?: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="rf-sec">
      <header className="rf-sec-head">
        <h3>{title}</h3>
        {hint && <p>{hint}</p>}
        {aside}
      </header>
      <div className="rf-sec-body">{children}</div>
    </section>
  )
}

/** harness 表单：跟随默认路由 / 这个角色单独指定（含备选链）。 */
function RunWith({ v, d, set }: { v: AgentRoleView; d: Draft; set: (patch: Partial<Draft>) => void }) {
  const hq = useAsync((ds) => ds.harnesses(), [])
  const cq = useAsync((ds) => ds.runtimeConfig().catch(() => undefined), [])
  const harnesses = hq.data ?? []
  const models = Object.entries(cq.data?.models ?? {})
    .filter(([, m]) => m.kind !== 'embedding')
    .map(([k]) => k)
    .sort()
  const fallback = d.harness.fallback ?? []
  const setSel = (harness: HarnessSelector) => set({ harness })
  const setFallback = (f: HarnessSelector[]) => setSel({ ...d.harness, fallback: f.length ? f : undefined })
  // 跟随默认时显示的是"下一层"：有默认路由就是它，否则内置
  const below = v.effective.source === 'role' ? undefined : v.effective
  const overridden = v.usedBy.filter((u) => u.harness)
  return (
    <>
      <div className="rf-choice" role="radiogroup" aria-label="用什么跑">
        <label className={`rf-radio${!d.own ? ' on' : ''}`}>
          <input type="radio" name="rf-own" checked={!d.own} onChange={() => set({ own: false })} />
          <span>
            <b>跟随默认路由</b>
            <span className="faint">
              {below ? (
                <>
                  现在是 <span className="mono">{selectorText(below.harness)}</span>（{SOURCE[below.source]}）
                </>
              ) : (
                '保存后按设置里"模型与 Harness → 默认路由"选，没配就用内置默认'
              )}
            </span>
          </span>
        </label>
        <label className={`rf-radio${d.own ? ' on' : ''}`}>
          <input type="radio" name="rf-own" checked={d.own} onChange={() => set({ own: true })} />
          <span>
            <b>这个角色单独指定</b>
            <span className="faint">写进角色档案，比默认路由优先</span>
          </span>
        </label>
      </div>
      {d.own && (
        <div className="rf-own">
          <SelectorFields value={d.harness} onChange={(s) => setSel({ ...s, fallback: d.harness.fallback })} harnesses={harnesses} models={models} />
          {fallback.length > 0 && (
            <ol className="rt-fallbacks">
              {fallback.map((f, i) => (
                <li key={i} className="rt-fallback">
                  <ArrowDown aria-hidden className="rt-fallback-arrow" />
                  <SelectorFields compact value={f} onChange={(x) => setFallback(fallback.map((y, j) => (j === i ? x : y)))} harnesses={harnesses} models={models} />
                  <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label={`去掉第 ${i + 1} 个备选`} onClick={() => setFallback(fallback.filter((_, j) => j !== i))}>
                    <X />
                  </button>
                </li>
              ))}
            </ol>
          )}
          <button type="button" className="btn btn-sm btn-ghost rf-add" onClick={() => setFallback([...fallback, { harness: harnesses.find((h) => h.available && h.id !== d.harness.harness)?.id ?? d.harness.harness }])}>
            <Plus aria-hidden /> 加一个备选（主选失败时按顺序换）
          </button>
        </div>
      )}
      {overridden.length > 0 && (
        <p className="rf-note">
          {overridden.length} 个节点自己写了 harness，会覆盖这里：
          {overridden.map((u) => (
            <span key={`${u.workflowId}/${u.nodeId}`} className="mono">
              {' '}
              {u.workflowId}/{u.nodeId}（{selectorText(u.harness!)}）
            </span>
          ))}
        </p>
      )}
    </>
  )
}

export function RoleForm({ role, space, onDirty, onSaved }: { role: string; space: SpaceDetail; onDirty: (dirty: boolean) => void; onSaved: () => void }) {
  const ds = useSource()
  const q = useAsync((d) => d.agentRole(role), [role])
  // 保存返回的就是最新档案：先用它，免得等重新拉取的这段时间里表单还显示"改了…"、能再点一次保存（旧 revision 必然 409）
  const [saved, setSaved] = useState<AgentRoleView>()
  useEffect(() => setSaved(undefined), [q.data])
  const v = saved ?? q.data
  const [d, setD] = useState<Draft>()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState(false)
  useEffect(() => {
    if (v) setD(draftOf(v))
    setReason('')
    setConflict(false)
  }, [v])
  const write = useMemo(() => (v && d ? diff(v, d) : {}), [v, d])
  const changed = Object.keys(write)
  useEffect(() => onDirty(changed.length > 0), [changed.length > 0])
  useEffect(() => () => onDirty(false), [])

  if (q.error && !v) return <ErrorState error={q.error} onRetry={q.reload} />
  if (!v || !d) return <SkeletonRows rows={10} />
  const set = (patch: Partial<Draft>) => setD((x) => (x ? { ...x, ...patch } : x))
  const harnessOk = !d.own || !!d.harness.harness
  const canSave = changed.length > 0 && reason.trim().length >= 2 && harnessOk && !!d.title.trim() && !busy

  async function save() {
    if (!canSave) return
    setBusy(true)
    try {
      setSaved(await ds.saveAgentRole(role, { ...write, baseRevision: v!.revision, reason: reason.trim() }))
      toast(`已保存角色 ${d!.title.trim() || role}`, { body: v!.path ? `写回 ${v!.path}；新开的节点马上用新设置。` : `已在空间里新建 agents/${role}.md；之后以空间档案为准。` })
      q.reload()
      onSaved()
    } catch (e) {
      if (e instanceof RoleConflictError) setConflict(true)
      else toast('没保存成', { tone: 'failed', body: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="rf"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 's') {
          e.preventDefault()
          void save()
        }
      }}
    >
      {v.problems?.length ? (
        <div className="rf-problems" role="alert">
          <OctagonAlert aria-hidden />
          <ul>
            {v.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <Sec title="基本">
        <div className="rf-grid">
          <label className="ov-field">
            <span className="ov-field-label">名字</span>
            <input className="input" value={d.title} onChange={(e) => set({ title: e.target.value })} aria-invalid={!d.title.trim()} />
          </label>
          <label className="ov-field">
            <span className="ov-field-label">一句话描述</span>
            <input className="input" value={d.description} placeholder="例如：在 worktree 里改代码并补单测" onChange={(e) => set({ description: e.target.value })} />
          </label>
        </div>
      </Sec>

      <Sec title="用什么跑" hint="harness、模型、effort 和备选。节点里写了的以节点为准。">
        <RunWith v={v} d={d} set={set} />
      </Sec>

      <Sec title="技能" hint="提示词里告诉它用哪些技能；技能文件本身对所有角色都可读。">
        {space.skills.length ? <ToggleChips ariaLabel="技能" mono options={space.skills.map((s) => ({ id: s.name, label: s.name, title: s.description }))} value={d.skills} onChange={(skills) => set({ skills })} /> : <p className="faint rf-empty">空间里还没有技能，先去"技能"里建一个。</p>}
      </Sec>

      <Sec title="知识库" hint="节点里指定了知识库时以节点为准。">
        <div className="rf-choice" role="radiogroup" aria-label="知识库范围">
          <label className={`rf-radio${d.kbAll ? ' on' : ''}`}>
            <input type="radio" name="rf-kb" checked={d.kbAll} onChange={() => set({ kbAll: true })} />
            <span>
              <b>空间绑定的全部</b>
              <span className="faint">{space.knowledge.length} 个，以后新绑定的也能读</span>
            </span>
          </label>
          <label className={`rf-radio${!d.kbAll ? ' on' : ''}`}>
            <input type="radio" name="rf-kb" checked={!d.kbAll} onChange={() => set({ kbAll: false })} />
            <span>
              <b>只用选中的</b>
              <span className="faint">少给无关的知识库，检索更准、更省 token</span>
            </span>
          </label>
        </div>
        {!d.kbAll && <ToggleChips ariaLabel="知识库" mono options={space.knowledge.map((k) => ({ id: k.id, label: k.id, title: k.description }))} value={d.knowledge} onChange={(knowledge) => set({ knowledge })} />}
      </Sec>

      <Sec title="权限" hint="相对空间根目录的 glob。节点上的写范围只能收窄，不能放宽。">
        <div className="rf-grid">
          <label className="ov-field rf-wide">
            <span className="ov-field-label">写范围</span>
            <TagInput ariaLabel="写范围" mono value={d.writeScope} onChange={(writeScope) => set({ writeScope })} placeholder="src/**（回车添加）" validate={globError} />
          </label>
          <label className="ov-field rf-wide">
            <span className="ov-field-label">
              读范围<span className="ov-field-hint">不填就是不限</span>
            </span>
            <TagInput ariaLabel="读范围" mono value={d.readScope} onChange={(readScope) => set({ readScope })} placeholder="不限" validate={globError} />
          </label>
          <label className="rf-check">
            <input type="checkbox" checked={d.allowBash} onChange={(e) => set({ allowBash: e.target.checked })} />
            <span>
              允许执行 bash<span className="faint">只对内置 harness 生效；外部 harness 按它自己的权限设置</span>
            </span>
          </label>
        </div>
      </Sec>

      <Sec title="说明" hint="追加到系统提示的角色说明（Markdown）。">
        <textarea className="textarea rf-instructions" spellCheck={false} aria-label="角色说明" value={d.instructions} onChange={(e) => set({ instructions: e.target.value })} />
      </Sec>

      <Sec title="谁在用" hint="用到这个角色的流水线节点。">
        {v.usedBy.length ? (
          <ul className="rf-used">
            {v.usedBy.map((u) => (
              <li key={`${u.workflowId}/${u.nodeId}`}>
                <Link to={`/workflows/${encodeURIComponent(u.workflowId)}?node=${encodeURIComponent(u.nodeId)}`} className="rf-used-link pressable">
                  <span className="truncate">{u.workflowTitle ?? u.workflowId}</span>
                  <span className="mono faint">{u.nodeId}</span>
                  {u.harness && <span className="chip mono" title="节点自己写了 harness，会覆盖角色">{selectorText(u.harness)}</span>}
                  <ArrowUpRight aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="faint rf-empty">还没有流水线节点用它。</p>
        )}
      </Sec>

      <footer className={`rf-save${changed.length ? ' dirty' : ''}`}>
        {conflict ? (
          <span className="rf-conflict" role="alert">
            角色档案已被其他人修改。
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => (setSaved(undefined), q.reload())}>
              <RotateCw aria-hidden /> 重新载入（放弃我的修改）
            </button>
          </span>
        ) : (
          <span className="rf-changed">{changed.length ? `改了：${changed.map((k) => FIELD_LABEL[k] ?? k).join('、')}` : '没有修改'}</span>
        )}
        <input className="input rf-reason" placeholder={changed.length ? '修改原因（必填，进修订记录）' : '修改后填写原因'} value={reason} onChange={(e) => setReason(e.target.value)} disabled={!changed.length} aria-label="修改原因" aria-required />
        <button type="button" className="btn" onClick={() => setD(draftOf(v))} disabled={!changed.length || busy}>
          还原
        </button>
        <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={!canSave} title="⌘S / Ctrl+S">
          <Save aria-hidden />
          {busy ? '保存中…' : '保存'}
        </button>
      </footer>
    </div>
  )
}

/** 角色详情的头部：形象、来源、表单 / 源码切换、删除。 */
export function RoleHead({ role, title, origin, path, mode, onMode, onDeleted }: { role: string; title: string; origin?: AgentRoleView['origin']; path?: string; mode: 'form' | 'source'; onMode: (m: 'form' | 'source') => void; onDeleted: () => void }) {
  const ds = useSource()
  const more = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState(false)
  const [removing, setRemoving] = useState(false)
  return (
    <header className="rf-head">
      <AgentMark state="idle" role={role} size={40} />
      <span className="rf-head-title">
        <b className="truncate">{title}</b>
        <span className="faint mono truncate">
          {role}
          {origin && <> · {path ?? ORIGIN[origin]}</>}
        </span>
      </span>
      <span className="spacer" />
      <Segmented<'form' | 'source'>
        size="sm"
        ariaLabel="表单 / 源码"
        value={mode}
        onChange={onMode}
        options={[
          { value: 'form', label: '表单' },
          { value: 'source', label: '源码' },
        ]}
      />
      {origin === 'space' && (
        <>
          <button ref={more} type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={`${title} 的更多操作`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(true)}>
            <MoreHorizontal />
          </button>
          <Menu open={menu} onClose={() => setMenu(false)} anchor={more} placement="bottom-end" items={[{ id: 'delete', label: '删除角色', icon: Trash2, danger: true, onSelect: () => setRemoving(true) }]} />
          <ReasonDialog
            open={removing}
            onClose={() => setRemoving(false)}
            risk="dangerous"
            title={`删除角色 ${title}`}
            description={`删除 ${path ?? `agents/${role}.md`}。还有流水线节点用它时删不了，会列出是哪些节点。`}
            confirmLabel="删除"
            onSubmit={async (reason) => {
              await ds.deleteAgentRole(role, reason)
              toast(`已删除角色 ${title}`)
              onDeleted()
            }}
          />
        </>
      )}
    </header>
  )
}
