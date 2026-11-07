import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { KnowledgeBaseSummary, KnowledgeEvalCase, KnowledgeIntent, KnowledgeQueryResponse } from '@taktflow/core'
import { Search, SearchX, ShieldBan } from 'lucide-react'
import { useAsync, useSource } from '../../api'
import { EmptyState, ErrorState, Segmented, SkeletonRows, toast } from '../../components/ui'
import { HitRow, type Mark } from './hit-row'
import { evalSetTitle, INTENTS } from './meta'

type Hit = KnowledgeQueryResponse['hits'][number]

/** 检索测试：问题 + intent + topK + 版本 → 命中（分项得分、原文、标注）。标注直接写进评测集。 */
/** initial：带进来的问题（?q= 深链，例如从「使用」里点最近的查询），挂载后直接检索一次。 */
export function QueryPanel({ base, example, compact, initial }: { base: KnowledgeBaseSummary; example?: string; compact?: boolean; initial?: string }) {
  const ds = useSource()
  const sets = useAsync((d) => d.knowledgeEvalSets(base.id), [base.id])
  const [text, setText] = useState(initial ?? '')
  const [intent, setIntent] = useState<KnowledgeIntent>(base.intents[0] ?? 'business')
  const [topK, setTopK] = useState(String(Math.min(10, base.retrieval.topK)))
  const hasCandidate = !!base.candidateVersion
  const [version, setVersion] = useState<'published' | 'candidate'>(hasCandidate || !base.version ? 'candidate' : 'published')
  const [res, setRes] = useState<{ q: string; r: KnowledgeQueryResponse }>()
  const [err, setErr] = useState<Error>()
  const [busy, setBusy] = useState(false)
  const [marks, setMarks] = useState<Record<string, Mark>>({})
  const [setId, setSetId] = useState<string>()
  const me = useAsync((d) => d.me().catch(() => undefined), [])
  // 本次会话里建过的手工用例（按 评测集 + 问题）：sets.reload() 是异步的，连续标注时不能只靠 sets.data 找已有用例
  const made = useRef(new Map<string, KnowledgeEvalCase>())
  const targetSet = setId ?? sets.data?.[0]?.id ?? 'es-manual'
  const found = sets.data?.find((s) => s.id === targetSet)
  const targetTitle = found ? evalSetTitle(found) : '手工标注'

  async function run(q = text) {
    if (!q.trim()) return
    setBusy(true)
    setErr(undefined)
    try {
      const r = await ds.queryKnowledge(base.id, { text: q, intent, topK: Number(topK), version })
      setRes({ q, r })
      setMarks({})
    } catch (e) {
      setErr(e as Error)
    } finally {
      setBusy(false)
    }
  }
  const submit = (e: FormEvent) => (e.preventDefault(), void run())
  const ran = useRef(false)
  useEffect(() => {
    if (initial && !ran.current) (ran.current = true), void run(initial)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial])

  /** 标注：同一个问题合并成一条手工用例；"不相关"把它从 relevant 里拿掉。 */
  async function mark(hit: Hit, m: Mark) {
    if (!res) return
    const next = { ...marks, [hit.ref]: marks[hit.ref] === m ? undefined : m }
    const prevMarks = marks
    setMarks(next)
    const key = `${targetSet}\u0000${res.q}`
    const existing = made.current.get(key) ?? sets.data?.find((s) => s.id === targetSet)?.cases.find((c) => c.query === res.q && c.source === 'manual')
    const relevant = Object.entries(next).filter(([, v]) => v === 'rel').map(([ref]) => ({ ref, grade: 3 as const }))
    const c: KnowledgeEvalCase = existing
      ? { ...existing, relevant, status: relevant.length ? 'active' : 'retired' }
      : { id: `kc-m-${Date.now().toString(36)}`, query: res.q, intent, relevant, source: 'manual', status: relevant.length ? 'active' : 'retired', createdAt: new Date().toISOString(), createdBy: { type: 'human', id: me.data?.id ?? 'web' } }
    const before = made.current.get(key)
    made.current.set(key, c)
    try {
      await ds.saveKnowledgeEvalCases(base.id, targetSet, [c])
      sets.reload()
      const label = next[hit.ref] === 'rel' ? '标为相关' : next[hit.ref] === 'irr' ? '标为不相关' : '取消标注'
      toast(`已${label}，写入「${targetTitle}」`, {
        body: `${relevant.length} 条相关结果 · ${res.q}`,
        undo: async () => {
          setMarks(prevMarks)
          const back = existing ?? { ...c, status: 'retired' as const }
          made.current.set(key, back)
          await ds.saveKnowledgeEvalCases(base.id, targetSet, [back])
          sets.reload()
        },
      })
    } catch (e) {
      setMarks(prevMarks)
      if (before) made.current.set(key, before)
      else made.current.delete(key)
      toast('标注没有保存', { tone: 'failed', body: (e as Error).message })
    }
  }

  const ex = res?.r.executed
  return (
    <div className={`kb-query${compact ? ' compact' : ''}`}>
      <form className="kb-query-form" onSubmit={submit}>
        <div className="kb-query-input">
          <Search aria-hidden />
          <input className="input" autoFocus={!compact} value={text} onChange={(e) => setText(e.target.value)} placeholder={example ? `输入问题，例如：${example}` : '输入一个节点可能会问的问题'} aria-label="检索问题" />
          <button type="submit" className="btn btn-primary" disabled={busy || !text.trim()}>
            检索
          </button>
        </div>
        <div className="kb-query-opts">
          <label className="kb-inline">
            <span className="faint">意图</span>
            <select className="select" value={intent} onChange={(e) => setIntent(e.target.value as KnowledgeIntent)} aria-label="意图">
              {INTENTS.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.label}
                </option>
              ))}
            </select>
          </label>
          <span className="kb-inline">
            <span className="faint">topK</span>
            <Segmented size="sm" ariaLabel="topK" value={topK} onChange={setTopK} options={['3', '5', '8', '10'].map((v) => ({ value: v, label: v }))} />
          </span>
          <span className="kb-inline">
            <span className="faint">版本</span>
            <Segmented<'published' | 'candidate'>
              size="sm"
              ariaLabel="版本"
              value={version}
              onChange={setVersion}
              options={[
                { value: 'published', label: base.version ? `已发布 v${base.version}` : '未发布', disabled: !base.version },
                { value: 'candidate', label: hasCandidate ? `候选 v${base.candidateVersion}` : '候选', disabled: !hasCandidate && !!base.version },
              ]}
            />
          </span>
          {!compact && sets.data && sets.data.length > 1 && (
            <label className="kb-inline kb-query-set">
              <span className="faint">标注写入</span>
              <select className="select" value={targetSet} onChange={(e) => setSetId(e.target.value)} aria-label="标注写入的评测集">
                {sets.data.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {!res && !busy && example && (
          <div className="kb-query-try">
            <span className="faint">试试</span>
            <button type="button" className="suggest-chip pressable" onClick={() => (setText(example), void run(example))}>
              {example}
            </button>
          </div>
        )}
      </form>

      {err ? (
        <ErrorState compact error={err} onRetry={() => void run()} title="检索失败" />
      ) : busy && !res ? (
        <SkeletonRows rows={4} />
      ) : res ? (
        <div className={`kb-results${busy ? ' is-stale' : ''}`} aria-busy={busy}>
          <div className="kb-results-meta">
            <span>
              <strong className="num">{res.r.hits.length}</strong> 条命中
            </span>
            <span className="faint num">{res.r.latencyMs}ms</span>
            <span className="faint num">{res.r.tokens.toLocaleString()} tokens</span>
            <span className="faint">按「{INTENTS.find((i) => i.id === res.r.intent)?.label ?? res.r.intent}」路由</span>
            <span className="kb-spacer" />
            <span className="faint">标"相关 / 不相关"会写进评测集「{targetTitle}」</span>
          </div>
          {ex && (
            <div className={`kb-exec${ex.blocked ? ' blocked' : ''}`}>
              <div className="kb-exec-head">
                <span className="section-label">{ex.kind === 'sql' ? '实际执行的 SQL' : '实际发出的请求'}</span>
                {ex.blocked && (
                  <span className="kb-exec-blocked">
                    <ShieldBan aria-hidden />
                    已拦截：{ex.blocked}
                  </span>
                )}
              </div>
              <pre className="mono">{ex.text}</pre>
            </div>
          )}
          {res.r.hits.length === 0 ? (
            !ex?.blocked && <EmptyState compact icon={SearchX} title="没有命中" body="换个说法，或者把相关文档加进数据源。" stewardAsk={`知识库「${base.name}」查不到「${res.q}」，帮我看看是缺文档还是参数问题`} />
          ) : (
            <ol className="kb-hits">
              {res.r.hits.map((h, i) => (
                <HitRow key={`${res.q}-${h.ref}`} hit={h} index={i} mark={marks[h.ref]} onMark={(m) => void mark(h, m)} />
              ))}
            </ol>
          )}
        </div>
      ) : null}
    </div>
  )
}
