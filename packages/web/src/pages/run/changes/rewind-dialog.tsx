import { useEffect, useState, type CSSProperties } from 'react'
import { Info, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react'
import type { RewindPreview } from '@taktflow/core'
import { invalidate, RewindConflictError, useSource } from '../../../api'
import { Dialog, ReasonField, reasonOk, Skeleton, toast } from '../../../components/ui'
import { setQuery } from '../../../lib/router'

/**
 * 退回到节点之前（docs/design/26 §5）：先预览要恢复的文件、会过期的节点与阻止原因，写原因后确认；
 * 预览之后状态变了（409）就自动重新预览并提示，不让人对着过期的预览点确认。
 */
export function RewindDialog({ open, onClose, runId, nodeId, nodeTitle }: { open: boolean; onClose: () => void; runId: string; nodeId: string; nodeTitle: string }) {
  const ds = useSource()
  const [preview, setPreview] = useState<RewindPreview>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const load = () => {
    setPreview(undefined)
    setError(undefined)
    return ds.rewindPreview(runId, nodeId).then(setPreview, (e: Error) => setError(e.message))
  }
  useEffect(() => {
    if (!open) return
    setReason('')
    setNotice(undefined)
    setBusy(false)
    void load()
    // load 依赖 ds / runId / nodeId，打开时取一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, runId, nodeId])

  const submit = async () => {
    if (!preview || preview.blocked || !reasonOk(reason) || busy) return
    setBusy(true)
    setError(undefined)
    try {
      const r = await ds.rewind(runId, nodeId, { token: preview.token, reason: reason.trim() })
      onClose()
      invalidate()
      toast(`已退回到「${nodeTitle}」之前`, {
        body: `恢复 ${r.files.length} 个文件，${r.stale.length} 个节点标为过期，重跑后才会继续。`,
        action: { label: '看过期节点', onClick: () => setQuery({ node: r.stale[0]?.nodeId, dtab: undefined, view: undefined }) },
      })
    } catch (e) {
      if (e instanceof RewindConflictError) {
        setNotice(`${e.message}。请再看一遍下面的内容。`)
        await load()
      } else setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      tone="danger"
      dismissible={!reason.trim()}
      title={`退回到「${nodeTitle}」之前`}
      description="恢复本节点改过的文件；存放区产物写一个新版本（不删历史）；本节点与下游标为过期。"
      footer={
        <>
          {error && <span className="ov-error">{error}</span>}
          <button type="button" className="btn btn-sm" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn btn-sm btn-danger" disabled={!preview || Boolean(preview.blocked) || !reasonOk(reason) || busy} aria-busy={busy} onClick={submit}>
            {busy && <LoaderCircle className="spin" aria-hidden />}
            确认回退
          </button>
        </>
      }
    >
      <div className="rw">
        {notice && (
          <div className="rw-notice" role="status">
            <RefreshCw />
            <span>{notice}</span>
          </div>
        )}
        {!preview ? (
          error ? null : (
            <div className="rw-skel">
              <Skeleton h={12} w="40%" />
              <Skeleton h={28} />
              <Skeleton h={28} />
              <Skeleton h={12} w="30%" />
              <Skeleton h={24} w="70%" />
            </div>
          )
        ) : (
          <>
            {preview.blocked && (
              <div className="rw-blocked" role="alert">
                <TriangleAlert />
                <span>
                  <b>现在不能回退：</b>
                  {preview.blocked}
                </span>
              </div>
            )}
            <section className="rw-sec">
              <h4>
                会恢复 {preview.files.length} 个文件
              </h4>
              <ul className="rw-files">
                {preview.files.map((f, i) => (
                  <li key={`${f.scope}:${f.path}`} style={{ '--i': i } as CSSProperties}>
                    <span className={`chg-st st-${f.status}`}>{f.status === 'added' ? '−' : '↺'}</span>
                    <span className="mono truncate">{f.path}</span>
                    <span className="faint rw-to">{f.scope === 'repo' ? (f.status === 'added' ? '删除（节点新建的）' : '恢复到节点开始前') : f.from ? `写回 v${f.from} 的内容` : '本节点新建的产物：保留历史，标为过期'}</span>
                  </li>
                ))}
              </ul>
            </section>
            <section className="rw-sec">
              <h4>
                会过期、需要重跑的节点 <span className="faint">{preview.stale.length}</span>
              </h4>
              <div className="rw-stale">
                {preview.stale.map((s, i) => (
                  <span key={s.nodeId} className={`rw-node${s.nodeId === nodeId ? ' is-self' : ''}`} style={{ '--i': i } as CSSProperties} title={s.nodeId}>
                    {s.title ?? s.nodeId}
                  </span>
                ))}
              </div>
            </section>
            <p className="rw-note">
              <Info />
              回退写进审计；之后要继续，在运行页重跑过期节点。
            </p>
            {!preview.blocked && <ReasonField value={reason} onChange={setReason} risk="dangerous" placeholder="例如：fix-code 改错了方向，退回去按评审意见重做" autoFocus />}
          </>
        )}
      </div>
    </Dialog>
  )
}
