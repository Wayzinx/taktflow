import { useState } from 'react'
import type { KnowledgeBaseDetail } from '@taktflow/core'
import { FileText, Folder, FolderGit2, Globe, Plus, RefreshCw, Trash2, Upload } from 'lucide-react'
import { useAsync, useSource } from '../../api'
import { EmptyState, ErrorState, Segmented, SkeletonRows, toast, useFlashRows, useStagger } from '../../components/ui'
import { fmtRelative } from '../../lib/format'
import { setQuery } from '../../lib/router'
import { Dropzone, ListInput, type PendingFile } from './fields'
import { autoReason } from './meta'

/** rag 数据源，字段同服务端 kinds/documents.ts：type = upload / path / repo / url。 */
type Src = { type?: string; repo?: string; path?: string; glob?: string | string[]; urls?: string[] }
type SrcType = 'repo' | 'path' | 'url' | 'upload'
const SRC_ICON = { upload: Upload, repo: FolderGit2, path: Folder, url: Globe } as Record<string, typeof Upload>
const srcText = (s: Src) =>
  s.type === 'repo' ? `仓库 ${s.repo ?? '?'}${s.glob ? ` · ${String(s.glob)}` : ''}` : s.type === 'path' ? `目录 ${s.path ?? '.'}` : s.type === 'url' ? `${s.urls?.length ?? 0} 个 URL` : '上传的文件'

/** 非 rag 类型的数据源只读展示：键值对，密钥只显示引用。 */
function ConfigSummary({ config }: { config: Record<string, unknown> }) {
  const rows = Object.entries(config).filter(([, v]) => v !== undefined && v !== '')
  return (
    <dl className="kb-kv">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd className="mono">{Array.isArray(v) ? (v.length ? v.join('、') : '（全部）') : typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
        </div>
      ))}
    </dl>
  )
}

export function SourcesTab({ base, reload }: { base: KnowledgeBaseDetail; reload: () => void }) {
  const ds = useSource()
  const docs = useAsync((d) => d.knowledgeDocs(base.id), [base.id])
  const st = useStagger(docs.data?.length ?? 0)
  const flash = useFlashRows((docs.data ?? []).map((d) => d.path))
  const [adding, setAdding] = useState(false)
  const [kind, setKind] = useState<SrcType>('repo')
  const [repo, setRepo] = useState('')
  const [dir, setDir] = useState('docs')
  const [urls, setUrls] = useState<string[]>([])
  const [files, setFiles] = useState<PendingFile[]>([])
  const [busy, setBusy] = useState(false)
  const sources = (base.config.sources as Src[] | undefined) ?? []
  const isRag = base.kind === 'rag'

  async function saveSources(next: Src[], what: string, undo?: Src[]) {
    await ds.updateKnowledgeBase(base.id, { config: { ...base.config, sources: next }, reason: autoReason(what) })
    reload()
    toast(what, { body: '下次构建生效。', undo: undo ? async () => (await ds.updateKnowledgeBase(base.id, { config: { ...base.config, sources: undo }, reason: autoReason(`撤销：${what}`) }), reload()) : undefined })
  }

  async function add() {
    setBusy(true)
    try {
      if (kind === 'upload') {
        const r = await ds.uploadKnowledge(base.id, { files: files.map((f) => ({ path: f.path, content: f.content })) })
        // 服务端只解析 sources 里声明过的来源：还没有 upload 源时补一条（sources 为空时服务端默认就是 upload）
        if (sources.length && !sources.some((x) => (x.type ?? 'upload') === 'upload')) await ds.updateKnowledgeBase(base.id, { config: { ...base.config, sources: [...sources, { type: 'upload' }] }, reason: autoReason('添加上传数据源') })
        toast(`已上传 ${r.docs} 个文件`, { body: '下次构建会解析它们。', action: { label: '立即构建', onClick: () => void sync() } })
        setFiles([])
        docs.reload()
      } else {
        const s: Src = kind === 'repo' ? { type: kind, repo } : kind === 'path' ? { type: kind, path: dir } : { type: kind, urls }
        await saveSources([...sources, s], `已添加数据源 ${srcText(s)}`, sources)
      }
      setAdding(false)
    } catch (e) {
      toast('没有添加成功', { tone: 'failed', body: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  async function sync() {
    try {
      const b = await ds.startKnowledgeBuild(base.id, autoReason('手动同步数据源'))
      toast(`开始同步，构建 v${b.version}`, { tone: 'running', action: { label: '看进度', onClick: () => setQuery({ tab: 'builds' }) } })
      reload()
    } catch (e) {
      toast('同步没有启动', { tone: 'failed', body: (e as Error).message })
    }
  }

  const canAdd = kind === 'upload' ? files.length > 0 : kind === 'repo' ? !!repo.trim() : kind === 'path' ? !!dir.trim() : urls.length > 0
  return (
    <div className="kb-sources">
      <section className="kb-section">
        <div className="kb-section-head">
          <h2 className="kb-h2">数据从哪来</h2>
          <span className="kb-spacer" />
          {isRag && !adding && (
            <button type="button" className="btn btn-sm" onClick={() => setAdding(true)}>
              <Plus />
              添加数据源
            </button>
          )}
          <button type="button" className="btn btn-sm btn-primary" onClick={() => void sync()} disabled={!!base.building}>
            <RefreshCw />
            手动同步
          </button>
        </div>
        {isRag ? (
          <ul className="kb-src-list">
            {sources.map((s, i) => {
              const Icon = SRC_ICON[s.type ?? 'upload'] ?? FileText
              return (
                <li key={i} className="kb-src">
                  <Icon aria-hidden />
                  <span className="mono truncate">{srcText(s)}</span>
                  <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="移除数据源" disabled={sources.length <= 1} title={sources.length <= 1 ? '至少保留一个数据源' : '移除'} onClick={() => void saveSources(sources.filter((_, j) => j !== i), `已移除数据源 ${srcText(s)}`, sources)}>
                    <Trash2 />
                  </button>
                </li>
              )
            })}
          </ul>
        ) : (
          <ConfigSummary config={base.config} />
        )}
        <div className="expand" data-open={adding}>
          <div inert={!adding}>
            <div className="kb-src-add">
              <Segmented size="sm" ariaLabel="数据源类型" value={kind} onChange={setKind} options={[{ value: 'repo', label: '仓库' }, { value: 'path', label: '空间内目录' }, { value: 'url', label: 'URL 列表' }, { value: 'upload', label: '上传文件' }]} />
              {kind === 'repo' && <input className="input mono" placeholder="仓库 id，例如 shop-docs" value={repo} onChange={(e) => setRepo(e.target.value)} aria-label="仓库" />}
              {kind === 'path' && <input className="input mono" placeholder="相对空间目录，例如 docs" value={dir} onChange={(e) => setDir(e.target.value)} aria-label="目录" />}
              {kind === 'url' && <ListInput mono value={urls} onChange={setUrls} placeholder="粘贴 URL，回车添加" />}
              {kind === 'upload' && <Dropzone files={files} onChange={setFiles} />}
              <div className="kb-row-end">
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAdding(false)}>
                  取消
                </button>
                <button type="button" className="btn btn-sm btn-primary" disabled={!canAdd || busy} onClick={() => void add()}>
                  添加
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="kb-section">
        <div className="kb-section-head">
          <h2 className="kb-h2">文档</h2>
          {docs.data && <span className="faint num">{docs.data.length}</span>}
          {!!base.staleDocs && <span className="kb-stale">{base.staleDocs} 篇在构建后变了</span>}
        </div>
        {docs.error && !docs.data ? (
          <ErrorState compact error={docs.error} onRetry={docs.reload} />
        ) : !docs.data ? (
          <SkeletonRows rows={6} icon={false} />
        ) : docs.data.length === 0 ? (
          <EmptyState compact icon={FileText} title="还没有文档" body={isRag ? '上传文件或添加仓库路径，然后同步一次。' : '这个类型查询时实时读取，不需要文档。'} action={isRag ? <button type="button" className="btn btn-sm btn-primary" onClick={() => (setKind('upload'), setAdding(true))}>上传文件</button> : undefined} />
        ) : (
          <table className="table kb-docs">
            <thead>
              <tr>
                <th>路径</th>
                <th className="r">大小</th>
                <th>更新</th>
                <th>索引</th>
              </tr>
            </thead>
            <tbody>
              {docs.data.map((d, i) => {
                const s = st(i)
                return (
                  <tr key={d.path} className={`${s.className ?? ''} ${flash(d.path)}`} style={s.style}>
                    <td className="mono">{d.path}</td>
                    <td className="r num">{Math.max(1, Math.round(d.bytes / 1000))} KB</td>
                    <td className="faint">{fmtRelative(d.updatedAt)}</td>
                    <td>{d.indexed ? <span className="kb-tag" data-tone="success">已索引</span> : <span className="kb-tag" data-tone="waiting">待索引</span>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
