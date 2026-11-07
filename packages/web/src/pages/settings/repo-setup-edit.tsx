import { useState } from 'react'
import type { SpaceDetail } from '@taktflow/core'
import { useSource } from '../../api'
import { ReasonDialog, toast } from '../../components/ui'

type Repo = SpaceDetail['repos'][number]

const splitList = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean)

/** 已绑定仓库的 worktree 引导（引导命令 / 共享目录）行内编辑。 */
export function RepoSetupEdit({ repo, onDone }: { repo: Repo; onDone: (changed: boolean) => void }) {
  const ds = useSource()
  const [bootstrap, setBootstrap] = useState(repo.bootstrap ?? '')
  const [share, setShare] = useState((repo.share ?? []).join(', '))
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState(false)
  // 清空不能传 undefined（JSON 会丢掉，服务端合并后旧值留下）：共享目录传空数组（服务端已支持），
  // 引导命令传 null（约定 null = 删除该键，服务端待支持，见协议变更请求；不支持时 400 的消息会留在原因对话框里）
  async function save(reason: string) {
    setBusy(true)
    try {
      const list = splitList(share)
      await ds.updateRepo(repo.id, { bootstrap: bootstrap.trim() || (repo.bootstrap ? null : undefined), share: list }, reason)
      toast(`${repo.id} 的引导已更新`, { body: '之后新开的 worktree 生效，已有 worktree 不受影响。' })
      onDone(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
    <form
      className="repo-add repo-setup-edit"
      onSubmit={(e) => {
        e.preventDefault()
        setAsking(true)
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
    <ReasonDialog open={asking} onClose={() => setAsking(false)} title={`修改 ${repo.id} 的 worktree 引导`} description="保存后对新开的工作区生效，并记入空间审计。" confirmLabel="保存" onSubmit={save} />
    </>
  )
}
