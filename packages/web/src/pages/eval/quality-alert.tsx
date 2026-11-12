import { Link2Off } from 'lucide-react'
import { useAsync } from '../../api'
import { Link } from '../../lib/router'

// 缺陷和评测都是质量日志的读模型；链断了或状态读取失败时，不能把结论当成可信数据。
export function QualityAlert({ what }: { what: string }) {
  const q = useAsync((ds) => ds.qualityStatus(), [])
  const s = q.data
  if (!q.error && (!s || s.ok)) return null
  return (
    <div className="ev-quality-alert" role="alert">
      <Link2Off aria-hidden />
      <span>
        {q.error ? <>质量日志校验状态读取失败，{what}的可信度尚未确认。</> : s?.anchorBehind && s.brokenAt === undefined ? <>质量日志链完整但锚点落后，{what}的可信度尚未确认，请查看并修复锚点。</> : <>质量日志{s?.brokenAt !== undefined ? <span className="num">从第 {s.brokenAt} 条起</span> : ''}断链，{what}可能不可信。</>}
      </span>
      {q.error && <button type="button" className="btn btn-sm" onClick={q.reload}>重试</button>}
      <Link to="/settings?tab=quality" className="btn btn-sm">
        查看质量日志
      </Link>
    </div>
  )
}
