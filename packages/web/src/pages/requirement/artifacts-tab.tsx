import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Copy, FileCode2, FileJson, FileText, FolderOpen, GitCommitHorizontal, Image as ImageIcon, MessageSquare, Pencil, Send, TriangleAlert, X } from 'lucide-react'
import type { ArtifactEditResponse, ArtifactKind, ArtifactRecord, ArtifactVersion, RequirementDetail, RunDetail } from '@taktflow/core'
import { invalidate, useAsync, useSource } from '../../api'
import { Avatar, EmptyState, ErrorState, Segmented, Skeleton, SkeletonRows, toast } from '../../components/ui'
import { JsonView } from '../../lib/json-view'
import { Markdown } from '../../lib/markdown'
import { actorName, fmtDate, fmtRelative } from '../../lib/format'
import { Link, setQuery, useLocation } from '../../lib/router'
import { ARTIFACT_KIND, ARTIFACT_KIND_ORDER } from '../../lib/status'

function fileIcon(r: ArtifactRecord) {
  if (r.mediaType.startsWith('image/')) return ImageIcon
  if (r.mediaType.includes('json')) return FileJson
  if (r.mediaType.includes('markdown')) return FileText
  return FileCode2
}

const latest = (r: ArtifactRecord) => r.versions[r.versions.length - 1]!

function authorLabel(v: ArtifactVersion) {
  return v.author.type === 'agent' ? v.author.role : actorName(v.author)
}

/**
 * 按 spec 类型分组（docs/design/19 §13）：需求 / 技术 / 测试 / 其他，组内按产物类型的流水线顺序。
 * "其他"兜底：没列在前三组里的类型（review、report、以后新增的 kind）都归到这里，保证每个产物都能看到、计数对得上。
 */
const SPEC_GROUPS: Array<{ id: string; label: string; kinds?: ArtifactKind[] }> = [
  { id: 'req', label: '需求', kinds: ['input', 'clarification', 'spec'] },
  { id: 'tech', label: '技术', kinds: ['design', 'contract', 'task', 'code-change', 'decision'] },
  { id: 'test', label: '测试', kinds: ['test-plan', 'case', 'script', 'evidence', 'verdict', 'defect'] },
  { id: 'other', label: '其他' },
]
const LISTED = new Set(SPEC_GROUPS.flatMap((g) => g.kinds ?? []))
const inGroup = (g: (typeof SPEC_GROUPS)[number], k: ArtifactKind) => (g.kinds ? g.kinds.includes(k) : !LISTED.has(k))
const kindRank = (k: ArtifactKind) => {
  const i = ARTIFACT_KIND_ORDER.indexOf(k)
  return i < 0 ? ARTIFACT_KIND_ORDER.length : i
}

/** "当前阶段产物"：由最近一次流水线运行里当前阶段的节点产出（任一版本）。 */
function currentStagePaths(detail: RequirementDetail, run?: RunDetail): Set<string> | undefined {
  if (!detail.stage || !run) return undefined
  const nodes = new Set(run.graph.nodes.filter((n) => n.stage === detail.stage).map((n) => n.id))
  const runId = run.run.runId
  return new Set(detail.artifacts.filter((r) => r.versions.some((v) => v.producedBy?.runId === runId && nodes.has(v.producedBy.nodeId))).map((r) => r.path))
}

export function ArtifactsTab({ id, detail, run }: { id: string; detail?: RequirementDetail; run?: RunDetail }) {
  const { query } = useLocation()
  const onlyCurrent = query.get('scope') === 'stage'
  const all = detail?.artifacts
  const stagePaths = useMemo(() => (detail ? currentStagePaths(detail, run) : undefined), [detail, run])
  const stageTitle = detail?.stages.find((s) => s.id === detail.stage)?.title
  const records = onlyCurrent && all && stagePaths ? all.filter((r) => stagePaths.has(r.path)) : all
  const selectedPath = query.get('path') ?? records?.find((r) => r.kind === 'spec')?.path ?? records?.[0]?.path
  const groups = useMemo(() => {
    if (!records) return []
    return SPEC_GROUPS.map((g) => ({ ...g, items: records.filter((r) => inGroup(g, r.kind)).sort((a, b) => kindRank(a.kind) - kindRank(b.kind)) })).filter((g) => g.items.length)
  }, [records])
  const scopeSwitch = stagePaths && (
    <div className="art-scope">
      <Segmented<'all' | 'stage'>
        value={onlyCurrent ? 'stage' : 'all'}
        onChange={(v) => setQuery({ scope: v === 'stage' ? 'stage' : undefined, path: undefined, v: undefined })}
        options={[
          { value: 'all', label: `全部 ${all?.length ?? 0}` },
          { value: 'stage', label: `当前阶段 ${stagePaths.size}` },
        ]}
      />
      {stageTitle && <span className="art-scope-stage faint truncate">{stageTitle}</span>}
    </div>
  )

  if (!records)
    return (
      <div className="art-layout">
        <div className="card">
          <SkeletonRows rows={9} gap={12} />
        </div>
        <div className="card" style={{ padding: 24 }}>
          <Skeleton w="40%" h={18} />
          <Skeleton w="90%" h={11} style={{ marginTop: 20 }} />
          <Skeleton w="76%" h={11} style={{ marginTop: 10 }} />
          <Skeleton w="82%" h={11} style={{ marginTop: 10 }} />
        </div>
      </div>
    )
  if (records.length === 0 && onlyCurrent)
    return (
      <div className="art-layout">
        <nav className="card art-list" aria-label="产物列表">
          {scopeSwitch}
        </nav>
        <div className="card">
          <EmptyState icon={FolderOpen} title="当前阶段还没有产物" body={<>{stageTitle ?? '当前阶段'}的节点产出后会出现在这里；切回"全部"可以看之前阶段的产物。</>} />
        </div>
      </div>
    )
  if (records.length === 0)
    return (
      <div className="card">
        <EmptyState
          icon={FolderOpen}
          title="公共存放区还是空的"
          body="PRD、会议纪要、设计稿放进来以后，所有 Agent 都从这里取。把文件发到群聊，或者交给管家整理进来。"
          action={<Link to={`/req/${id}?tab=chat`} className="btn btn-sm">去群聊发文件</Link>}
          stewardAsk={`帮我把这个需求的 PRD 放进 ${id} 的公共存放区：`}
          stewardContext={[{ type: 'requirement', id, label: id }]}
        />
      </div>
    )
  const selected = records.find((r) => r.path === selectedPath) ?? records[0]!
  return (
    <div className="art-layout">
      <nav className="card art-list" aria-label="产物列表">
        {scopeSwitch}
        {groups.map((g) => (
          <div key={g.id} className="art-group">
            <div className="art-group-head">
              <span>{g.label}</span>
              <span className="num">{g.items.length}</span>
            </div>
            {g.items.map((r) => {
              const Icon = fileIcon(r)
              const v = latest(r)
              return (
                <button key={r.path} className={`art-item${r.path === selected.path ? ' active' : ''}`} onClick={() => setQuery({ path: r.path, v: undefined })}>
                  <Icon className="art-item-icon" />
                  <span className="art-item-text">
                    <span className="art-item-title truncate">{r.title ?? r.path.split('/').pop()}</span>
                    <span className="art-item-path truncate">
                      {r.title !== ARTIFACT_KIND[r.kind] && <span className="art-item-kind">{ARTIFACT_KIND[r.kind]}</span>}
                      <span className="mono">{r.path}</span>
                    </span>
                  </span>
                  <span className={`art-ver mono${r.versions.length > 1 ? ' multi' : ''}`}>v{v.version}</span>
                </button>
              )
            })}
          </div>
        ))}
      </nav>
      <ArtifactPreview key={selected.path} reqId={id} record={selected} />
    </div>
  )
}

function VersionMenu({ record, version, onPick }: { record: ArtifactRecord; version: number; onPick: (v: number) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  const isLatest = version === latest(record).version
  return (
    <div className="ver-menu" ref={ref}>
      <button className="btn btn-sm" onClick={() => setOpen((o) => !o)}>
        <GitCommitHorizontal />
        <span className="mono">v{version}</span>
        <span className="faint">{isLatest ? '最新' : `共 ${record.versions.length} 版`}</span>
        <ChevronDown />
      </button>
      {open && (
        <div className="ver-pop fade-in">
          <div className="ver-pop-head">版本历史 · {record.versions.length}</div>
          {[...record.versions].reverse().map((v) => (
            <button key={v.version} className={`ver-row${v.version === version ? ' on' : ''}`} onClick={() => (onPick(v.version), setOpen(false))}>
              <span className="ver-row-v mono">v{v.version}</span>
              <span className="ver-row-body">
                <span className="ver-row-top">
                  <span className={`ver-author ${v.author.type}`}>{authorLabel(v)}</span>
                  <span className="faint">{fmtDate(v.createdAt)}</span>
                </span>
                <span className="ver-row-reason">{v.reason ?? '—'}</span>
                {v.producedBy && <span className="ver-row-node mono">{v.producedBy.nodeId}</span>}
              </span>
              {v.version === version && <Check className="ver-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ArtifactPreview({ reqId, record }: { reqId: string; record: ArtifactRecord }) {
  const ds = useSource()
  const { query } = useLocation()
  const version = Number(query.get('v')) || latest(record).version
  const ver = record.versions.find((v) => v.version === version) ?? latest(record)
  const content = useAsync((s) => s.artifact(reqId, record.path, ver.version), [reqId, record.path, ver.version])
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [reason, setReason] = useState('')
  const [impact, setImpact] = useState<'semantic' | 'cosmetic'>('semantic')
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<ArtifactEditResponse | null>(null)
  const image = record.mediaType.startsWith('image/')

  function startEdit() {
    setDraft(content.data?.content ?? '')
    setReason('')
    setImpact('semantic')
    setEditing(true)
    setResult(null)
  }
  async function save() {
    setSaving(true)
    try {
      const res = await ds.editArtifact(reqId, record.path, { content: draft, reason: reason.trim(), impact })
      setResult(res)
      setEditing(false)
      setQuery({ v: undefined })
      toast(`已保存为 v${res.version}`, { body: res.staleNodes.length ? `${res.staleNodes.length} 个节点因此过期，需要重跑。` : '没有节点读过这个产物。', tone: res.staleNodes.length ? 'stale' : 'success' })
      invalidate()
    } catch (e) {
      toast('保存失败', { body: (e as Error).message, tone: 'failed' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="card art-preview">
      <div className="art-head">
        <div className="art-head-main">
          <div className="art-head-title">
            <span className="truncate">{record.title ?? record.path}</span>
            <span className="chip">{ARTIFACT_KIND[record.kind]}</span>
            {record.tags.map((t) => (
              <span key={t} className="chip art-tag">
                {t}
              </span>
            ))}
          </div>
          <button className="art-path mono" title="复制路径" onClick={() => void navigator.clipboard?.writeText(record.path).then(() => toast('已复制路径', { body: record.path }))}>
            {record.path}
            <Copy />
          </button>
        </div>
        <div className="art-head-actions">
          <VersionMenu record={record} version={ver.version} onPick={(v) => setQuery({ v: v === latest(record).version ? undefined : String(v) })} />
          {!image && !editing && (
            <button className="btn btn-sm" onClick={startEdit} disabled={!content.data}>
              <Pencil />
              编辑
            </button>
          )}
        </div>
      </div>

      <div className="art-meta">
        <span className="art-meta-item">
          <Avatar name={authorLabel(ver)} size={16} />
          <b>{authorLabel(ver)}</b>
          {ver.author.type === 'agent' && <span className="faint mono">{ver.author.harness}</span>}
        </span>
        <span className="art-meta-item" title={ver.createdAt}>
          {fmtRelative(ver.createdAt)}
        </span>
        {ver.reason && <span className="art-meta-item art-reason">“{ver.reason}”</span>}
        {ver.producedBy && (
          <Link className="art-meta-item art-node mono" to={`/run/${ver.producedBy.runId}?node=${encodeURIComponent(ver.producedBy.nodeId)}`}>
            ← {ver.producedBy.nodeId}
          </Link>
        )}
        <span style={{ flex: 1 }} />
        <span className="art-meta-item mono faint" title={ver.sha256}>
          sha {ver.sha256.slice(0, 10)}
        </span>
        <span className="art-meta-item mono faint">{ver.size < 1024 ? `${ver.size} B` : `${(ver.size / 1024).toFixed(1)} KB`}</span>
      </div>
      {ver.derivedFrom.length > 0 && (
        <div className="art-derived">
          <span className="faint">溯源</span>
          {ver.derivedFrom.map((d) => (
            <button key={`${d.path}@${d.version}`} className="chip mono" onClick={() => setQuery({ path: d.path, v: d.version ? String(d.version) : undefined })}>
              {d.path}
              {d.version ? `@v${d.version}` : ''}
            </button>
          ))}
        </div>
      )}

      {result && (
        <div className={`callout ${result.staleNodes.length ? 'stale' : 'ok'} fade-in`}>
          {result.staleNodes.length ? <TriangleAlert /> : <Check />}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="callout-title">
              已保存为 v{result.version}
              {result.staleNodes.length ? ` · ${result.staleNodes.length} 个节点读过旧版本，已标记为过期` : ' · 没有节点受影响'}
            </div>
            {result.staleNodes.length > 0 && (
              <div className="callout-chips">
                {result.staleNodes.map((n) => (
                  <Link key={`${n.runId}/${n.nodeId}`} to={`/run/${n.runId}?node=${encodeURIComponent(n.nodeId)}`} className="chip mono stale-chip">
                    {n.nodeId}
                  </Link>
                ))}
              </div>
            )}
          </div>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setResult(null)} aria-label="关闭">
            <X />
          </button>
        </div>
      )}

      <div className="art-body">
        {editing ? (
          <div className="art-editor">
            <textarea className="textarea mono" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
            <div className="art-editor-foot">
              <Segmented<'semantic' | 'cosmetic'>
                value={impact}
                onChange={setImpact}
                options={[
                  { value: 'semantic', label: '语义修改' },
                  { value: 'cosmetic', label: '措辞调整' },
                ]}
              />
              <input className="input" placeholder="修改原因（必填，进审计日志）" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
              <button className="btn" onClick={() => setEditing(false)}>
                取消
              </button>
              <button className="btn btn-primary" disabled={saving || !reason.trim() || draft === content.data?.content} onClick={save}>
                保存为 v{latest(record).version + 1}
              </button>
            </div>
            <div className="art-editor-hint faint">
              {impact === 'semantic' ? '保存后，读过这个产物的节点及其下游会被标记为"过期"，由你决定是否重跑。' : '措辞调整只改表述、不改含义：下游节点不会过期，但已有审批会提示"审批对象已更新"。'}
            </div>
          </div>
        ) : content.error ? (
          <ErrorState error={content.error} onRetry={content.reload} />
        ) : !content.data ? (
          <div style={{ display: 'grid', gap: 10 }}>
            <Skeleton w="45%" h={18} />
            <Skeleton w="92%" h={11} style={{ marginTop: 8 }} />
            <Skeleton w="80%" h={11} />
            <Skeleton w="86%" h={11} />
          </div>
        ) : image ? (
          <div className="art-image">
            <img alt={record.title ?? record.path} src={`data:${content.data.mediaType};base64,${content.data.content}`} />
          </div>
        ) : record.mediaType.includes('json') ? (
          <JsonView source={content.data.content} />
        ) : record.mediaType.includes('markdown') ? (
          <Markdown source={content.data.content} />
        ) : (
          <pre className="json-view">{content.data.content}</pre>
        )}
      </div>
      <Comments reqId={reqId} path={record.path} version={ver.version} />
    </section>
  )
}

function Comments({ reqId, path, version }: { reqId: string; path: string; version: number }) {
  const ds = useSource()
  const q = useAsync((s) => s.comments(reqId, path), [reqId, path])
  const [text, setText] = useState('')
  async function add() {
    if (!text.trim()) return
    await ds.addComment(reqId, { path, version, body: text.trim() })
    setText('')
    q.reload()
  }
  return (
    <div className="art-comments">
      <div className="art-comments-head">
        <MessageSquare />
        评论
        <span className="faint num">{q.data?.length ?? 0}</span>
      </div>
      {q.data?.map((c) => (
        <div key={c.id} className={`comment${c.resolved ? ' resolved' : ''}`}>
          <Avatar name={actorName(c.author)} size={22} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="comment-head">
              <b>{actorName(c.author)}</b>
              <span className="chip mono">v{c.version}</span>
              {c.resolved && <span className="chip">已解决</span>}
              <span className="faint">{fmtRelative(c.createdAt)}</span>
            </div>
            <div className="comment-body">{c.body}</div>
          </div>
        </div>
      ))}
      <div className="comment-new">
        <input className="input" placeholder={`评论 v${version}…`} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void add()} />
        <button className="btn btn-icon" disabled={!text.trim()} onClick={() => void add()} aria-label="发送">
          <Send />
        </button>
      </div>
    </div>
  )
}
