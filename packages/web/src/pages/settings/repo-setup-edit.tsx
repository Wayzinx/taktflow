import { useState } from 'react'
import type { SpaceDetail } from '@taktflow/core'
import { useSource } from '../../api'
import { toast } from '../../components/ui'

type Repo = SpaceDetail['repos'][number]

const splitList = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean)

/** 已绑定仓库的 worktree 引导（引导命令 / 共享目录）行内编辑。 */
export function RepoSetupEdit({ repo, onDone }: { repo: Repo; onDone: (changed: boolean) => void }) {
  const ds = useSource()
  const [bootstrap, setBootstrap] = useState(repo.bootstrap ?? '')
  const [share, setShare] = useState((repo.share ?? []).join(', '))
  const [busy, setBusy] = useState(false)
  async function save() {
    setBusy(true)
    try {
      const list = splitList(share)
      await ds.updateRepo(repo.id, { bootstrap: bootstrap.trim() || undefined, share: list.length ? list : undefined })
      toast(`${repo.id} 的引导已更新`, { body: '之后新开的 worktree 生效，已有 worktree 不受影响。' })
      onDone(true)
    } catch (e) {
      toast('保存失败', { body: (e as Error).message, tone: 'failed' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      className="repo-add repo-setup-edit"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onDone(false)
      }}
    >
      <label className="grow">
        <span className="field-label">引导命令</span>
        <input className="input mono" autoFocus placeholder="npm ci --prefer-offline" value={bootstrap} onChange={(e) => setBootstrap(e.target.value)} />
      </label>
      <label className="grow">
        <span className="field-label">共享目录（逗号分隔）</span>
        <input className="input mono" placeholder="node_modules, .cache" value={share} onChange={(e) => setShare(e.target.value)} />
      </label>
      <button className="btn btn-sm btn-primary" type="submit" disabled={busy}>
        保存
      </button>
      <button className="btn btn-sm" type="button" onClick={() => onDone(false)}>
        取消
      </button>
    </form>
  )
}
