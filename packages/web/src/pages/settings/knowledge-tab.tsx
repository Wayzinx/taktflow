import type { SpaceDetail } from '@taktflow/core'
import { BookOpen, Database, GitCommitHorizontal, Library, Network, Search, type LucideIcon } from 'lucide-react'
import { EmptyState, SkeletonRows } from '../../components/ui'

/** 知识源类型 → 图标与一句话说明它回答哪类问题（路由器按问题意图选源）。 */
const KINDS: Record<string, { icon: LucideIcon; label: string; answers: string }> = {
  ripgrep: { icon: Search, label: '代码检索', answers: '某个符号、文案、配置在哪' },
  grep: { icon: Search, label: '代码检索', answers: '某个符号、文案、配置在哪' },
  codegraph: { icon: Network, label: '调用图', answers: '谁调用了它、改了会影响哪里' },
  wiki: { icon: BookOpen, label: '文档', answers: '业务规则、规范、约定' },
  'db-schema': { icon: Database, label: '数据库', answers: '表结构、字段含义' },
  database: { icon: Database, label: '数据库', answers: '表结构、字段含义' },
  git: { icon: GitCommitHorizontal, label: '历史', answers: '为什么这么写、以前怎么改的' },
  'git-history': { icon: GitCommitHorizontal, label: '历史', answers: '为什么这么写、以前怎么改的' },
}
const OTHER = { icon: Library, label: '自定义', answers: '由插件声明' }

/** 空间设置 · 知识源：SpaceDetail.knowledge 的列表，对应 takt.config.json 的 knowledge。 */
export function KnowledgeTab({ space }: { space?: SpaceDetail }) {
  if (!space) return <div className="card"><SkeletonRows rows={5} /></div>
  const list = space.knowledge
  return (
    <div className="space-split">
      <div className="card">
        <div className="card-head">
          <span className="card-title">知识源</span>
          <span className="faint num">{list.length}</span>
        </div>
        {list.length === 0 ? (
          <EmptyState
            compact
            icon={BookOpen}
            title="还没有配置知识源"
            hint={<>Agent 只能读到输入物料和代码本身。在 <span className="mono">takt.config.json</span> 的 <span className="mono">knowledge</span> 里登记 wiki、调用图、表结构等来源，Agent 就能按需查询。</>}
          />
        ) : (
          <ul className="knowledge-list">
            {list.map((k) => {
              const meta = KINDS[k.kind] ?? OTHER
              const Icon = meta.icon
              return (
                <li key={k.id} className="knowledge-row">
                  <span className="knowledge-icon" aria-hidden>
                    <Icon />
                  </span>
                  <div className="knowledge-main">
                    <div className="knowledge-title">
                      <span className="mono knowledge-id">{k.id}</span>
                      <span className="chip chip-sm">
                        {meta.label} · <span className="mono">{k.kind}</span>
                      </span>
                    </div>
                    <p className="knowledge-desc">{k.description}</p>
                  </div>
                  <span className="knowledge-answers">
                    <span className="field-label">回答</span>
                    {meta.answers}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      <aside className="space-aside">
        <div className="section-label">怎么用</div>
        <p>Agent 提问时，路由器按问题意图（找位置、看影响面、查规则、问历史）挑选知识源，命中结果带证据等级，过期或冲突的只当参考。</p>
        <p>每次查询都记进节点的上下文账本，可以在运行页节点抽屉的"上下文"里看到用了哪些来源。</p>
        <p className="faint space-aside-note">
          配置：<span className="mono">takt.config.json → knowledge: [&#123; id, kind, options &#125;]</span>
        </p>
      </aside>
    </div>
  )
}
