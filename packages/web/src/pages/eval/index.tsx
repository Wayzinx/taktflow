import { BarChart3, FlaskConical, Plus, TrendingDown } from 'lucide-react'
import type { NodeScorecard } from '@taktflow/core'
import { useAsync, type ScorecardBy } from '../../api'
import { useCrumbs } from '../../components/layout'
import { ErrorState, PageHeader, Segmented, TabPanel, Tabs, useStewardSuggestions } from '../../components/ui'
import { setQuery, useLocation } from '../../lib/router'
import { NewRunDialog } from './new-run-dialog'
import { RunDetail } from './run-detail'
import { RunsList } from './runs-list'
import { ScorecardDetail } from './scorecard-detail'
import { findCard } from './labels'
import { ScorecardTable } from './scorecard-table'
import './eval.css'
import './eval-runs.css'

const BY: Array<{ value: ScorecardBy; label: string }> = [
  { value: 'node', label: '节点' },
  { value: 'recipe', label: '配方' },
  { value: 'skill', label: '技能' },
]

function Scorecards() {
  const { query } = useLocation()
  const by = (BY.some((b) => b.value === query.get('by')) ? query.get('by') : 'node') as ScorecardBy
  const q = useAsync((ds) => ds.scorecards(by), [by])
  const open = query.get('card') ?? query.get('node') ?? undefined
  const card: NodeScorecard | undefined = open ? findCard(q.data ?? [], open) : undefined
  const regressed = q.data?.filter((c) => c.regression?.suspected) ?? []
  return (
    <>
      <div className="ev-toolbar">
        <Segmented options={BY} value={by} size="sm" ariaLabel="成绩单维度" onChange={(v) => setQuery({ by: v === 'node' ? undefined : v, card: undefined, node: undefined })} />
        <span className="faint ev-toolbar-hint">从事件与产物直接计算，零 token；缺陷只有人确认归因后才计入逃逸与检出率。</span>
        <span style={{ flex: 1 }} />
        {regressed.length > 0 && (
          <span className="sc-regress" title={regressed.map((c) => `${c.label}：${c.regression?.reason}`).join('\n')}>
            <TrendingDown aria-hidden />
            {regressed.length} 项疑似退化
          </span>
        )}
      </div>
      <div className="card">{q.error && !q.data ? <ErrorState error={q.error} onRetry={q.reload} /> : <ScorecardTable cards={q.data} by={by} onOpen={(k) => setQuery({ card: k, node: undefined })} />}</div>
      <ScorecardDetail card={card} onClose={() => setQuery({ card: undefined, node: undefined })} />
    </>
  )
}

function Runs() {
  const { query } = useLocation()
  const runId = query.get('run')
  const q = useAsync((ds) => ds.evalRuns(), [])
  const newTarget = query.get('new') ?? undefined
  const newOpen = query.has('new')
  const dialog = <NewRunDialog open={newOpen} initialTarget={newTarget && newTarget !== '1' ? newTarget : undefined} onClose={() => setQuery({ new: undefined })} />
  if (runId)
    return (
      <>
        <RunDetail key={runId} id={runId} />
        {dialog}
      </>
    )
  return (
    <>
      <div className="ev-toolbar">
        <span className="faint ev-toolbar-hint">每条用例在沙箱里用冻结输入回放被测节点；判分模型必须不同于被测模型。</span>
      </div>
      <div className="card">{q.error && !q.data ? <ErrorState error={q.error} onRetry={q.reload} /> : <RunsList runs={q.data} onNew={() => setQuery({ new: '1' })} />}</div>
      {dialog}
    </>
  )
}

/** /eval：空间级评测页（docs/design/20 §6）——成绩单与评测运行（含 A/B 对比）。 */
export function EvalPage() {
  const { query } = useLocation()
  const tab = query.get('tab') === 'runs' ? 'runs' : 'scorecards'
  const suggestions = useStewardSuggestions('eval')
  const regressed = useAsync((ds) => ds.scorecards('node').then((cs) => cs.filter((c) => c.regression?.suspected).length).catch(() => 0), [])
  useCrumbs([{ label: '评测', to: tab === 'runs' && query.get('run') ? '/eval?tab=runs' : undefined }, ...(query.get('run') ? [{ label: <span className="mono">{query.get('run')}</span> }] : [])], [tab, query.get('run')])
  return (
    <div className="page ev-page">
      <PageHeader
        title="评测"
        description={
          regressed.data
            ? `${regressed.data} 个节点疑似退化。改了技能或 prompt，用回放评测和基线配对比较，看清是不是真的变好。`
            : '节点、配方与技能的成绩单；改了技能或 prompt，用回放评测和基线配对比较，看清是不是真的变好。'
        }
        suggestions={suggestions}
        actions={
          <button className="btn btn-primary" onClick={() => setQuery({ tab: 'runs', run: undefined, new: '1' })}>
            <Plus />
            新建评测
          </button>
        }
      />
      <Tabs
        value={tab}
        onChange={(t) => setQuery({ tab: t === 'scorecards' ? undefined : t, run: undefined, card: undefined, node: undefined, by: undefined, new: undefined })}
        tabs={[
          { id: 'scorecards', label: '成绩单', icon: BarChart3 },
          { id: 'runs', label: '评测运行', icon: FlaskConical },
        ]}
      />
      <TabPanel key={tab} className="ev-body">
        {tab === 'runs' ? <Runs /> : <Scorecards />}
      </TabPanel>
    </div>
  )
}
