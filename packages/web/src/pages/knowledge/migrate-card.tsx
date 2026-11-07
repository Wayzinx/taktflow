import { useState } from 'react'
import type { KnowledgeMigration } from '@taktflow/core'
import { ArrowRightLeft, CircleCheck, CircleX } from 'lucide-react'
import { useSource } from '../../api'
import { toast } from '../../components/ui'

/** 旧的知识源条目 → 知识库：先预览（dryRun），人确认后再迁移。 */
export function MigrateCard({ count, onDone }: { count: number; onDone: () => void }) {
  const ds = useSource()
  const [preview, setPreview] = useState<KnowledgeMigration>()
  const [busy, setBusy] = useState(false)
  async function run(dryRun: boolean) {
    setBusy(true)
    try {
      const r = await ds.migrateKnowledge(dryRun)
      if (dryRun) setPreview(r)
      else {
        setPreview(undefined)
        onDone()
        const ok = r.items.filter((x) => x.ok).length
        toast(`已迁移 ${ok} 个知识源`, { body: r.items.length > ok ? `${r.items.length - ok} 个保留旧配置，原因见预览。` : undefined })
      }
    } catch (e) {
      toast('迁移失败', { tone: 'failed', body: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="kb-section kb-migrate">
      <div className="kb-section-head">
        <ArrowRightLeft aria-hidden className="kb-migrate-icon" />
        <h2 className="kb-h2">{count} 个旧知识源可以升级成知识库</h2>
        <span className="faint">升级后能构建、评测、按版本发布</span>
        <span className="kb-spacer" />
        {preview ? (
          <>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPreview(undefined)}>
              取消
            </button>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void run(false)}>
              确认迁移
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void run(true)}>
            预览迁移
          </button>
        )}
      </div>
      <div className="expand" data-open={!!preview}>
        <div inert={!preview}>
          <ul className="kb-migrate-list">
            {preview?.items.map((x) => (
              <li key={x.id} data-ok={x.ok}>
                {x.ok ? <CircleCheck aria-hidden /> : <CircleX aria-hidden />}
                <span className="mono">{x.id}</span>
                <span className="faint mono">
                  {x.kind}
                  {x.to ? ` → ${x.to}` : ''}
                </span>
                <span>{x.message}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}
