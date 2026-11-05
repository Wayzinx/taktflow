import { useState } from 'react'
import { AlertTriangle, Check, CircleDashed, GitBranch, GitFork, LoaderCircle, Plus, RefreshCw, X } from 'lucide-react'
import type { SpaceDetail } from '@taktflow/core'
import { useSource } from '../../api'
import { EmptyState, SkeletonRows, StatusBadge, toast } from '../../components/ui'
import type { StatusMeta } from '../../lib/status'

type Repo = SpaceDetail['repos'][number]

const REPO_STATUS: Record<Repo['status'], StatusMeta> = {
  ready: { label: '已就绪', tone: 'success', icon: Check },
  syncing: { label: '同步中', tone: 'running', icon: LoaderCircle, spin: true },
  missing: { label: '未镜像', tone: 'pending', icon: CircleDashed },
  error: { label: '同步失败', tone: 'failed', icon: X },
}

const PURPOSE: Record<string, string> = { app: '应用', library: '库', test: '测试', docs: '文档' }

function RepoRow({ repo, onChanged }: { repo: Repo; onChanged: () => void }) {
  const ds = useSource()
  const [syncing, setSyncing] = useState(false)
  const status = syncing ? 'syncing' : repo.status

  async function sync() {
    setSyncing(true)
    try {
      const { head } = await ds.syncRepo(repo.id)
      toast(`${repo.id} 已同步`, { body: <>HEAD <span className="mono">{head}</span> · 新任务会从这个提交开 worktree。</> })
    } catch (e) {
      toast(`${repo.id} 同步失败`, { body: (e as Error).message, tone: 'failed' })
    } finally {
      setSyncing(false)
      onChanged()
    }
  }

  return (
    <li className="repo-row">
      <span className="repo-icon" aria-hidden>
        <GitFork />
      </span>
      <div className="repo-main">
        <div className="repo-title">
          <span className="mono repo-id">{repo.id}</span>
          {repo.purpose && <span className="chip chip-sm">{PURPOSE[repo.purpose] ?? repo.purpose}</span>}
          {repo.description && <span className="faint truncate">{repo.description}</span>}
        </div>
        <div className="repo-facts mono">
          <span className="truncate" title={repo.url ?? repo.path}>{repo.url ?? repo.path}</span>
          <span className="repo-branch">
            <GitBranch aria-hidden />
            {repo.defaultBranch}
            {repo.head && <span className="faint"> @ {repo.head}</span>}
          </span>
        </div>
        {repo.message && status !== 'syncing' && (
          <p className={`repo-message${repo.status === 'error' ? ' error' : ''}`}>
            {repo.status === 'error' && <AlertTriangle aria-hidden />}
            {repo.message}
          </p>
        )}
      </div>
      <StatusBadge meta={REPO_STATUS[status]} subtle />
      <button className="btn btn-sm" onClick={sync} disabled={status === 'syncing'}>
        <RefreshCw className={status === 'syncing' ? 'spin' : undefined} />
        {repo.status === 'missing' ? '拉取镜像' : '同步'}
      </button>
    </li>
  )
}

function AddRepo({ onDone }: { onDone: () => void }) {
  const ds = useSource()
  const [f, setF] = useState({ id: '', url: '', defaultBranch: 'main' })
  const [busy, setBusy] = useState(false)
  const valid = /^[a-z0-9][a-z0-9-]*$/.test(f.id) && f.url.trim() !== ''
  async function submit() {
    setBusy(true)
    try {
      await ds.addRepo({ id: f.id, url: f.url.trim(), path: `.takt/repos/${f.id}`, defaultBranch: f.defaultBranch || 'main' })
      toast(`已绑定 ${f.id}`, { body: '点同步把仓库镜像到本地。' })
      onDone()
    } catch (e) {
      toast('绑定失败', { body: (e as Error).message, tone: 'failed' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      className="repo-add"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid) void submit()
      }}
    >
      <label>
        <span className="field-label">id</span>
        <input className="input mono" placeholder="shop-admin" value={f.id} onChange={(e) => setF({ ...f, id: e.target.value.trim() })} />
      </label>
      <label className="grow">
        <span className="field-label">远程地址</span>
        <input className="input mono" placeholder="git@github.com:org/repo.git" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} />
      </label>
      <label>
        <span className="field-label">默认分支</span>
        <input className="input mono" value={f.defaultBranch} onChange={(e) => setF({ ...f, defaultBranch: e.target.value.trim() })} />
      </label>
      <button className="btn btn-primary" type="submit" disabled={!valid || busy}>
        绑定
      </button>
      <p className="faint repo-add-hint">
        id 用小写字母、数字和短横线。镜像放在 <span className="mono">.takt/repos/{f.id || '<id>'}</span>，每个写代码的任务从镜像开自己的 worktree。
      </p>
    </form>
  )
}

export function ReposTab({ space, onChanged }: { space?: SpaceDetail; onChanged: () => void }) {
  const [adding, setAdding] = useState(false)
  if (!space) return <div className="card"><SkeletonRows rows={4} /></div>
  const ready = space.repos.filter((r) => r.status === 'ready').length
  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">代码仓库</span>
        <span className="faint">
          <span className="num">{ready}</span> / <span className="num">{space.repos.length}</span> 已就绪
        </span>
        <span className="spacer" />
        <button className="btn btn-sm" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
          <Plus />
          绑定代码仓库
        </button>
      </div>
      {adding && (
        <AddRepo
          onDone={() => {
            setAdding(false)
            onChanged()
          }}
        />
      )}
      {space.repos.length === 0 ? (
        <EmptyState compact icon={GitFork} title="还没有绑定代码仓库" hint="一个空间可以绑定多个仓库（前端、后端、测试…），任务按仓库开 worktree，互不冲突。" />
      ) : (
        <ul className="repo-list">
          {space.repos.map((r) => (
            <RepoRow key={r.id} repo={r} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </div>
  )
}
