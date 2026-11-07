import type { KnowledgeBaseDetail, KnowledgeBinding } from '@taktflow/core'
import { useAsync, useSource } from '../../api'
import { SkeletonText, toast } from '../../components/ui'
import { Link } from '../../lib/router'
import { autoReason } from './meta'

/** 访问控制：本空间里哪些角色能用它（改的是空间绑定的 roles，立即保存、可撤销）。 */
export function AccessCard({ base }: { base: KnowledgeBaseDetail }) {
  const ds = useSource()
  // ux-audit: ok 绑定卡片只编辑本库的一条绑定，没有列表区域；加载用骨架
  const bindings = useAsync((d) => d.knowledgeBindings(), [])
  // ux-audit: ok 角色只是多选项
  const roles = useAsync((d) => d.space().then((s) => s.agents.map((a) => a.role)).catch(() => [] as string[]), [])
  const mine = bindings.data?.find((b) => b.baseId === base.id)

  async function save(next: KnowledgeBinding[], what: string) {
    const prev = bindings.data ?? []
    try {
      await ds.saveKnowledgeBindings(next, autoReason(what))
      bindings.reload()
      toast(what, { undo: async () => (await ds.saveKnowledgeBindings(prev, autoReason(`撤销：${what}`)), bindings.reload()) })
    } catch (e) {
      toast('没有保存', { tone: 'failed', body: (e as Error).message })
    }
  }
  const patch = (p: Partial<KnowledgeBinding>, what: string) => mine && void save((bindings.data ?? []).map((b) => (b.baseId === base.id ? { ...b, ...p } : b)), what)
  const toggleRole = (r: string) => {
    if (!mine) return
    const cur = mine.roles ?? []
    const next = cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r]
    patch({ roles: next.length ? next : undefined }, next.length ? `只允许 ${next.join('、')} 使用 ${base.name}` : `${base.name} 对所有角色开放`)
  }

  return (
    <section className="kb-section">
      <div className="kb-section-head">
        <h2 className="kb-h2">访问控制</h2>
        <span className="faint">{base.scope === 'shared' ? '共享知识库：多个空间可以绑定' : '只在本空间'}</span>
      </div>
      {!bindings.data || !roles.data ? (
        <SkeletonText lines={2} />
      ) : !mine ? (
        <div className="kb-danger-row">
          <span className="faint">还没有绑定到本空间，运行时不会用到它。</span>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => void save([...(bindings.data ?? []), { baseId: base.id, scope: base.scope, enabled: true, priority: (bindings.data?.length ?? 0) + 1 }], `已把 ${base.name} 绑定到本空间`)}>
            绑定到本空间
          </button>
        </div>
      ) : (
        <div className="ov-form">
          <label className="kb-check">
            <input type="checkbox" checked={mine.enabled} onChange={(e) => patch({ enabled: e.target.checked }, `${e.target.checked ? '已启用' : '已停用'} ${base.name}`)} />
            在本空间启用
            <Link to="/settings?tab=knowledge" className="kb-link">
              优先级与意图在空间设置里调
            </Link>
          </label>
          <div className="ov-field">
            <span className="ov-field-label">
              能用它的角色<span className="ov-field-hint">都不选 = 所有角色</span>
            </span>
            <div className="kb-intent-toggles" role="group" aria-label="能用它的角色">
              {roles.data.map((r) => {
                const on = !!mine.roles?.includes(r)
                return (
                  <button key={r} type="button" className={`kb-toggle pressable mono${on ? ' on' : ''}`} aria-pressed={on} onClick={() => toggleRole(r)}>
                    {r}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
