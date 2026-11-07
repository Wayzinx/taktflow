import { useState } from 'react'
import { AlertTriangle, Check, Pencil, CircleDashed, FolderSymlink, GitBranch, GitFork, LoaderCircle, Plus, RefreshCw, SquareTerminal, X } from 'lucide-react'
import type { SpaceDetail } from '@taktflow/core'
import { useSource } from '../../api'
import { EmptyState, ReasonDialog, SkeletonRows, StatusBadge, toast, useFlashRows, useStagger, type StaggerProps } from '../../components/ui'
import type { StatusMeta } from '../../lib/status'
import { RepoSetupEdit } from './repo-setup-edit'

type Repo = SpaceDetail['repos'][number]

const REPO_STATUS: Record<Repo['status'], StatusMeta> = {
  ready: { label: '已就绪', tone: 'success', icon: Check },
  syncing: { label: '同步中', tone: 'running', icon: LoaderCircle, spin: true },
  missing: { label: '未镜像', tone: 'pending', icon: CircleDashed },
  error: { label: '同步失败', tone: 'failed', icon: X },
}

const PURPOSE: Record<string, string> = { app: '应用', library: '库', test: '测试', docs: '文档' }

function RepoRow({ repo, onChanged, stagger, flash }: { repo: Repo; onChanged: () => void; stagger?: StaggerProps; flash?: string }) {
  const ds = useSource()
  const [syncing, setSyncing] = useState(false)
  const [editing, setEditing] = useState(false)
  const [asking, setAsking] = useState(false)
  const status = syncing ? 'syncing' : repo.status

  // 原因由 ReasonDialog 收集（服务端必填，写进审计）；同步本身较慢，对话框先关，进度在行内显示
  async function sync(reason: string) {
    setSyncing(true)
    try {
      const { head } = await ds.syncRepo(repo.id, reason)
      toast(`${repo.id} 已同步`, { body: <>HEAD <span className="mono">{head}</span> · 新任务会从这个提交开 worktree。</> })
    } catch (e) {
      toast(`${repo.id} 同步失败`, { body: (e as Error).message, tone: 'failed' })
    } finally {
      setSyncing(false)
      onChanged()
    }
  }

  return (
    <li className={`repo-row ${stagger?.className ?? ''} ${flash ?? ''}`} style={stagger?.style}>
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
        {editing ? (
          <RepoSetupEdit
            repo={repo}
            onDone={(changed) => {
              setEditing(false)
              if (changed) onChanged()
            }}
          />
        ) : (
          <div className="repo-setup-row">
            <WorktreeSetup repo={repo} />
            <button className="btn btn-ghost btn-sm repo-setup-btn" onClick={() => setEditing(true)} aria-label={`编辑 ${repo.id} 的 worktree 引导`}>
              <Pencil />
              编辑引导
            </button>
          </div>
        )}
        {repo.message && status !== 'syncing' && (
          <p className={`repo-message${repo.status === 'error' ? ' error' : ''}`}>
            {repo.status === 'error' && <AlertTriangle aria-hidden />}
            {repo.message}
          </p>
        )}
      </div>
      <StatusBadge meta={REPO_STATUS[status]} subtle />
      <button className="btn btn-sm" onClick={() => setAsking(true)} disabled={status === 'syncing'}>
        <RefreshCw className={status === 'syncing' ? 'spin' : undefined} />
        {repo.status === 'missing' ? '拉取镜像' : '同步'}
      </button>
      <ReasonDialog
        open={asking}
        onClose={() => setAsking(false)}
        title={`${repo.status === 'missing' ? '拉取' : '同步'} ${repo.id}`}
        description="从远程拉取默认分支到本地镜像；之后新开的 worktree 从新的 HEAD 开始。"
        confirmLabel={repo.status === 'missing' ? '拉取镜像' : '同步'}
        onSubmit={(reason) => void sync(reason)}
      />
    </li>
  )
}

/** worktree 引导：建好 worktree 后执行的命令，以及从主检出软链进来的共享目录。 */
function WorktreeSetup({ repo }: { repo: Repo }) {
  if (!repo.bootstrap && !repo.share?.length)
    return <p className="repo-setup is-empty faint">没有引导命令：新 worktree 直接开工（依赖需要节点自己装）。</p>
  return (
    <dl className="repo-setup" aria-label={`${repo.id} 的 worktree 引导`}>
      {repo.bootstrap && (
        <div title="worktree 建好后在其中执行；失败则节点 blocked">
          <dt>
            <SquareTerminal aria-hidden />
            引导命令
          </dt>
          <dd>
            <code className="repo-cmd">{repo.bootstrap}</code>
          </dd>
        </div>
      )}
      {repo.share && repo.share.length > 0 && (
        <div title="从仓库主检出软链进 worktree，避免每个 worktree 重装">
          <dt>
            <FolderSymlink aria-hidden />
            共享目录
          </dt>
          <dd>
            {repo.share.map((d) => (
              <span key={d} className="chip chip-sm mono">
                {d}
              </span>
            ))}
          </dd>
        </div>
      )}
    </dl>
  )
}

const splitList = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean)

function AddRepo({ onDone }: { onDone: () => void }) {
  const ds = useSource()
  const [f, setF] = useState({ id: '', url: '', defaultBranch: 'main', bootstrap: '', share: '' })
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState(false)
  const valid = /^[a-z0-9][a-z0-9-]*$/.test(f.id) && f.url.trim() !== ''
  // 由 ReasonDialog 调用：失败时抛错，消息留在对话框里
  async function submit(reason: string) {
    setBusy(true)
    try {
      const share = splitList(f.share)
      await ds.addRepo({
        id: f.id,
        url: f.url.trim(),
        path: `.takt/repos/${f.id}`,
        defaultBranch: f.defaultBranch || 'main',
        ...(f.bootstrap.trim() ? { bootstrap: f.bootstrap.trim() } : {}),
        ...(share.length ? { share } : {}),
      }, reason)
      toast(`已绑定 ${f.id}`, { body: '点同步把仓库镜像到本地。' })
      onDone()
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
    <form
      className="repo-add"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid) setAsking(true)
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
      <label className="grow">
        <span className="field-label">引导命令（可选）</span>
        <input className="input mono" placeholder="npm ci --prefer-offline" value={f.bootstrap} onChange={(e) => setF({ ...f, bootstrap: e.target.value })} />
      </label>
      <label className="grow">
        <span className="field-label">共享目录（可选，逗号分隔）</span>
        <input className="input mono" placeholder="node_modules, .cache" value={f.share} onChange={(e) => setF({ ...f, share: e.target.value })} />
      </label>
      <button className="btn btn-primary" type="submit" disabled={!valid || busy}>
        绑定
      </button>
      <p className="faint repo-add-hint">
        id 用小写字母、数字和短横线。每个写代码的任务会从这个仓库开自己的工作区；引导命令在工作区建好后执行，失败时节点会停下来等人；共享目录在工作区之间复用，免得每次重装依赖。
      </p>
    </form>
    <ReasonDialog open={asking} onClose={() => setAsking(false)} title={`绑定仓库 ${f.id}`} description="绑定后立即生效，并记入空间审计。" confirmLabel="绑定" onSubmit={submit} />
    </>
  )
}

export function ReposTab({ space, onChanged }: { space?: SpaceDetail; onChanged: () => void }) {
  const [adding, setAdding] = useState(false)
  const st = useStagger(space?.repos.length ?? 0)
  const flash = useFlashRows((space?.repos ?? []).map((r) => r.id))
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
      <div className="expand" data-open={adding ? 'true' : 'false'}>
        <div inert={!adding}>
          <AddRepo
            onDone={() => {
              setAdding(false)
              onChanged()
            }}
          />
        </div>
      </div>
      {space.repos.length === 0 ? (
        <EmptyState
          compact
          icon={GitFork}
          title="还没有绑定代码仓库"
          body="一个空间可以绑定多个仓库（前端、后端、测试），任务按仓库各开工作区，互不冲突。"
          action={!adding ? <button type="button" className="btn btn-sm btn-primary" onClick={() => setAdding(true)}><Plus />绑定代码仓库</button> : undefined}
          stewardAsk="帮我把这个仓库绑定到空间："
        />
      ) : (
        <ul className="repo-list">
          {space.repos.map((r, i) => (
            <RepoRow key={r.id} repo={r} onChanged={onChanged} stagger={st(i)} flash={flash(r.id)} />
          ))}
        </ul>
      )}
    </div>
  )
}
