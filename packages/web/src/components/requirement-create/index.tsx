import { useEffect, useRef, useState } from 'react'
import { useAsync, useSource, invalidate } from '../../api'
import { navigate } from '../../lib/router'
import { closeCreateRequirement, useCreateRequirement } from '../../lib/ui-store'
import { Dialog, Kbd, toast } from '../ui'
import { AcceptanceAssist } from './ac-assist'
import { clearDraft, descriptionOf, emptyDraft, hasContent, loadDraft, saveDraft, titleOf, uniqueAttachmentNames, type Attachment, type RequirementDraft } from './draft'
import { DraftEditor } from './editor'
import { insertAcceptance } from './estimate'
import { LinksTag } from './links'
import { RouteTag } from './route-tag'
import { BudgetTag, DueTag, PeopleTag, RepoTag } from './tags'
import './create.css'

/** 取消运行后服务端要过一会儿才把运行落成 cancelled：归档遇到 409 时短暂重试（最多约 6 秒）。 */
async function archiveWhenIdle(archive: () => Promise<unknown>, retry: boolean): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await archive()
      return
    } catch (e) {
      if (!retry || i >= 11 || (e as { status?: number }).status !== 409) throw e
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}

/**
 * 新建需求对话框（docs/design/22 §2.1）。全局一份，挂在 app.tsx；props 无。
 * 开关：lib/ui-store 的 openCreateRequirement(prefill?) / closeCreateRequirement()；
 * 入口：侧栏"需求"旁 +、C 键、需求页主按钮（NewRequirementButton）、总览空状态、⌘K、管家。
 * 大文本框（首行即标题）→ 标签行（流程 / 仓库 / 成员 / 预算 / 截止 / 链接）→ 附件 → 立即启动；草稿按空间存本地，⌘Enter 提交。
 */
export function RequirementCreateDialog() {
  const st = useCreateRequirement()
  const ds = useSource()
  const [d, setD] = useState<RequirementDraft>(emptyDraft)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [restored, setRestored] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const ctx = useAsync((s) => (st.open ? Promise.all([s.space().catch(() => undefined), s.workflows().catch(() => undefined), s.me().catch(() => undefined)]) : Promise.resolve(undefined)), [st.open])
  const [space, workflows, me] = ctx.data ?? []

  // 每次打开：有预填就用预填，否则恢复本空间的草稿
  useEffect(() => {
    if (!st.open) return
    const p = st.prefill
    if (p?.title || p?.description || p?.workflowId) {
      setD({ ...emptyDraft(), text: [p.title, p.description].filter(Boolean).join('\n\n'), workflowId: p.workflowId })
      setRestored(false)
    } else {
      const saved = loadDraft()
      setD(saved ?? emptyDraft())
      setRestored(!!saved)
    }
    setAttachments([])
    setError(undefined)
    setBusy(false)
  }, [st.open, st.nonce, st.prefill])

  // 草稿随手存（300ms 防抖）
  const first = useRef(true)
  useEffect(() => {
    if (!st.open) return
    if (first.current) {
      first.current = false
      return
    }
    const t = setTimeout(() => saveDraft(d), 300)
    return () => clearTimeout(t)
  }, [d, st.open])
  useEffect(() => {
    if (!st.open) first.current = true
  }, [st.open])

  const patch = (p: Partial<RequirementDraft>) => setD((x) => ({ ...x, ...p }))
  const title = titleOf(d)
  const owner = d.owner ?? me?.id

  const submit = async () => {
    if (!title || busy) return
    setBusy(true)
    setError(undefined)
    try {
      const members = [...new Set(d.members.filter((m) => m !== owner))]
      const r = await ds.createRequirement({
        title,
        description: descriptionOf(d) || undefined,
        start: d.start,
        workflowId: d.workflowId,
        repos: d.repos.length ? d.repos : undefined,
        owner,
        members: members.length ? members : undefined,
        // 服务端 createRequirement 把 budget: undefined 原样交给 run.start，被 schema 拒成"$.budget: expected object"（见 knownIssues）；
        // 启动时没填预算就发 {}（RunBudget 各项可选，等价于按 workflow 默认预算）
        budget: d.budget ?? (d.start ? {} : undefined),
        dueAt: d.dueAt,
        links: d.links.length ? d.links : undefined,
        attachments: attachments.length ? uniqueAttachmentNames(attachments.map((a) => a.name)).map((name, i) => ({ name, content: attachments[i]!.content, encoding: attachments[i]!.encoding })) : undefined,
      })
      const id = r.requirement.id
      clearDraft()
      closeCreateRequirement()
      invalidate()
      const route = r.route ? `${r.route.tier} · ${workflows?.find((w) => w.id === r.route!.workflowId)?.title || r.route.workflowId}` : undefined
      toast(r.runId ? `已创建并启动 ${id}` : `已创建 ${id}`, {
        body: [title, route].filter(Boolean).join(' · '),
        // 已启动时服务端拒绝归档有运行的需求（409）：撤销先取消该运行，再归档
        undoLabel: r.runId ? '撤销（取消运行并归档）' : undefined,
        undo: async () => {
          // 运行可能已经结束（取消会报错）：取消失败不拦撤销，归档时服务端再判一次
          if (r.runId) await ds.runCommand('run.cancel', { input: { runId: r.runId }, reason: '撤销新建需求：取消刚启动的运行' }).catch(() => undefined)
          await archiveWhenIdle(() => ds.archiveRequirement(id, '撤销新建需求'), !!r.runId)
          invalidate()
          navigate('/requirements')
        },
      })
      if (r.startError) toast('需求已创建，但没能启动', { tone: 'waiting', body: r.startError, action: { label: '去需求页', onClick: () => navigate(`/req/${id}`) } })
      navigate(`/req/${id}?tab=chat`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const discard = () => {
    clearDraft()
    setD(emptyDraft())
    setAttachments([])
    setRestored(false)
  }

  return (
    <Dialog
      open={st.open}
      onClose={closeCreateRequirement}
      title="新建需求"
      description="写下背景、目标和验收标准，第一行就是标题；可以直接粘贴 PRD 或拖入文件"
      size="lg"
      dismissible={!hasContent(d)}
      className="rc-dialog"
      footer={
        <>
          <span className="rc-foot-left">
            {error ? (
              <span className="ov-error">{error}</span>
            ) : restored ? (
              <>
                已恢复上次的草稿
                <button type="button" className="rc-link-btn" onClick={discard}>
                  清空
                </button>
              </>
            ) : hasContent(d) ? (
              '草稿自动保存在本机'
            ) : null}
          </span>
          <label className="rc-switch pressable" title="关掉则只创建，稍后在需求页启动">
            <input type="checkbox" role="switch" checked={d.start} onChange={(e) => patch({ start: e.target.checked })} />
            <span className="rc-switch-track" aria-hidden>
              <span className="rc-switch-thumb" />
            </span>
            创建后立即启动
          </label>
          <button type="button" className="btn" onClick={closeCreateRequirement}>
            取消
          </button>
          <button type="button" className="btn btn-primary" disabled={!title || busy} onClick={() => void submit()} title="⌘Enter 提交">
            {busy ? <span className="shimmer-text">正在创建</span> : d.start ? '创建并启动' : '创建'}
            <Kbd combo="mod+enter" />
          </button>
        </>
      }
    >
      <div
        className="rc-body"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            void submit()
          }
        }}
      >
        <div className="rc-title-row">
          <input
            className="rc-title"
            value={d.title ?? title}
            onChange={(e) => patch({ title: e.target.value })}
            placeholder="标题（默认取第一行）"
            aria-label="标题"
          />
          {d.title !== undefined && (
            <button type="button" className="rc-link-btn" onClick={() => patch({ title: undefined })} title="标题重新跟随第一行">
              跟随首行
            </button>
          )}
        </div>
        <DraftEditor text={d.text} onText={(text) => patch({ text })} attachments={attachments} onAttachments={setAttachments} />
        <div className="rc-tags" role="group" aria-label="需求属性">
          <RouteTag text={`${title}\n${d.text}`} workflows={workflows} value={d.workflowId} onChange={(workflowId) => patch({ workflowId })} />
          <RepoTag repos={space?.repos} value={d.repos} onChange={(repos) => patch({ repos })} />
          <PeopleTag members={space?.members} owner={owner} value={d.members} onOwner={(o) => patch({ owner: o })} onChange={(members) => patch({ members })} />
          <BudgetTag value={d.budget} onChange={(budget) => patch({ budget })} />
          <DueTag value={d.dueAt} onChange={(dueAt) => patch({ dueAt })} />
          <LinksTag value={d.links} onChange={(links) => patch({ links })} />
        </div>
        <AcceptanceAssist text={d.text} title={title} onInsert={(item) => setD((x) => ({ ...x, text: insertAcceptance(x.text, item) }))} />
      </div>
    </Dialog>
  )
}
