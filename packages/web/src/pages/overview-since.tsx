import { useState } from 'react'
import { ChevronDown, X } from 'lucide-react'
import type { Digest } from '@taktflow/core'
import { useAsync, useSource } from '../api'
import { fmtRelative } from '../lib/format'
import { Link, useLocation } from '../lib/router'
import { openSteward } from '../lib/ui-store'
import { markDigestSeen, peekDigest } from '../components/steward/digest-session'
import { StewardMark } from '../components/identity'

const SEEN_KEY = 'taktflow.digest.seen'

function readSeen(space: string): string | undefined {
  try {
    return window.localStorage.getItem(`${SEEN_KEY}:${space}`) ?? undefined
  } catch {
    return undefined
  }
}
function writeSeen(space: string, id: string) {
  try {
    window.localStorage.setItem(`${SEEN_KEY}:${space}`, id)
  } catch {
    /* 隐私模式：下次打开还会显示，不影响使用 */
  }
}

const PROGRESS_WORD: Record<Digest['progress'][number]['kind'], string> = {
  created: '新建',
  started: '开始运行',
  stage: '阶段推进',
  delivered: '已交付',
  failed: '失败',
  blocked: '阻塞',
}

/**
 * 总览顶部"自上次以来"横幅（D 组；docs/design/22 §1.6）：管家汇报的入口。
 * 收起时一句摘要 + 三个计数；展开（grid-template-rows 0fr → 1fr）按"需要你处理 → 新风险 → 进展"三列列出，
 * 每项都能直接跳过去。只汇报当前空间（别的空间的进展在管家页的全局汇报里看）；
 * "知道了"只在本机记住这个空间的这份汇报，下次有新汇报再出现。
 */
export function SinceBanner() {
  const ds = useSource()
  const { spaceId: prefix } = useLocation()
  // 默认空间的地址不带 /s/ 前缀：用当前空间的真实 id
  const sq = useAsync((d) => (prefix ? Promise.resolve(prefix) : d.space().then((s) => s.id)), [prefix ?? ''])
  const space = sq.data ?? ''
  const q = useAsync((d) => (space ? peekDigest(d, space) : Promise.resolve(undefined)), [space])
  const [seenBy, setSeen] = useState<Record<string, string | undefined>>({})
  const seen = space in seenBy ? seenBy[space] : readSeen(space)
  const [open, setOpen] = useState(false)
  const d = q.data
  const total = d ? d.attention.length + d.risks.length + d.progress.length : 0
  const visible = Boolean(d && total > 0 && seen !== d.id)
  if (!visible || !d) return null

  const click = (what: string) => void ds.reportProductEvent({ type: 'digest.click', feature: 'steward.digest', detail: { what } }).catch(() => undefined)
  // 用户看了（展开 / 知道了）才标已读；digest.open 由服务端在标已读时记，页面不重复上报
  const dismiss = () => {
    markDigestSeen(ds, d.id, space)
    writeSeen(space, d.id)
    setSeen((cur) => ({ ...cur, [space]: d.id }))
  }
  const high = d.risks.filter((r) => r.level === 'high').length
  return (
    <section className="since-banner" aria-label="自上次以来">
      <div className="since-head">
        <StewardMark size={32} className="since-icon" />
        <div className="since-main">
          <div className="since-title">
            自上次以来
            {d.since && <span className="since-when">{fmtRelative(d.since)}</span>}
          </div>
          <p className="since-summary">{d.summary}</p>
        </div>
        <div className="since-counts">
          {d.attention.length > 0 && <span className="since-count waiting"><b className="num">{d.attention.length}</b> 件等你处理</span>}
          {d.risks.length > 0 && <span className={`since-count${high ? ' risk' : ''}`}><b className="num">{d.risks.length}</b> 条新风险</span>}
          {d.progress.length > 0 && <span className="since-count"><b className="num">{d.progress.length}</b> 项进展</span>}
        </div>
        <div className="since-actions">
          <button type="button" className="btn btn-sm btn-ghost" aria-expanded={open} onClick={() => (setOpen((v) => !v), click('expand'), markDigestSeen(ds, d.id, space))}>
            {open ? '收起' : '展开'}
            <ChevronDown className={`since-chevron${open ? ' up' : ''}`} aria-hidden />
          </button>
          <button type="button" className="btn btn-sm" onClick={() => (click('ask'), openSteward({ prefill: '展开讲讲自上次以来的变化，先说需要我处理的' }))}>
            问管家
          </button>
          <button type="button" className="btn btn-sm btn-ghost btn-icon" onClick={dismiss} aria-label="知道了，收起这份汇报" title="知道了">
            <X aria-hidden />
          </button>
        </div>
      </div>
      <div className="expand" data-open={open ? 'true' : 'false'}>
        <div className="expand-inner" inert={!open}>
          <div className="since-body">
            <SinceColumn title="需要你处理" empty="没有等你的事">
              {d.attention.map((a) => (
                <Link key={a.requestId} to={a.href} className="since-item" onClick={() => click('attention')}>
                  <span className="mono since-id">{a.requirementId}</span>
                  <span className="truncate">{a.ask}</span>
                  <span className="since-meta">{fmtRelative(a.since)}</span>
                </Link>
              ))}
            </SinceColumn>
            <SinceColumn title="新风险" empty="没有新风险">
              {d.risks.map((r) => (
                <Link key={r.key} to={r.evidence[0]?.href ?? '/solo'} className="since-item" onClick={() => click('risk')}>
                  <span className={`since-level ${r.level}`}>{r.level === 'high' ? '高' : '中'}</span>
                  <span className="truncate">{r.title}</span>
                </Link>
              ))}
            </SinceColumn>
            <SinceColumn title="进展" empty="还没有新进展">
              {d.progress.map((p) => (
                <Link key={`${p.requirementId}-${p.kind}-${p.at}`} to={p.href} className="since-item" onClick={() => click('progress')}>
                  <span className="mono since-id">{p.requirementId}</span>
                  <span className="truncate">
                    {PROGRESS_WORD[p.kind]}
                    {p.from && p.to ? `：${p.from} → ${p.to}` : `：${p.title}`}
                  </span>
                  {p.more ? <span className="since-meta" title={`同一需求之前还有 ${p.more} 条进展`}>另 {p.more} 条</span> : null}
                  <span className="since-meta">{fmtRelative(p.at)}</span>
                </Link>
              ))}
            </SinceColumn>
          </div>
          <div className="since-foot">
            <Link to="/solo?focus=digest" className="btn btn-sm btn-ghost" onClick={() => click('steward')}>
              在管家里看完整汇报
            </Link>
          </div>
        </div>
      </div>
    </section>
  )
}

function SinceColumn({ title, empty, children }: { title: string; empty: string; children: React.ReactNode[] }) {
  return (
    <div className="since-col">
      <div className="since-col-title">
        {title}
        <span className="num faint">{children.length}</span>
      </div>
      {children.length ? children : <div className="faint since-empty">{empty}</div>}
    </div>
  )
}
