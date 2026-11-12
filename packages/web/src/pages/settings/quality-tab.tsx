import { useState, type CSSProperties, type ReactNode } from 'react'
import { Anchor, ArrowUpRight, Check, Copy, History, Link2, Link2Off, RefreshCw, ShieldAlert, ShieldCheck, ShieldQuestion, Wrench } from 'lucide-react'
import type { QualityStatus } from '@taktflow/core'
import { invalidate, useAsync, useSource } from '../../api'
import { EmptyState, ErrorState, ReasonDialog, SkeletonRows, toast } from '../../components/ui'
import { fmtDate, fmtRelative } from '../../lib/format'
import { Link } from '../../lib/router'
import { cursorState, fmtCount } from './quality-meta'
import { ReadOnlyNote, useAccess } from './access'
import './quality.css'

type Pending = { kind: 'repair' } | { kind: 'sync'; runId?: string }

/**
 * 质量日志（docs/design/21 §7）：缺陷、归因、样本、评测的唯一权威记录，复用事件存储的哈希链与链尾锚点。
 * - 链完整、锚点最新：只展示；
 * - 链完整、锚点落后：给"修复锚点"（只补锚点并记恢复，需原因）；
 * - 链被篡改或截断：红色警告与处理说明，不提供修复按钮，交给人核对。
 * 各运行的入账进度与上次同步时间；可以补算（需原因）。游标、幂等键这些实现细节收在"技术细节"里。
 */
export function QualityTab() {
  const ds = useSource()
  const access = useAccess('member', '补算和修复质量日志')
  const q = useAsync((d) => d.qualityStatus(), [])
  const runs = useAsync((d) => d.runs().catch(() => []), [])
  const [pending, setPending] = useState<Pending>()
  const [checking, setChecking] = useState(false)
  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={q.reload} />
  const s = q.data
  if (!s) return <SkeletonRows rows={4} />
  const reqOf = (runId: string) => runs.data?.find((r) => r.runId === runId)?.requirementId
  const cursors = Object.entries(s.cursors).sort((a, b) => b[0].localeCompare(a[0]))
  const verify = async () => {
    setChecking(true)
    try {
      const next = await ds.qualityStatus()
      q.reload()
      toast(next.ok ? (next.anchorBehind ? '链完整，锚点落后' : '校验通过') : '哈希链对不上', { tone: next.ok ? 'success' : 'failed', body: `从头核对了 ${fmtCount(next.entries)} 条记录的哈希。` })
    } catch (e) {
      toast('校验没跑完', { tone: 'failed', body: (e as Error).message })
    } finally {
      setChecking(false)
    }
  }
  return (
    <div className="ql">
      <ReadOnlyNote why={access.why} block />
      <Hero s={s} onRepair={access.ok ? () => setPending({ kind: 'repair' }) : undefined} onVerify={() => void verify()} checking={checking} />
      <div className="card ql-stats">
        <Stat label="条目" value={<span className="num">{fmtCount(s.entries)}</span>} />
        <Stat
          label="锚点"
          value={s.anchor ? <AnchorValue a={s.anchor} ok={s.ok} behind={s.anchorBehind ? s.entries - s.anchor.seq : 0} /> : <span className="faint">还没有锚点</span>}
        />
        <Stat label="上次同步" value={s.lastSyncAt ? <span title={fmtDate(s.lastSyncAt)}>{fmtRelative(s.lastSyncAt)}</span> : <span className="faint">还没同步过</span>} />
        <Stat
          label="旧缺陷文件导入"
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
          hint={s.importedM3 ? '以前存成 defects/*.md 的缺陷已经导入日志（重复导入不会重复记），缺陷页显示的是从日志生成的视图' : '第一次打开质量数据时会自动导入，不用手动处理'}
        />
      </div>
      <div className="card">
        <div className="card-head">
          <span className="card-title">各运行的入账进度</span>
          <span className="faint ql-hint">运行的事件会自动写进质量日志；一般不用管，入账中断过才需要补算</span>
          <span className="spacer" />
          <button type="button" className="btn btn-sm" disabled={!s.ok || !access.ok} title={s.ok ? '把所有运行里还没写进日志的事件补进去，已入账的自动跳过' : '链被篡改时暂停入账'} onClick={() => setPending({ kind: 'sync' })}>
            <RefreshCw />
            全部补算
          </button>
        </div>
        {cursors.length === 0 ? (
          <EmptyState compact icon={History} title="还没有运行入账" body="运行事件会自动同步到质量日志，无需手动处理。" />
        ) : (
          <ul className="ql-cursors">
            {cursors.map(([runId, seq], i) => {
              const req = reqOf(runId)
              const c = cursorState(seq, s.lastSeq?.[runId])
              return (
                <li key={runId} style={{ '--i': i } as CSSProperties}>
                  <Link to={`/run/${runId}`} className="mono ql-run">
                    {runId}
                    <ArrowUpRight />
                  </Link>
                  {req ? <span className="mono faint">{req}</span> : <span />}
                  <span className={`ql-seq num${c.behind ? ' is-behind' : ''}`}>{c.text}</span>
                  {c.canSync ? (
                    <button type="button" className="btn btn-xs btn-ghost" disabled={!s.ok || !access.ok} title="把这个运行还没写进日志的事件补进去" onClick={() => setPending({ kind: 'sync', runId })}>
                      补算
                    </button>
                  ) : (
                    <span />
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
      <details className="faint ql-foot ql-tech">
        <summary>技术细节</summary>
        <ul>
          <li>入账进度就是每个运行的"游标"：事件写进日志成功后才往前推；进程中断后从游标处重放，靠幂等键去重，不会重复记。</li>
          <li>
            日志在 <span className="mono">.takt/quality/log.jsonl</span>；缺陷、归因、样本、评测运行都是从它重建的视图（<span className="mono">.takt/quality/views/</span>），可以删了重建。
          </li>
        </ul>
      </details>
      <ReasonDialog
        open={Boolean(pending)}
        onClose={() => setPending(undefined)}
        title={pending?.kind === 'repair' ? '修复锚点？' : pending?.runId ? `补算 ${pending.runId}？` : '全部补算？'}
        description={
          pending?.kind === 'repair'
            ? '只把锚点补到链尾，并记一条恢复记录；不改任何日志内容。链被篡改或截断时会被拒绝。'
            : '从上次入账的位置往后，把还没写进质量日志的事件补进去；已入账的自动跳过，不会重复记，也不改运行本身。事件多时可能要等几十秒。'
        }
        confirmLabel={pending?.kind === 'repair' ? '修复锚点' : '补算'}
        onSubmit={async (reason) => {
          if (!pending) return
          const next = pending.kind === 'repair' ? await ds.repairQuality(reason) : await ds.syncQuality({ runId: pending.runId, reason })
          invalidate()
          toast(pending.kind === 'repair' ? '锚点已修复' : '已补算', { body: `日志共 ${fmtCount(next.entries)} 条${next.anchor ? `，锚点在第 ${fmtCount(next.anchor.seq)} 条` : ''}`, tone: 'success' })
        }}
      />
    </div>
  )
}

function Hero({ s, onRepair, onVerify, checking }: { s: QualityStatus; onRepair?: () => void; onVerify: () => void; checking: boolean }) {
  const verify = (
    <button type="button" className="btn btn-sm" onClick={onVerify} disabled={checking} title="从头核对每条记录的哈希和链尾锚点">
      <ShieldQuestion />
      {checking ? '校验中…' : '重新校验'}
    </button>
  )
  if (!s.ok)
    return (
      <div className="card ql-hero is-broken" role="alert">
        <span className="ql-hero-ic">
          <Link2Off />
        </span>
        <div className="ql-hero-main">
          <b className="ql-hero-title">日志完整性校验未通过{s.brokenAt !== undefined && <span className="num">（从第 {fmtCount(s.brokenAt)} 条起对不上）</span>}</b>
          <p>有记录被改过、删过或文件不完整。系统已暂停入账，请联系空间管理员核对记录。</p>
          <ol className="ql-steps">
            <li>保留现有记录，避免继续修改日志。</li>
            <li>点击「重新校验」确认问题位置，把结果交给空间管理员与备份核对。</li>
            <li>恢复前，缺陷、归因和评测结论需要重新核实。</li>
          </ol>
        </div>
        {verify}
      </div>
    )
  if (s.anchorBehind)
    return (
      <div className="card ql-hero is-behind">
        <span className="ql-hero-ic">
          <Anchor />
        </span>
        <div className="ql-hero-main">
          <b className="ql-hero-title">日志完整，校验标记落后{s.anchor && <span className="num"> {fmtCount(s.entries - s.anchor.seq)} 条</span>}</b>
          <p>最新写入的记录还没有更新校验标记（锚点）。日志内容完整；点击「修复锚点」可以补齐标记。</p>
        </div>
        <span className="ql-hero-acts">
          {verify}
          {onRepair && <button type="button" className="btn btn-sm btn-primary" onClick={onRepair}>
            <Wrench />
            修复锚点
          </button>}
        </span>
      </div>
    )
  return (
    <div className="card ql-hero is-ok">
      <span className="ql-hero-ic">
        <ShieldCheck />
      </span>
      <div className="ql-hero-main">
        <b className="ql-hero-title">日志健康，无需处理</b>
        <p>记录完整，校验标记与最新记录一致。</p>
      </div>
      {verify}
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
        第 <b className="num">{fmtCount(a.seq)}</b> 条
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
          <ShieldAlert />落后 {fmtCount(behind)}
        </span>
      )}
      {ok && behind === 0 && <Link2 className="ql-linked" aria-label="与链尾一致" />}
    </span>
  )
}
