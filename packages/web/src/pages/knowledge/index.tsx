import { lazy, Suspense, useMemo, useState } from 'react'
import { BookOpen, Plus } from 'lucide-react'
import type { KnowledgeBaseSummary } from '@taktflow/core'
import { useAsync } from '../../api'
import { useCrumbs } from '../../components/layout'
import { EmptyState, ErrorState, PageHeader, Segmented, SkeletonGrid, useFlashRows, useStagger, useStewardSuggestions } from '../../components/ui'
import { setQuery, useLocation } from '../../lib/router'
import { KnowledgeCard } from './card'
import { KindCards } from './kind-cards'
import './knowledge.css'

const CreateWizard = lazy(() => import('./wizard').then((m) => ({ default: m.CreateWizard })))

type Filter = 'all' | 'ready' | 'building' | 'draft'
const matches = (b: KnowledgeBaseSummary, f: Filter) => f === 'all' || (f === 'building' ? b.status === 'building' || !!b.building : f === 'draft' ? b.status === 'draft' || b.status === 'error' : b.status === 'ready' || b.status === 'stale')

/** 知识库列表 /s/:space/knowledge。?new=1[&kind=rag] 打开新建向导。 */
export function KnowledgeListPage() {
  const { query } = useLocation()
  const q = useAsync((ds) => ds.knowledgeBases(), [])
  const kinds = useAsync((ds) => ds.knowledgeKinds(), [])
  const suggestions = useStewardSuggestions('knowledge')
  const [filter, setFilter] = useState<Filter>('all')
  useCrumbs([{ label: '知识库' }], [])

  const all = q.data ?? []
  const list = useMemo(() => all.filter((b) => matches(b, filter)), [all, filter])
  const st = useStagger(list.length)
  const flash = useFlashRows(all.map((b) => b.id))
  const count = (f: Filter) => all.filter((b) => matches(b, f)).length
  const building = count('building')
  const openNew = (kind?: string) => setQuery({ new: '1', kind }, { replace: false })
  const wizardOpen = query.get('new') === '1'
  // 第一次打开后保持挂载，关闭时对话框才有退出动画；每次重新打开换 key 重置向导
  const [wizard, setWizard] = useState<{ mounted: boolean; n: number; closed?: boolean }>({ mounted: wizardOpen, n: 0 })
  if (wizardOpen && (!wizard.mounted || wizard.closed)) setWizard({ mounted: true, n: wizard.n + 1 })
  if (!wizardOpen && wizard.mounted && !wizard.closed) setWizard({ ...wizard, closed: true })

  const description = !q.data
    ? '节点在运行时检索的文档、Wiki、数据库与接口；发布后才会被运行使用。'
    : all.length === 0
      ? '节点在运行时检索的文档、Wiki、数据库与接口；发布后才会被运行使用。'
      : `${all.length} 个知识库，${all.filter((b) => b.bound).length} 个绑定在本空间${building ? `，${building} 个正在构建` : ''}。`

  return (
    <div className="page kb-page">
      <PageHeader
        title="知识库"
        description={description}
        suggestions={suggestions}
        actions={
          <button type="button" className="btn btn-primary" onClick={() => openNew()}>
            <Plus />
            新建知识库
          </button>
        }
      />
      {q.error && !q.data ? (
        <ErrorState error={q.error} onRetry={q.reload} />
      ) : !q.data ? (
        <SkeletonGrid count={6} min={300} />
      ) : all.length === 0 ? (
        <div className="kb-empty">
          <EmptyState
            icon={BookOpen}
            title="还没有知识库"
            body="知识库让节点查到业务规则、表结构和接口，回答更准。选一种类型开始，或者交给管家。"
            stewardAsk="帮我从 docs/ 建一个文档知识库"
          />
          {kinds.data && <KindCards kinds={kinds.data} onPick={(k) => openNew(k.kind)} />}
        </div>
      ) : (
        <>
          <div className="kb-toolbar">
            <Segmented<Filter>
              size="sm"
              ariaLabel="按状态筛选"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: '全部', count: all.length },
                { value: 'ready', label: '可用', count: count('ready') },
                { value: 'building', label: '构建中', count: building },
                { value: 'draft', label: '草稿', count: count('draft') },
              ]}
            />
          </div>
          {list.length === 0 ? (
            <EmptyState compact icon={BookOpen} title="这个筛选下没有知识库" body="换一个筛选看看。" action={<button type="button" className="btn btn-sm" onClick={() => setFilter('all')}>看全部</button>} />
          ) : (
            <div className="kb-grid">
              {list.map((b, i) => {
                const s = st(i)
                return <KnowledgeCard key={b.id} base={b} className={`${s.className ?? ''} ${flash(b.id)}`} style={s.style} onBuildEnd={q.reload} />
              })}
            </div>
          )}
        </>
      )}
      {wizard.mounted && (
        <Suspense fallback={null}>
          <CreateWizard key={wizard.n} open={wizardOpen} initialKind={query.get('kind') ?? undefined} onClose={() => setQuery({ new: undefined, kind: undefined })} onCreated={q.reload} />
        </Suspense>
      )}
    </div>
  )
}
