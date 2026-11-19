import { useId, useRef, useState, type FormEvent } from 'react'
import { MessageSquare, Plus, Unplug, X } from 'lucide-react'
import type { SpaceMember } from '@taktflow/core'
import { useAsync } from '../../api'
import { ApiRequestError } from '../../api/client.js'
import type { FeishuBindingStatus, FeishuBindingUpdate, FeishuSource } from '../../api/feishu.js'
import { Dialog, ErrorState, SkeletonRows } from '../../components/ui'
import { Link } from '../../lib/router'
import { bindingUpdate, feishuDraft, type MappingRow } from './feishu-draft.js'
import './feishu.css'

type FeishuClient = FeishuSource & { readonly mock: boolean }

export function FeishuTab({ source, members }: { source: FeishuClient; members?: SpaceMember[] }) {
  const result = useAsync(() => source.feishuBinding(), [])
  const denied = result.error instanceof ApiRequestError && (result.error.status === 401 || result.error.status === 403)
  return (
    <section className="card feishu-settings" aria-label="飞书群绑定">
      {result.data && members && !denied ? <FeishuEditor source={source} initial={result.data} members={members} />
        : denied ? <p className="feishu-message" role="alert">请以空间 Owner 身份管理绑定。本机开发模式可在<Link to="/attention">待办</Link>页的「我是」中选择身份。</p>
        : result.error ? <ErrorState title="无法读取飞书群绑定" error={result.error} onRetry={result.reload} compact />
          : <SkeletonRows rows={3} icon={false} />}
    </section>
  )
}

export function FeishuEditor({ source, initial, members }: { source: FeishuClient; initial: FeishuBindingStatus; members: SpaceMember[] }) {
  const [status, setStatus] = useState(initial)
  const [draft, setDraft] = useState(() => feishuDraft(initial.binding))
  const [busy, setBusy] = useState<'save' | 'unbind' | 'reload'>()
  const [conflict, setConflict] = useState(false)
  const [denied, setDenied] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [newRow, setNewRow] = useState<number>()
  const nextRow = useRef(draft.members.length)
  const hintId = useId()
  const known = new Map(members.map((member) => [member.id, member]))
  const binding = status.binding
  const dirty = draft.chatId.trim() !== (binding?.chatId ?? '') || draft.members.length !== (binding?.members.length ?? 0)
    || draft.members.some(({ memberId, openId }, index) => {
      const saved = binding?.members[index]
      return memberId !== saved?.memberId || openId.trim() !== saved?.openId
    })
  const locked = Boolean(busy || conflict || confirm || denied)
  const canEdit = status.configured && !source.mock

  function updateRow(key: number, patch: Partial<Omit<MappingRow, 'key'>>) {
    setDraft((value) => ({ ...value, members: value.members.map((row) => row.key === key ? { ...row, ...patch } : row) }))
    setError(undefined)
    setNotice(undefined)
  }

  function addRow() {
    const key = nextRow.current++
    setDraft((value) => ({ ...value, members: [...value.members, { key, openId: '', memberId: '' }] }))
    setNewRow(key)
    setError(undefined)
    setNotice(undefined)
  }

  async function apply(operation: NonNullable<typeof busy>, update?: FeishuBindingUpdate) {
    if (busy) return
    setBusy(operation)
    setError(undefined)
    setNotice(undefined)
    try {
      const current = update ? await source.setFeishuBinding(update) : await source.feishuBinding()
      setStatus(current)
      setDraft(feishuDraft(current.binding))
      nextRow.current = current.binding?.members.length ?? 0
      setNewRow(undefined)
      setConfirm(false)
      setConflict(false)
      setDenied(false)
      setNotice(operation === 'save' ? '飞书群绑定已保存。' : operation === 'unbind' ? '已解绑飞书群。' : '已读取最新绑定。')
    } catch (problem) {
      if (problem instanceof ApiRequestError && problem.status === 409) {
        setConfirm(false)
        setConflict(true)
        if (problem.message !== 'conflict') setError(problem.message)
      } else if (problem instanceof ApiRequestError && (problem.status === 401 || problem.status === 403)) {
        setConfirm(false)
        setDenied(true)
      } else {
        const message = problem instanceof Error ? problem.message : String(problem)
        setError(`${operation === 'reload' ? '读取失败' : operation === 'unbind' ? '解绑失败' : '保存失败'}：${message}`)
      }
    } finally {
      setBusy(undefined)
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canEdit || locked || !dirty) return
    const result = bindingUpdate(draft, status.binding, members)
    if ('error' in result) { setError(result.error); return }
    void apply('save', result.update)
  }

  if (denied) return <ErrorState title="无法管理飞书群绑定" error={new Error(error ?? '请确认当前身份是空间 owner。')}
    onRetry={busy ? undefined : () => void apply('reload')} compact />

  const bindingLabel = status.binding ? '已绑定' : '未绑定'
  return (
    <>
      <div className="card-head feishu-head">
        <h2 className="card-title"><MessageSquare aria-hidden /> 飞书群绑定</h2>
        <span className="feishu-badge" data-bound={status.configured && !!status.binding}>
          {!status.configured ? '企业应用未配置' : bindingLabel}
        </span>
      </div>
      <div className="feishu-body">
        <div className="feishu-intro">
          <p>每个空间可绑定一个飞书群，与「团队 Agent」共用空间对话。在群里 <strong>@管家</strong> 聊天、建需求或查看待办；需要拍板时，用群里的卡片确认。</p>
          <p>绑定后，全群都能看到团队会话的新消息和运行通知。成员映射决定谁能发指令和审批。单向通知 Webhook 在<Link to="/automations">自动化</Link>中配置。</p>
        </div>
        {!status.configured && <p className="feishu-message" role="note">请联系 Hub 运维启用飞书企业应用后，再来绑定群。</p>}
        {source.mock && <p className="feishu-message" role="note">这里展示演示数据，不能保存或解绑。</p>}
        {conflict && (
          <div className="feishu-message feishu-conflict">
            <p role="alert">绑定发生冲突，本次操作未生效。草稿还在；读取最新绑定后，需要重新填写改动。</p>
            <button className="btn" type="button" disabled={!!busy} onClick={() => void apply('reload')}>
              {busy === 'reload' ? <SkeletonRows rows={1} icon={false} /> : '放弃草稿并读取最新绑定'}
            </button>
          </div>
        )}
        {notice && <p className="feishu-message" role="status">{notice}</p>}
        <form onSubmit={submit}>
          <fieldset className="feishu-fields" disabled={!canEdit || locked} aria-label="编辑飞书群绑定">
            <label className="feishu-field feishu-chat">
              <span>飞书群 ID</span>
              <input className="input mono" placeholder="oc_…" value={draft.chatId} autoComplete="off" spellCheck={false} onChange={(event) => {
                setDraft({ ...draft, chatId: event.target.value }); setError(undefined); setNotice(undefined)
              }} />
            </label>
            <div className="feishu-mappings-head">
              <div>
                <h3>成员映射</h3>
                <p id={hintId}>用同一企业应用下的飞书 Open ID 对应空间成员。群里的操作以该成员身份和权限执行。</p>
              </div>
              {canEdit && <button type="button" className="btn" onClick={addRow} disabled={members.length === 0}><Plus aria-hidden /> 添加映射</button>}
            </div>
            {draft.members.length === 0 ? <p className="feishu-empty">还没有成员映射。</p> : (
              <ol className="feishu-mappings" aria-describedby={hintId}>
                {draft.members.map(({ key, openId, memberId }, index) => (
                  <li key={key} className="feishu-mapping">
                    <label className="feishu-field">
                      <span>飞书 Open ID</span>
                      <input className="input mono" placeholder="ou_…" value={openId} autoFocus={key === newRow} autoComplete="off" spellCheck={false}
                        onChange={(event) => updateRow(key, { openId: event.target.value })} />
                    </label>
                    <label className="feishu-field">
                      <span>空间成员</span>
                      <select className="select" value={memberId} onChange={(event) => updateRow(key, { memberId: event.target.value })}>
                        <option value="" disabled>选择空间成员</option>
                        {memberId && !known.has(memberId) && <option value={memberId} disabled>{memberId}（已不在空间）</option>}
                        {members.map((member) => <option key={member.id} value={member.id}>
                          {member.name}（{member.role}{member.name === member.id ? '' : ` · ${member.id}`}）
                        </option>)}
                      </select>
                    </label>
                    {canEdit && <button type="button" className="btn btn-ghost btn-icon feishu-remove" aria-label={`移除第 ${index + 1} 条映射`} title="移除映射" onClick={() => {
                      setDraft({ ...draft, members: draft.members.filter((row) => row.key !== key) }); setError(undefined); setNotice(undefined)
                    }}><X aria-hidden /></button>}
                  </li>
                ))}
              </ol>
            )}
          </fieldset>
          {!confirm && error && <p className="feishu-message feishu-error" role="alert">{error}</p>}
          {canEdit && <div className="feishu-actions">
            <button type="submit" className="btn btn-primary" disabled={locked || !dirty}>{busy === 'save' ? '保存中' : '保存绑定'}</button>
            {status.binding && <button type="button" className="btn" disabled={locked} onClick={() => { setError(undefined); setConfirm(true) }}><Unplug aria-hidden /> 解绑群</button>}
          </div>}
        </form>
      </div>
      {binding && <Dialog open={confirm} onClose={() => { if (!busy) setConfirm(false) }} dismissible={!busy} tone="danger" size="sm"
        title="解绑飞书群？" description="解绑会移除该群和全部成员映射。群消息和卡片操作将不再进入此空间，网页里的团队对话不受影响。"
        footer={<>
          <button type="button" className="btn" data-autofocus disabled={!!busy} onClick={() => setConfirm(false)}>取消</button>
          <button type="button" className="btn btn-danger" disabled={!!busy} onClick={() => void apply('unbind', { chatId: null, baseRevision: binding.revision })}>
            {busy === 'unbind' ? '解绑中' : '确认解绑'}
          </button>
        </>}>
        <p className="mono feishu-group-id">{binding.chatId}</p>
        {error && <p className="feishu-message feishu-error" role="alert">{error}</p>}
      </Dialog>}
    </>
  )
}
