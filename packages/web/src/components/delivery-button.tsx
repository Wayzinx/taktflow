import { MonitorPlay } from 'lucide-react'
import { useAsync } from '../api'
import { previewHref } from '../lib/preview'

/**
 * 「打开成品」：运行做出来的网页在集成工作树里，要经 HTTP 才能打开（ESM 模块在 file:// 下被拦），
 * 这里直接给预览链接（服务端另开端口提供）。没有网页类成品时不显示。悬停写清代码在哪个分支、合没合进默认分支。
 */
export function DeliveryButton({ runId }: { runId?: string }) {
  const q = useAsync((ds) => (runId ? ds.runDelivery(runId) : Promise.resolve(null)), [runId])
  const d = q.data
  const entry = d?.entries[0]
  if (!runId || !d || !entry) return null
  const where = d.merged ? `已合进 ${d.defaultBranch}` : `代码在集成分支 ${d.branch}，还没合进 ${d.defaultBranch}`
  const more = d.entries.length > 1 ? `\n其他网页：${d.entries.slice(1).join('、')}` : ''
  return (
    <a className="btn btn-sm btn-primary" href={previewHref(runId, entry)} target="_blank" rel="noreferrer" title={`打开 ${entry}（本机预览）\n${where}${more}`}>
      <MonitorPlay />
      打开成品
    </a>
  )
}
