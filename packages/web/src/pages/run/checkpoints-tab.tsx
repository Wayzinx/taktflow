import { useState, type CSSProperties } from 'react'
import { AlertTriangle, Ban, Check, ChevronRight, CircleDashed, Clock, FileLock2, FlaskConical, Gavel, HardDrive, Hourglass, Lock, LockOpen, Minus, PenLine, Route, ScanSearch, ShieldCheck, Terminal, UserCheck, X } from 'lucide-react'
import type { CheckpointDetail, CheckpointRole, Invocation, NodeDetail, ResolvedValue, SnapshotManifest } from '@taktflow/core'
import { invalidate, useAsync, useSource } from '../../api'
import { EmptyState, ErrorState, ReasonDialog, Skeleton, toast } from '../../components/ui'
import { fmtDuration, fmtTokens, totalTokens } from '../../lib/format'
import { Markdown } from '../../lib/markdown'
import { navigate } from '../../lib/router'
import { IssueKey } from './review/issue-ledger'
import './checkpoints.css'

/**
 * 节点抽屉 · 检查点（docs/design/21 §1–2）：每个评审者 / 作者修改 / 裁决者 / 门禁检查项一行；
 * 展开看只读快照（给了哪些版本、怎么保证只读）、调用身份三层取值（请求 → 解析 → 回报 → 是否生效）与职责清单。
 * 不确定的值写"未知"，不拿请求值冒充实际值。
 */

const ROLE: Record<CheckpointRole, { label: string; icon: typeof Check }> = {
  producer: { label: '产出', icon: PenLine },
  author: { label: '作者修改', icon: PenLine },
  reviewer: { label: '评审者', icon: ScanSearch },
  arbiter: { label: '裁决者', icon: Gavel },
  rubric: { label: 'rubric 检查', icon: ShieldCheck },
  acceptance: { label: '验收检查', icon: UserCheck },
  command: { label: '命令检查', icon: Terminal },
  judge: { label: '判决', icon: Gavel },
  planner: { label: '规划', icon: Route },
  auditor: { label: '归因', icon: ScanSearch },
  evaluator: { label: '评测', icon: ScanSearch },
}

const STATUS: Record<CheckpointDetail['status'], { label: string; icon: typeof Check; cls: string }> = {
  done: { label: '完成', icon: Check, cls: 'done' },
  error: { label: '出错', icon: AlertTriangle, cls: 'error' },
  skipped: { label: '没执行', icon: Ban, cls: 'skipped' },
  scheduled: { label: '排队中', icon: Hourglass, cls: 'scheduled' },
}

const READONLY: Record<SnapshotManifest['readOnly'], { label: string; hint: string; icon: typeof Lock; cls: string }> = {
  sandbox: { label: '沙箱只读挂载', hint: '快照目录以只读方式挂进沙箱，评审时改不了', icon: Lock, cls: 'ok' },
  permissions: { label: '文件权限只读', hint: '快照文件设成只读权限；同一用户仍可能改回权限', icon: FileLock2, cls: 'mid' },
  none: { label: '没能保证只读', hint: '这次没有沙箱也改不了权限：归因只能说"提供了这些版本"，不能说"评审时没被改过"', icon: LockOpen, cls: 'warn' },
}

const VERDICT: Record<string, string> = { approve: '同意', request_changes: '要求修改', reject: '否决', comment: '仅评论' }

function groupOf(c: CheckpointDetail): string {
  return c.revision !== undefined && c.round !== undefined ? `修订 ${c.revision} · 第 ${c.round} 轮` : `第 ${c.attempt} 次执行`
}

export function CheckpointsTab({ d, runId }: { d: NodeDetail; runId: string }) {
  const cps = d.checkpoints ?? []
  const [open, setOpen] = useState<string | undefined>(() => cps.find((c) => c.status === 'error' || c.status === 'skipped')?.id)
  if (!cps.length) return <div className="dpad"><EmptyState compact icon={ScanSearch} title="没有检查点" body="评审、门禁与判决节点执行后，每一次判断都会在这里留下身份与快照。" /></div>
  const groups = [...new Set(cps.map(groupOf))].map((g) => ({ g, items: cps.filter((c) => groupOf(c) === g) }))
  const count = (st: CheckpointDetail['status']) => cps.filter((c) => c.status === st).length
  const invs = new Map((d.invocations ?? []).map((v) => [v.id, v]))
  return (
    <div className="dpad cp">
      <div className="cp-sum">
        <b className="num">{cps.length}</b> 个检查点
        {(['done', 'error', 'skipped', 'scheduled'] as const).filter((s) => count(s)).map((s) => {
          const m = STATUS[s]
          return (
            <span key={s} className={`cp-sum-item cp-${m.cls}`}>
              <m.icon />
              {m.label} <b className="num">{count(s)}</b>
            </span>
          )
        })}
      </div>
      {groups.map(({ g, items }) => (
        <section key={g} className="cp-group">
          <h4 className="cp-group-title">{g}</h4>
          <ul className="cp-list">
            {items.map((c, i) => (
              <CheckpointRow key={c.id} c={c} i={i} d={d} runId={runId} invs={c.invocations.map((id) => invs.get(id)).filter((v): v is Invocation => Boolean(v))} open={open === c.id} onToggle={() => setOpen(open === c.id ? undefined : c.id)} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function CheckpointRow({ c, i, d, runId, invs, open, onToggle }: { c: CheckpointDetail; i: number; d: NodeDetail; runId: string; invs: Invocation[]; open: boolean; onToggle: () => void }) {
  const role = ROLE[c.role]
  const st = STATUS[c.status]
  const ms = c.endedAt ? Date.parse(c.endedAt) - Date.parse(c.scheduledAt) : undefined
  const gate = c.gate?.status
  return (
    <li className={`cp-row cp-${st.cls}${open ? ' open' : ''}`} style={{ '--i': i } as CSSProperties}>
      <button type="button" className="cp-head" onClick={onToggle} aria-expanded={open}>
        <ChevronRight className="cp-caret" />
        <span className={`cp-st cp-${st.cls}`} title={st.label}>
          <st.icon />
        </span>
        <role.icon className="cp-role-ic" />
        <span className="cp-role">{role.label}</span>
        <span className="mono cp-subject truncate">{c.subject}</span>
        <span style={{ flex: 1 }} />
        {c.record && <span className={`cp-verdict v-${c.record.verdict}`}>{VERDICT[c.record.verdict] ?? c.record.verdict}{c.record.issues.length ? ` · ${c.record.issues.length} 个问题` : ''}</span>}
        {gate && <GateState s={gate} />}
        {c.snapshot?.readOnly === 'none' && <LockOpen className="cp-ro-warn" aria-label="没能保证只读" />}
        {ms !== undefined && <span className="mono num faint cp-ms">{fmtDuration(ms)}</span>}
      </button>
      {open && (
        <div className="cp-body">
          {c.error && (
            <p className={`cp-err cp-${st.cls}`}>
              {c.status === 'skipped' ? <Ban /> : <AlertTriangle />}
              {c.error}
            </p>
          )}
          {c.gate?.message && c.status !== 'error' && <p className="cp-gate-msg">{c.gate.message}{c.gate.score !== undefined && <b className="mono num"> · {c.gate.score}</b>}</p>}
          {c.snapshot && <SnapshotBlock m={c.snapshot} runId={runId} />}
          {invs.map((v) => <InvocationBlock key={v.id} v={v} />)}
          {c.status !== 'done' && !invs.length && c.status !== 'error' && <p className="faint cp-none">没有发起调用。</p>}
          {c.record?.checklist && <Checklist c={c} />}
          {!c.record?.checklist && c.duties && c.duties.length > 0 && (
            <div className="cp-sec">
              <div className="cp-sec-title">职责条目</div>
              <ul className="cp-duties">
                {c.duties.map((x) => <li key={x}>{x}</li>)}
              </ul>
            </div>
          )}
          <div className="cp-foot">
            <p className="cp-id mono faint" title="检查点身份：运行 : 节点 : 第几次执行 : 修订.轮 : 评审者或检查项">{c.id}</p>
            {cleanReady(c) && <CleanSample c={c} />}
          </div>
        </div>
      )}
      {d.state.status === 'running' && c.status === 'scheduled' && <span className="cp-live" aria-hidden />}
    </li>
  )
}

/** 与后端同口径：完成的评审者调用、有快照、没有 blocker / major，才能设为无缺陷样本。 */
const cleanReady = (c: CheckpointDetail) => c.role === 'reviewer' && c.status === 'done' && Boolean(c.snapshot) && Boolean(c.record) && !c.record!.issues.some((i) => i.severity === 'blocker' || i.severity === 'major')

/** 无缺陷样本（docs/design/21 §6）：人确认这次评审确实没漏，之后回放时提出 blocker / major 记误报。 */
function CleanSample({ c }: { c: CheckpointDetail }) {
  const ds = useSource()
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="btn btn-xs btn-ghost" onClick={() => setOpen(true)} title="把这次评审调用设为无缺陷负样本">
        <FlaskConical />
        设为无缺陷样本
      </button>
      <ReasonDialog
        open={open}
        onClose={() => setOpen(false)}
        title="设为无缺陷样本（clean）"
        description={`绑定 ${c.subject} 这次评审当时的快照。你确认被评审的内容没有 blocker / major 问题；之后回放这个检查点时，提出 blocker / major 就记一次误报。`}
        confirmLabel="设为样本"
        onSubmit={async (reason) => {
          const s = await ds.createEvalSample({ kind: 'clean', checkpointId: c.id, reason })
          invalidate()
          toast(`已生成样本 ${s.id}`, { body: '在评测页的样本列表里，可以拿它检查改动会不会带来误报。', tone: 'success', action: { label: '去评测页', onClick: () => navigate('/eval?tab=cases') } })
        }}
      />
    </>
  )
}

function GateState({ s }: { s: 'pass' | 'fail' | 'error' }) {
  const m = s === 'pass' ? { label: '通过', icon: Check } : s === 'fail' ? { label: '不通过', icon: X } : { label: '检查出错', icon: AlertTriangle }
  return (
    <span className={`cp-gate g-${s}`} title={s === 'error' ? '检查本身出错（起不来 / 超时 / 解析失败）：是流程问题，不算产物有缺陷' : undefined}>
      <m.icon />
      {m.label}
    </span>
  )
}

function SnapshotBlock({ m, runId }: { m: SnapshotManifest; runId: string }) {
  const ro = READONLY[m.readOnly]
  const [file, setFile] = useState<string>()
  return (
    <div className="cp-sec">
      <div className="cp-sec-title">
        快照
        <span className={`cp-ro ro-${ro.cls}`} title={ro.hint}>
          <ro.icon />
          {ro.label}
        </span>
      </div>
      {m.readOnly === 'none' && <p className="cp-ro-note">{ro.hint}</p>}
      <ul className="cp-files">
        {m.files.map((f) => (
          <li key={f.path}>
            <button type="button" className={`cp-file${file === f.path ? ' on' : ''}`} onClick={() => setFile(file === f.path ? undefined : f.path)}>
              <span className={`cp-frole r-${f.role}`}>{f.role === 'target' ? '评审对象' : '比较依据'}</span>
              <span className="mono truncate">{f.ref?.path ?? f.path}</span>
              <span className="mono faint cp-fver">
                {f.source === 'artifact' ? `v${f.ref?.version ?? '?'}` : f.source === 'diff' ? `diff @ ${f.commit ?? '?'}` : `${f.repo ?? ''}@${f.commit ?? '?'}`}
              </span>
              <span className="mono faint" title={`sha256 ${f.sha256}`}>{f.sha256.slice(0, 8)}</span>
            </button>
            {file === f.path && <SnapshotFile runId={runId} checkpointId={m.checkpointId} path={f.path} />}
          </li>
        ))}
      </ul>
      <p className="cp-dir mono faint">
        <HardDrive />
        .takt/{m.dir}
      </p>
    </div>
  )
}

function SnapshotFile({ runId, checkpointId, path }: { runId: string; checkpointId: string; path: string }) {
  const q = useAsync((s) => s.snapshotFile(runId, checkpointId, path), [runId, checkpointId, path])
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />
  if (!q.data) return <Skeleton h={80} />
  const md = q.data.mediaType.includes('markdown')
  return <div className="cp-file-view">{md ? <Markdown source={q.data.content} /> : <pre className="mono">{q.data.content}</pre>}</div>
}

function Layer({ v }: { v?: string }) {
  return v ? <span className="mono">{v}</span> : <span className="cp-unknown">未知</span>
}

function ResolvedRow({ label, r }: { label: string; r: ResolvedValue<string> }) {
  const differ = r.reported && r.resolved && r.reported !== r.resolved && !r.reported.startsWith(r.resolved.replace(/\./g, '-'))
  return (
    <tr className={differ ? 'is-differ' : undefined}>
      <th>{label}</th>
      <td><Layer v={r.requested} /></td>
      <td><Layer v={r.resolved} /></td>
      <td><Layer v={r.reported} /></td>
      <td>
        {r.applied === true ? <span className="cp-yes"><Check />生效</span> : r.applied === false ? <span className="cp-no" title="适配器不支持覆盖：实际用的是 harness 自己的默认值"><Minus />未覆盖</span> : <span className="cp-unknown" title="harness 没声明能否覆盖，也没回报实际值">未知</span>}
      </td>
    </tr>
  )
}

function InvocationBlock({ v }: { v: Invocation }) {
  const live = v.outcome === undefined
  return (
    <div className="cp-sec">
      <div className="cp-sec-title">
        调用身份
        <span className="mono faint">{v.harness}{v.fallbackIndex ? ` · fallback ${v.fallbackIndex}` : ''}</span>
        <span style={{ flex: 1 }} />
        {live ? <span className="cp-inv-live"><Clock />进行中</span> : v.outcome === 'ok' ? <span className="faint mono num">{fmtDuration(v.durationMs ?? 0)} · {fmtTokens(totalTokens(v.usage))} token</span> : <span className="cp-no"><X />{v.outcome === 'error' ? '出错' : '已取消'}</span>}
      </div>
      <table className="cp-layers">
        <thead>
          <tr>
            <th />
            <th>配方请求</th>
            <th>引擎解析</th>
            <th>harness 回报</th>
            <th>是否生效</th>
          </tr>
        </thead>
        <tbody>
          <ResolvedRow label="模型" r={v.model} />
          <ResolvedRow label="effort" r={v.effort} />
        </tbody>
      </table>
      {v.skills.length > 0 && (
        <ul className="cp-skills">
          {v.skills.map((s) => (
            <li key={s.name} title={s.confirmed === 'yes' ? 'harness 回报的技能清单里有它' : s.confirmed === 'no' ? 'harness 回报的技能清单里没有它' : 'harness 没回报技能清单，无法确认是否加载'}>
              <span className="mono">{s.name}</span>
              {s.providedHash && <span className="mono faint">#{s.providedHash.slice(0, 8)}</span>}
              <span className={`cp-skill c-${s.confirmed}`}>{s.confirmed === 'yes' ? <><Check />已加载</> : s.confirmed === 'no' ? <><X />未加载</> : <><CircleDashed />未知</>}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Checklist({ c }: { c: CheckpointDetail }) {
  const rec = c.record!
  const keyOf = (id: string) => rec.issues.find((i) => i.id === id)?.key ?? id
  return (
    <div className="cp-sec">
      <div className="cp-sec-title">职责清单</div>
      <ul className="cp-check">
        {rec.checklist!.map((x) => (
          <li key={x.item} className={`k-${x.status}`}>
            <span className="cp-check-ic">{x.status === 'ok' ? <Check /> : x.status === 'issue' ? <AlertTriangle /> : <Minus />}</span>
            <span className="cp-check-item">{x.item}</span>
            <span style={{ flex: 1 }} />
            {x.issues?.map((id) => <IssueKey key={id} k={keyOf(id)} />)}
            {x.note && <span className="faint cp-check-note">{x.note}</span>}
            {x.status === 'na' && !x.note && <span className="faint">不适用</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}
