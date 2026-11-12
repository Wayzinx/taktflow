import { useState } from 'react'
import type { WorkflowDocument, WorkflowSummary } from '@taktflow/core'
import { ChevronRight, Lock, PencilRuler, Plus, Workflow } from 'lucide-react'
import { invalidate, useAsync, useSource } from '../api'
import { Dialog, EmptyState, ReasonField, reasonOk, SkeletonRows, toast, useFlashRows, useStagger } from '../components/ui'
import { actingUserHeader } from '../lib/acting-user'
import { currentSpaceId } from '../lib/space'
import { fmtDate, fmtRelative } from '../lib/format'
import { Link, navigate } from '../lib/router'
import './workflows-list.css'

/** workflow 列表：/workflows 页面和空间设置的 Workflow Tab 共用。整行可点，标题是真正的链接（键盘、新标签页）。 */
export function WorkflowTable({ workflows, onCreate }: { workflows?: WorkflowSummary[]; onCreate?: () => void }) {
  const st = useStagger(workflows?.length ?? 0)
  const flash = useFlashRows((workflows ?? []).map((w) => w.id))
  if (!workflows) return <SkeletonRows rows={3} />
  if (workflows.length === 0) {
    return (
      <EmptyState
        compact
        icon={Workflow}
        title="这个空间还没有流水线"
        body="从标准交付或轻量改动模板添加，也可以新建空白流水线，在画布上逐步配置。"
        action={onCreate && <button type="button" className="btn btn-sm btn-primary" onClick={onCreate}><Plus />新建 / 从模板添加</button>}
      />
    )
  }
  const sorted = [...workflows].sort((a, b) => Number(b.editable) - Number(a.editable) || b.updatedAt.localeCompare(a.updatedAt))
  return (
    <div className="wf-table-wrap">
      <table className="table wf-table">
        <thead>
          <tr>
            <th>流水线</th>
            <th>编辑</th>
            <th className="r">节点</th>
            <th className="r">最近运行</th>
            <th>修订</th>
            <th>更新</th>
            <th aria-label="打开" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((w, i) => (
            <tr key={w.id} className={`clickable ${st(i).className ?? ''} ${flash(w.id)}`} style={st(i).style} onClick={(e) => !(e.target as HTMLElement).closest('a') && navigate(`/workflows/${encodeURIComponent(w.id)}`)}>
              <td className="wf-cell-title">
                <Link to={`/workflows/${encodeURIComponent(w.id)}`} className="wf-title">
                  {w.title}
                </Link>
                <span className="wf-file mono truncate" title={w.file}>
                  {w.file}
                </span>
              </td>
              <td>
                {w.editable ? (
                  <span className="wf-mode">
                    <PencilRuler aria-hidden />
                    可视化编辑
                  </span>
                ) : (
                  <span className="wf-mode readonly" title="定义里有画布无法还原的代码结构；打开后可以一键转换成可编辑格式，转换不了就让管家来改">
                    <Lock aria-hidden />
                    只读
                  </span>
                )}
              </td>
              <td className="r num">{w.nodes}</td>
              <td className="r num">{w.runs ? w.runs : <span className="faint">—</span>}</td>
              <td>
                <span className="mono wf-rev">{w.rev.slice(0, 8)}</span>
              </td>
              <td>
                <time dateTime={w.updatedAt} title={fmtDate(w.updatedAt)} className="faint">
                  {fmtRelative(w.updatedAt)}
                </time>
              </td>
              <td className="wf-cell-go">
                <ChevronRight aria-hidden />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** 新接口暂由本组页面调用；统一客户端由 shell 组接入。 */
export function WorkflowCreateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ds = useSource()
  const me = useAsync((source) => source.me(), [])
  const [id, setId] = useState('')
  const [title, setTitle] = useState('')
  const [template, setTemplate] = useState('taktflow-standard')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const idError = !id ? '填写流水线 ID' : !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) ? '以字母或数字开头，只能包含字母、数字、. _ -' : undefined
  const allowed = me.data?.member?.role === 'owner' || me.data?.member?.role === 'maintainer'
  async function create() {
    if (idError || !reasonOk(reason) || !allowed || busy || ds.mock) return
    setBusy(true); setError(undefined)
    try {
      const sid = currentSpaceId()
      const response = await fetch(`/api${sid ? `/s/${encodeURIComponent(sid)}` : ''}/workflows`, { method: 'POST', headers: { 'content-type': 'application/json', ...actingUserHeader() }, body: JSON.stringify({ id, title: title.trim() || id, template, reason: reason.trim() }) })
      const value = await response.json() as WorkflowDocument & { error?: string }
      if (!response.ok) throw new Error(value.error ?? '新建流水线失败')
      invalidate(); onClose()
      toast(`已创建「${title.trim() || id}」`)
      navigate(`/workflows/${encodeURIComponent(value.id)}`)
    } catch (error) { setError((error as Error).message) } finally { setBusy(false) }
  }
  return <Dialog open={open} onClose={onClose} title="新建流水线" description="选择起点，创建后进入画布编辑。" dismissible={!id && !reason} footer={<>
    {error && <span className="ov-error" role="alert">{error}</span>}
    <button type="button" className="btn btn-sm" onClick={onClose}>取消</button>
    <button type="button" className="btn btn-sm btn-primary" disabled={!!idError || !reasonOk(reason) || !allowed || busy || ds.mock} onClick={() => void create()}>{busy ? '创建中…' : '创建流水线'}</button>
  </>}>
    <form className="ov-form" onSubmit={(event) => { event.preventDefault(); void create() }}>
      {ds.mock ? <p className="ov-error">演示模式不能新建流水线，请连接真实空间。</p> : me.error ? <p className="ov-error">身份读取失败：{me.error.message}</p> : me.data && !allowed && <p className="ov-error">你是 {me.data.member?.role ?? '非成员'}，新建流水线需要 maintainer 或 owner。</p>}
      <label className="ov-field"><span className="ov-field-label">起点</span><select className="input" value={template} onChange={(event) => setTemplate(event.target.value)}><option value="taktflow-standard">标准交付流水线</option><option value="quick-fix">轻量改动交付</option><option value="blank">空白流水线</option></select></label>
      <label className="ov-field"><span className="ov-field-label">流水线 ID</span><input className="input mono" value={id} onChange={(event) => setId(event.target.value)} placeholder="team-delivery" aria-invalid={!!id && !!idError} aria-describedby="workflow-id-hint" data-autofocus /><span id="workflow-id-hint" className={id && idError ? 'ov-error' : 'ov-field-hint'}>{idError ?? '用于文件名和链接，创建后不可修改'}</span></label>
      <label className="ov-field"><span className="ov-field-label">名称（可选）</span><input className="input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="团队交付流程" /></label>
      <ReasonField value={reason} onChange={setReason} />
    </form>
  </Dialog>
}
