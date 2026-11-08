import { useState, type CSSProperties, type ReactNode } from 'react'
import { Anchor, ArrowUpRight, Check, Copy, History, Link2, Link2Off, RefreshCw, ShieldAlert, ShieldCheck, Wrench } from 'lucide-react'
import type { QualityStatus } from '@taktflow/core'
import { invalidate, useAsync, useSource } from '../../api'
import { EmptyState, ErrorState, ReasonDialog, SkeletonRows, toast } from '../../components/ui'
import { fmtDate, fmtRelative } from '../../lib/format'
import { Link } from '../../lib/router'
import './quality.css'

type Pending = { kind: 'repair' } | { kind: 'sync'; runId?: string }

/**
 * 质量日志（docs/design/21 §7）：缺陷、归因、样本、评测的唯一权威记录，复用事件存储的哈希链与链尾锚点。
 * - 链完整、锚点最新：只展示；
 * - 链完整、锚点落后：给"修复锚点"（只补锚点并记恢复，需原因）；
 * - 链被篡改或截断：红色警告与处理说明，不提供修复按钮，交给人核对。
 * 各运行的入账游标与上次同步时间；可以补算（需原因）。
 */
export function QualityTab() {
  const ds = useSource()
  const q = useAsync((d) => d.qualityStatus(), [])
  const runs = useAsync((d) => d.runs().catch(() => []), [])
  const [pending, setPending] = useState<Pending>()
  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={q.reload} />
  const s = q.data
  if (!s) return <SkeletonRows rows={4} />
  const reqOf = (runId: string) => runs.data?.find((r) => r.runId === runId)?.requirementId
  const cursors = Object.entries(s.cursors).sort((a, b) => b[0].localeCompare(a[0]))
  return (
    <div className="ql">
      <Hero s={s} onRepair={() => setPending({ kind: 'repair' })} />
      <div className="card ql-stats">
        <Stat label="条目" value={<span className="num">{s.entries}</span>} />
        <Stat
          label="锚点"
          value={s.anchor ? <AnchorValue a={s.anchor} ok={s.ok} behind={s.anchorBehind ? s.entries - s.anchor.seq : 0} /> : <span className="faint">还没有锚点</span>}
        />
        <Stat label="上次同步" value={s.lastSyncAt ? <span title={fmtDate(s.lastSyncAt)}>{fmtRelative(s.lastSyncAt)}</span> : <span className="faint">还没同步过</span>} />
        <Stat
          label="M3 缺陷导入"
          value={
            s.importedM3 ? (
              <span className="ql-yes">
                <Check />
                已导入
              </span>
            ) : (
              <span className="faint">未导入</span>
            )
          }
          hint={s.importedM3 ? '存放区里旧的 defects/*.md 已幂等导入日志，现在是给人看的投影' : '首次加载质量数据时会自动导入'}
        />
      </div>
      <div className="card">
        <div className="card-head">
          <span className="card-title">各运行的入账游标</span>
          <span className="faint ql-hint">提交成功后才推进；崩溃后从游标重放，靠幂等键去重</span>
          <span className="spacer" />
          <button type="button" className="btn btn-sm" disabled={!s.ok} title={s.ok ? undefined : '链被篡改时暂停入账'} onClick={() => setPending({ kind: 'sync' })}>
            <RefreshCw />
            全部补算
          </button>
        </div>
        {cursors.length === 0 ? (
          <EmptyState compact icon={History} title="还没有运行入账" body="运行结束时会自动同步；serve 运行期间实时入账。" />
        ) : (
          <ul className="ql-cursors">
            {cursors.map(([runId, seq], i) => {
              const req = reqOf(runId)
              return (
                <li key={runId} style={{ '--i': i } as CSSProperties}>
                  <Link to={`/run/${runId}`} className="mono ql-run">
                    {runId}
                    <ArrowUpRight />
                  </Link>
                  {req ? <span className="mono faint">{req}</span> : <span />}
                  <span className="ql-seq">
                    入账到第 <b className="num">{seq}</b> 条事件
                  </span>
                  <button type="button" className="btn btn-xs btn-ghost" disabled={!s.ok} onClick={() => setPending({ kind: 'sync', runId })}>
                    补算
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      <p className="faint ql-foot">
        日志在 <span className="mono">.takt/quality/log.jsonl</span>；缺陷、归因、样本、评测运行都是从它重建的读模型（<span className="mono">.takt/quality/views/</span>），可以删了重建。
        命令行：<span className="mono">takt quality verify | repair | sync</span>。
      </p>
      <ReasonDialog
        open={Boolean(pending)}
        onClose={() => setPending(undefined)}
        title={pending?.kind === 'repair' ? '修复锚点？' : pending?.runId ? `补算 ${pending.runId}？` : '全部补算？'}
        description={
          pending?.kind === 'repair'
            ? '只把锚点补到链尾，并记一条恢复记录；不改任何日志内容。链被篡改或截断时会被拒绝。'
            : '从游标处重放事件入账；已经入账的按幂等键跳过，不会重复。'
        }
        confirmLabel={pending?.kind === 'repair' ? '修复锚点' : '补算'}
        onSubmit={async (reason) => {
          if (!pending) return
          const next = pending.kind === 'repair' ? await ds.repairQuality(reason) : await ds.syncQuality({ runId: pending.runId, reason })
          invalidate()
          toast(pending.kind === 'repair' ? '锚点已修复' : '已补算', { body: `日志共 ${next.entries} 条${next.anchor ? `，锚点在第 ${next.anchor.seq} 条` : ''}`, tone: 'success' })
        }}
      />
    </div>
  )
}

function Hero({ s, onRepair }: { s: QualityStatus; onRepair: () => void }) {
  if (!s.ok)
    return (
      <div className="card ql-hero is-broken" role="alert">
        <span className="ql-hero-ic">
          <Link2Off />
        </span>
        <div className="ql-hero-main">
          <b className="ql-hero-title">哈希链被篡改或截断{s.brokenAt !== undefined && <span className="num">（从第 {s.brokenAt} 条起对不上）</span>}</b>
          <p>日志内容和链上记录的哈希不一致，说明有条目被改过、删过，或文件被截断。系统已暂停入账，也不会自动修复。</p>
          <ol className="ql-steps">
            <li>先备份整个 <span className="mono">.takt/quality/</span> 目录，不要再手动改它。</li>
            <li>
              运行 <span className="mono">takt quality verify</span> 看具体从哪一条开始对不上，对照 git 历史或备份找出被改的内容。
            </li>
            <li>确认原因后由空间管理员恢复日志文件；在这之前，缺陷、归因和评测的结论可能不可信。</li>
          </ol>
        </div>
      </div>
    )
  if (s.anchorBehind)
    return (
      <div className="card ql-hero is-behind">
        <span className="ql-hero-ic">
          <Anchor />
        </span>
        <div className="ql-hero-main">
          <b className="ql-hero-title">链完整，锚点落后{s.anchor && <span className="num"> {s.entries - s.anchor.seq} 条</span>}</b>
          <p>最近的日志写入后没来得及更新锚点，常见于进程被中断。日志本身没问题；修复只补锚点并记一条恢复记录。</p>
        </div>
        <button type="button" className="btn btn-sm btn-primary" onClick={onRepair}>
          <Wrench />
          修复锚点
        </button>
      </div>
    )
  return (
    <div className="card ql-hero is-ok">
      <span className="ql-hero-ic">
        <ShieldCheck />
      </span>
      <div className="ql-hero-main">
        <b className="ql-hero-title">链完整，锚点最新</b>
        <p>每条记录都接在上一条的哈希后面，链尾锚点与最后一条一致。</p>
      </div>
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="ql-stat" title={hint}>
      <span className="ql-stat-k">{label}</span>
      <span className="ql-stat-v">{value}</span>
    </div>
  )
}

function AnchorValue({ a, ok, behind }: { a: NonNullable<QualityStatus['anchor']>; ok: boolean; behind: number }) {
  const [copied, setCopied] = useState(false)
  return (
    <span className="ql-anchor">
      <span>
        第 <b className="num">{a.seq}</b> 条
      </span>
      <button
        type="button"
        className="ql-hash mono"
        title={`${a.hash}（点击复制）`}
        onClick={() => void navigator.clipboard?.writeText(a.hash).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1600)))}
      >
        {a.hash.slice(0, 10)}…
        {copied ? <Check /> : <Copy />}
      </button>
      {behind > 0 && (
        <span className="ql-behind" title="链尾比锚点多出的条目数">
          <ShieldAlert />落后 {behind}
        </span>
      )}
      {ok && behind === 0 && <Link2 className="ql-linked" aria-label="与链尾一致" />}
    </span>
  )
}
