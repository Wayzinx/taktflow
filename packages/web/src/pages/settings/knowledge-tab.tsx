import { useState, type CSSProperties } from 'react'
import type { KnowledgeBaseSummary, KnowledgeBinding, KnowledgeIntent, SpaceDetail } from '@taktflow/core'
import { ArrowDown, ArrowUp, BookOpen, ChevronRight, Plus } from 'lucide-react'
import { useAsync, useSource } from '../../api'
import { EmptyState, ErrorState, SkeletonRows, StatusBadge, toast, useFlashRows, useStagger } from '../../components/ui'
import { Link } from '../../lib/router'
import { KindGlyph } from '../knowledge/card'
import { INTENTS, kbStatusMeta, kindMeta } from '../knowledge/meta'
import { MigrateCard } from '../knowledge/migrate-card'
import '../knowledge/knowledge.css'

const reason = (what: string) => `在空间设置里${what}`

/** 一行绑定：启用、优先级、intents（覆盖知识库自己的）、角色；链到详情页。 */
function BindingRow({ b, base, roles, first, last, onPatch, onMove, className, style }: { b: KnowledgeBinding; base?: KnowledgeBaseSummary; roles: string[]; first: boolean; last: boolean; onPatch: (p: Partial<KnowledgeBinding>, what: string) => void; onMove: (d: -1 | 1) => void; className?: string; style?: CSSProperties }) {
  const name = base?.name ?? b.baseId
  const intents = b.intents ?? base?.intents ?? []
  const toggleIntent = (i: KnowledgeIntent) => {
    const next = intents.includes(i) ? intents.filter((x) => x !== i) : [...intents, i]
    onPatch({ intents: next.length ? next : undefined }, `调整 ${name} 回答的问题`)
  }
  const toggleRole = (r: string) => {
    const cur = b.roles ?? []
    const next = cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r]
    onPatch({ roles: next.length ? next : undefined }, next.length ? `只允许 ${next.join('、')} 使用 ${name}` : `${name} 对所有角色开放`)
  }
  return (
    <li className={`kb-binding${b.enabled ? '' : ' off'} ${className ?? ''}`} style={style}>
      <div className="kb-binding-order">
        <button type="button" className="btn btn-ghost btn-icon btn-sm" disabled={first} aria-label={`提高 ${name} 的优先级`} onClick={() => onMove(-1)}>
          <ArrowUp />
        </button>
        <span className="num faint">{b.priority}</span>
        <button type="button" className="btn btn-ghost btn-icon btn-sm" disabled={last} aria-label={`降低 ${name} 的优先级`} onClick={() => onMove(1)}>
          <ArrowDown />
        </button>
      </div>
      <KindGlyph kind={base?.kind ?? ''} size={32} />
      <div className="kb-binding-main">
        <div className="kb-binding-title">
          <Link to={`/knowledge/${b.baseId}`} className="kb-binding-name">
            {name}
          </Link>
          <span className="faint">{base ? kindMeta(base.kind).label : b.baseId}</span>
          {base && <StatusBadge subtle meta={kbStatusMeta(base)} />}
          {base && !base.version && <span className="kb-tag" data-tone="waiting">未发布，运行时用不到</span>}
        </div>
        <div className="kb-binding-opts">
          <span className="faint kb-binding-k">回答</span>
          <div className="kb-intent-toggles" role="group" aria-label={`${name} 回答的问题`}>
            {INTENTS.map((i) => (
              <button key={i.id} type="button" className={`kb-toggle sm pressable${intents.includes(i.id) ? ' on' : ''}`} aria-pressed={intents.includes(i.id)} title={i.hint} onClick={() => toggleIntent(i.id)}>
                {i.label}
              </button>
            ))}
          </div>
        </div>
        {roles.length > 0 && (
          <div className="kb-binding-opts">
            <span className="faint kb-binding-k">角色</span>
            <div className="kb-intent-toggles" role="group" aria-label={`能用 ${name} 的角色`}>
              {roles.map((r) => (
                <button key={r} type="button" className={`kb-toggle sm pressable mono${b.roles?.includes(r) ? ' on' : ''}`} aria-pressed={!!b.roles?.includes(r)} onClick={() => toggleRole(r)}>
                  {r}
                </button>
              ))}
              {!b.roles?.length && <span className="faint">所有角色</span>}
            </div>
          </div>
        )}
      </div>
      <label className="kb-switch" title={b.enabled ? '停用后运行时不再查它' : '启用'}>
        <input type="checkbox" role="switch" checked={b.enabled} onChange={(e) => onPatch({ enabled: e.target.checked }, `${e.target.checked ? '启用' : '停用'} ${name}`)} />
        <span className="kb-switch-track" aria-hidden />
        <span className="sr-only">在本空间启用 {name}</span>
      </label>
      <Link to={`/knowledge/${b.baseId}`} className="btn btn-ghost btn-icon btn-sm" aria-label={`打开 ${name}`}>
        <ChevronRight />
      </Link>
    </li>
  )
}

/** 空间设置 ·「知识库」Tab：只管绑定（启用、优先级、intents、角色），知识库本身在知识库页里建和调。 */
export function KnowledgeTab({ space }: { space?: SpaceDetail }) {
  const ds = useSource()
  const q = useAsync((d) => Promise.all([d.knowledgeBindings(), d.knowledgeBases()]), [])
  const [local, setLocal] = useState<KnowledgeBinding[]>()
  const bindings = [...(local ?? q.data?.[0] ?? [])].sort((a, b) => a.priority - b.priority)
  const bases = q.data?.[1] ?? []
  const st = useStagger(bindings.length)
  const flash = useFlashRows(bindings.map((b) => b.baseId))
  const roles = space?.agents.map((a) => a.role) ?? []

  async function save(next: KnowledgeBinding[], what: string) {
    const prev = bindings
    const norm = next.map((b, i) => ({ ...b, priority: i + 1 }))
    setLocal(norm)
    try {
      setLocal(await ds.saveKnowledgeBindings(norm, reason(what)))
      toast(`已${what}`, { undo: async () => setLocal(await ds.saveKnowledgeBindings(prev, reason(`撤销：${what}`))) })
    } catch (e) {
      setLocal(prev)
      toast('没有保存', { tone: 'failed', body: (e as Error).message })
    }
  }
  const patch = (id: string) => (p: Partial<KnowledgeBinding>, what: string) => void save(bindings.map((b) => (b.baseId === id ? { ...b, ...p } : b)), what)
  const move = (i: number) => (d: -1 | 1) => {
    const next = [...bindings]
    const [x] = next.splice(i, 1)
    next.splice(i + d, 0, x!)
    void save(next, `调整 ${bases.find((b) => b.id === x!.baseId)?.name ?? x!.baseId} 的优先级`)
  }
  const unbound = bases.filter((b) => !bindings.some((x) => x.baseId === b.id))

  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={q.reload} />
  if (!q.data || !space) return <div className="card"><SkeletonRows rows={4} /></div>
  return (
    <div className="kb-bind-tab">
      {space.knowledge.length > 0 && <MigrateCard count={space.knowledge.length} onDone={q.reload} />}
      <section className="kb-section">
        <div className="kb-section-head">
          <h2 className="kb-h2">本空间绑定的知识库</h2>
          <span className="faint">路由器按问题意图选库；同分时优先级高的排前</span>
          <span className="kb-spacer" />
          <Link to="/knowledge" className="btn btn-sm">
            <BookOpen />
            全部知识库
          </Link>
        </div>
        {bindings.length === 0 ? (
          <EmptyState compact icon={BookOpen} title="还没有绑定知识库" body={bases.length ? '从下面选一个绑定，运行里的节点就能查到它。' : '先建一个知识库，再回来绑定。'} action={bases.length ? undefined : <Link to="/knowledge?new=1" className="btn btn-sm btn-primary">新建知识库</Link>} stewardAsk="帮我给这个空间配好知识库" />
        ) : (
          <ul className="kb-bindings">
            {bindings.map((b, i) => {
              const s = st(i)
              return <BindingRow key={b.baseId} b={b} base={bases.find((x) => x.id === b.baseId)} roles={roles} first={i === 0} last={i === bindings.length - 1} onPatch={patch(b.baseId)} onMove={move(i)} className={`${s.className ?? ''} ${flash(b.baseId)}`} style={s.style} />
            })}
          </ul>
        )}
      </section>
      {unbound.length > 0 && (
        <section className="kb-section">
          <h2 className="kb-h2">可以绑定</h2>
          <ul className="kb-unbound-list">
            {unbound.map((b) => (
              <li key={b.id}>
                <KindGlyph kind={b.kind} size={28} />
                <Link to={`/knowledge/${b.id}`} className="kb-binding-name">
                  {b.name}
                </Link>
                <span className="faint truncate">{b.description}</span>
                <span className="kb-spacer" />
                <button type="button" className="btn btn-sm" onClick={() => void save([...bindings, { baseId: b.id, scope: b.scope, enabled: true, priority: bindings.length + 1 }], `绑定 ${b.name}`)}>
                  <Plus />
                  绑定
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
