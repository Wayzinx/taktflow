import { lazy, Suspense, useState } from 'react'
import { Hammer, Rocket } from 'lucide-react'
import { useAsync, useSource } from '../../api'
import { useCrumbs } from '../../components/layout'
import { ErrorState, PageHeader, Skeleton, SkeletonCard, SkeletonText, StatusBadge, TabPanel, Tabs, toast, useStewardSuggestions, vtName } from '../../components/ui'
import { fmtRelative } from '../../lib/format'
import { setQuery, useLocation } from '../../lib/router'
import { KindGlyph, useLiveBuild } from './card'
import { kbStatusMeta, autoReason, kindMeta } from './meta'
import { PublishDialog } from './publish'
import { OverviewTab } from './tab-overview'
import './knowledge.css'

export const KNOWLEDGE_TABS = [
  { id: 'overview', label: '概览' },
  { id: 'sources', label: '数据源' },
  { id: 'builds', label: '构建' },
  { id: 'query', label: '检索测试' },
  { id: 'eval', label: '评测' },
  { id: 'usage', label: '使用' },
  { id: 'settings', label: '设置' },
] as const

const SourcesTab = lazy(() => import('./tab-sources').then((m) => ({ default: m.SourcesTab })))
const BuildsTab = lazy(() => import('./tab-builds').then((m) => ({ default: m.BuildsTab })))
const QueryTab = lazy(() => import('./tab-query').then((m) => ({ default: m.QueryTab })))
const EvalTab = lazy(() => import('./tab-eval').then((m) => ({ default: m.EvalTab })))
const UsageTab = lazy(() => import('./tab-usage').then((m) => ({ default: m.UsageTab })))
const SettingsTab = lazy(() => import('./tab-settings').then((m) => ({ default: m.SettingsTab })))

/** 知识库详情 /s/:space/knowledge/:id；?tab= 七个 Tab（KNOWLEDGE_TABS）。 */
export function KnowledgeDetailPage({ id }: { id: string }) {
  const ds = useSource()
  const { query } = useLocation()
  const tab = query.get('tab') ?? 'overview'
  const q = useAsync((d) => d.knowledgeBase(id), [id])
  const kinds = useAsync((d) => d.knowledgeKinds(), [])
  const needsBuild = kinds.data?.find((k) => k.kind === q.data?.kind)?.needsBuild
  const suggestions = useStewardSuggestions('knowledge', id)
  const [publishing, setPublishing] = useState(query.get('publish') === '1')
  const [starting, setStarting] = useState(false)
  const [startedId, setStartedId] = useState<string>()
  const b = q.data
  const live = useLiveBuild(id, b?.building?.buildId ?? startedId, () => q.reload())
  useCrumbs([{ label: '知识库', to: '/knowledge' }, { label: b?.name ?? <span className="mono">{id}</span> }], [id, b?.name])

  if (q.error && !b) return <ErrorState error={q.error} onRetry={q.reload} />

  async function build() {
    if (!b) return
    setStarting(true)
    try {
      const r = await ds.startKnowledgeBuild(b.id, autoReason('手动构建'))
      setStartedId(r.id)
      toast(`开始构建 v${r.version}`, { tone: 'running', body: '进度在"构建"里实时更新。', action: { label: '查看', onClick: () => setQuery({ tab: 'builds' }) } })
      q.reload()
    } catch (e) {
      toast('构建没有启动', { tone: 'failed', body: (e as Error).message })
    } finally {
      setStarting(false)
    }
  }

  const running = live ? live.status === 'running' : !!b?.building
  const status = b ? kbStatusMeta(b, running) : undefined
  const meta = b ? kindMeta(b.kind) : undefined
  const counts: Record<string, number | undefined> = { builds: b?.builds.length || undefined, eval: b?.evalSets.reduce((n, s) => n + s.total, 0) || undefined }

  return (
    <div className="page kb-page">
      <PageHeader
        icon={b ? <KindGlyph kind={b.kind} size={40} live={running} /> : <Skeleton w={40} h={40} r={10} />}
        eyebrow={b && meta ? `${meta.label} · ${b.scope === 'shared' ? '共享知识库' : '本空间'}` : undefined}
        title={b?.name ?? <span className="mono">{id}</span>}
        titleTransitionName={vtName('kb', id)}
        description={
          b ? (
            <span className="kb-head-desc">
              {status && <StatusBadge meta={status} />}
              <span className="num">{b.version ? `已发布 v${b.version}` : '未发布'}</span>
              {b.candidateVersion && <span className="kb-cand mono">候选 v{b.candidateVersion}</span>}
              {b.builtAt && <span className="faint">{fmtRelative(b.builtAt)}构建</span>}
              <span className="kb-head-text">{b.description}</span>
            </span>
          ) : (
            <SkeletonText lines={1} width={360} />
          )
        }
        suggestions={suggestions}
        actions={
          b && (
            <>
              <button type="button" className="btn" disabled={running || starting} onClick={() => void build()} title={running ? '已有一次构建在进行中' : undefined}>
                <Hammer />
                {b.status === 'draft' && !b.builtAt ? '开始构建' : '重新构建'}
              </button>
              {(b.candidateVersion || needsBuild === false) && (
                <button type="button" className="btn btn-primary" onClick={() => setPublishing(true)}>
                  <Rocket />
                  {b.candidateVersion ? `发布 v${b.candidateVersion}` : b.version ? '重新发布' : '发布'}
                </button>
              )}
            </>
          )
        }
      />
      <Tabs
        tabs={KNOWLEDGE_TABS.map((t) => ({ ...t, count: counts[t.id] }))}
        value={tab}
        onChange={(t) => setQuery({ tab: t === 'overview' ? undefined : t, run: undefined, q: undefined })}
      />
      <TabPanel key={tab} className="kb-tab">
        {!b ? (
          <div className="kb-cols">
            <SkeletonCard height={180} />
            <SkeletonCard height={180} />
          </div>
        ) : (
          <Suspense fallback={<SkeletonCard height={220} />}>
            {tab === 'overview' && <OverviewTab base={b} live={live} onBuild={() => void build()} onPublish={() => setPublishing(true)} />}
            {tab === 'sources' && <SourcesTab base={b} reload={q.reload} onBuild={() => void build()} />}
            {tab === 'builds' && <BuildsTab base={b} live={live} reload={q.reload} onBuild={() => void build()} />}
            {tab === 'query' && <QueryTab base={b} />}
            {tab === 'eval' && <EvalTab base={b} />}
            {tab === 'usage' && <UsageTab base={b} />}
            {tab === 'settings' && <SettingsTab base={b} reload={q.reload} />}
          </Suspense>
        )}
      </TabPanel>
      {b && <PublishDialog base={b} open={publishing} onClose={() => setPublishing(false)} onDone={q.reload} />}
    </div>
  )
}
