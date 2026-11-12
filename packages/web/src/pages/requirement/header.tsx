import { useState, type ReactNode } from 'react'
import { Archive, ArrowUpRight, Ban, CalendarClock, Play, Plus } from 'lucide-react'
import type { RequirementDetail, RequirementUpdateRequest } from '@taktflow/core'
import { invalidate, useAsync, useSource } from '../../api'
import { LinkEditor } from '../../components/requirement-create/links'
import { DuePicker } from '../../components/requirement-create/tags'
import { fmtDue } from '../../components/requirement-create/draft'
import { Avatar, AvatarStack, Skeleton, StatusBadge, toast, vtName } from '../../components/ui'
import { fmtCost, fmtRelative, fmtTokens, totalTokens } from '../../lib/format'
import { Link } from '../../lib/router'
import { REQ_STATUS } from '../../lib/status'
import { DeliveryButton } from '../../components/delivery-button'
import { RequirementActions, StartRunButton } from './header-actions'
import { FactButton, InlineText } from './header-edit'
import { cancelledRunOf } from './termination'
import './header.css'

const LINK_LABEL: Record<string, string> = { meego: 'Meego', feishu: '飞书', github: 'GitHub', jira: 'Jira', url: '链接' }
type Field = 'title' | 'description' | 'owner' | 'dueAt' | 'links'
const FIELD_LABEL: Record<Field, string> = { title: '标题', description: '描述', owner: '负责人', dueAt: '截止时间', links: '关联链接' }
/** 运行被人工终止后需求仍是 blocked，展示上改叫"已终止"（core 的派生语义不动）。 */
const TERMINATED = { label: '已终止', tone: 'skipped' as const, icon: Ban, hint: '最近一次运行被人工终止，可以重新启动' }

/**
 * 需求页头：id、状态、链接、成员、标题、一句话状态、描述、事实行。
 * 标题 / 描述 / 负责人 / 截止时间 / 链接就地编辑（PATCH，原因自动写"在需求页修改 X"），改完提示可撤销；
 * 右侧"⋯"归档 / 恢复 / 删除（只有没有运行记录的才能删）。
 */
export function RequirementHeader({ id, detail: r, status, onChanged }: { id: string; detail?: RequirementDetail; status?: ReactNode; onChanged: () => void }) {
  const ds = useSource()
  const space = useAsync((s) => s.space(), [])
  const members = space.data?.members ?? []
  const [descOpen, setDescOpen] = useState(false)

  const save = async (field: Field, patch: Omit<RequirementUpdateRequest, 'reason'>, undoPatch: Omit<RequirementUpdateRequest, 'reason'>) => {
    await ds.updateRequirement(id, { ...patch, reason: `在需求页修改${FIELD_LABEL[field]}` })
    onChanged()
    invalidate()
    toast(`已更新${FIELD_LABEL[field]}`, { undo: () => ds.updateRequirement(id, { ...undoPatch, reason: `撤销修改${FIELD_LABEL[field]}` }).then(() => (onChanged(), invalidate())) })
  }
  const nameOf = (m?: string) => members.find((x) => x.id === m)?.name ?? m
  const longDesc = (r?.description?.split('\n').length ?? 0) > 3 || (r?.description?.length ?? 0) > 220
  const cancelled = r ? cancelledRunOf(r) : undefined

  return (
    <>
      {r?.status === 'archived' && (
        <div className="rh-archived">
          <Archive aria-hidden />
          这个需求已归档{r.archivedAt ? `（${fmtRelative(r.archivedAt)}）` : ''}，不会再启动运行。
          <button type="button" className="btn btn-sm" onClick={() => void ds.restoreRequirement(id, '在需求页恢复').then(() => (onChanged(), invalidate(), toast(`已恢复 ${id}`)))}>
            恢复
          </button>
        </div>
      )}
      {cancelled && r && (
        <div className="rh-archived rh-terminated" role="status">
          <Ban aria-hidden />
          最近一次运行已被人工终止（取消）{cancelled.endedAt ? `，${fmtRelative(cancelled.endedAt)}` : ''}，没有待办需要处理。
          <StartRunButton r={r} onChanged={onChanged} label="重新启动" />
        </div>
      )}
      <div className="req-header-top">
        <span className="req-id-chip mono">{id}</span>
        {r ? <StatusBadge meta={cancelled ? TERMINATED : REQ_STATUS[r.status]} /> : <Skeleton w={56} h={20} r={10} />}
        {r?.links.map((l) => (
          <a key={l.url} className="chip rh-link-chip" href={l.url} target="_blank" rel="noreferrer">
            <ArrowUpRight />
            {LINK_LABEL[l.type] ?? l.type}
            {l.title && <span className="faint">· {l.title}</span>}
          </a>
        ))}
        {r && (
          <FactButton label="关联链接" width={340} pop={() => <LinkEditor value={r.links} onChange={(links) => void save('links', { links }, { links: r.links }).catch((e: Error) => toast('链接没保存上', { tone: 'failed', body: e.message }))} />}>
            <Plus />
            {r.links.length ? '' : '关联链接'}
          </FactButton>
        )}
        <span style={{ flex: 1 }} />
        {r?.members && <AvatarStack names={r.members} />}
        <DeliveryButton runId={r?.latestRunId} />
        {r?.latestRunId && (
          <Link to={`/run/${r.latestRunId}`} className="btn btn-sm">
            <Play />
            最近运行
          </Link>
        )}
        {r && !r.latestRunId && r.status !== 'archived' && r.status !== 'delivered' && <StartRunButton r={r} onChanged={onChanged} />}
        {r && <RequirementActions r={r} onChanged={onChanged} />}
      </div>
      <h1 className="req-h1 rh-h1" style={{ viewTransitionName: vtName('req', id) }}>
        {r ? <InlineText label="标题" value={r.title} onSave={(title) => save('title', { title }, { title: r.title })} className="rh-title" /> : <Skeleton w={320} h={24} />}
      </h1>
      {status}
      {r && (
        <div className={`rh-desc${longDesc && !descOpen ? ' clamped' : ''}`}>
          <InlineText
            label="描述"
            multiline
            value={r.description ?? ''}
            placeholder="添加背景、目标和验收标准"
            onSave={(description) => save('description', { description }, { description: r.description ?? '' })}
            view={r.description ? <span className="rh-desc-text">{r.description}</span> : undefined}
          />
          {longDesc && (
            <button type="button" className="rh-more" onClick={() => setDescOpen((o) => !o)} aria-expanded={descOpen}>
              {descOpen ? '收起' : '展开全部'}
            </button>
          )}
        </div>
      )}
      <div className="req-facts">
        {r ? (
          <>
            <FactButton
              label="负责人"
              pop={(close) => (
                <div className="rc-check-list">
                  {members.map((m) => (
                    <button key={m.id} type="button" className={`rh-person pressable${m.id === r.owner ? ' on' : ''}`} onClick={() => (close(), m.id !== r.owner && void save('owner', { owner: m.id }, { owner: r.owner ?? '' }).catch((e: Error) => toast('负责人没改成', { tone: 'failed', body: e.message })))}>
                      <Avatar name={m.name} id={m.id} size={18} />
                      <span className="truncate">{m.name}</span>
                      <span className="faint">{m.duties?.join(' / ')}</span>
                    </button>
                  ))}
                  {!members.length && <p className="rc-pop-empty">空间里还没有成员。</p>}
                </div>
              )}
            >
              {r.owner ? <Avatar name={nameOf(r.owner)!} id={r.owner} size={16} /> : null}
              {r.owner ? nameOf(r.owner) : '指定负责人'}
            </FactButton>
            <FactButton label="截止时间" pop={(close) => <DuePicker value={r.dueAt} onPick={(v) => (close(), void save('dueAt', { dueAt: v ?? null }, { dueAt: r.dueAt ?? null }).catch((e: Error) => toast('截止时间没改成', { tone: 'failed', body: e.message })))} />}>
              <CalendarClock />
              {r.dueAt ? <span className={Date.parse(r.dueAt) < Date.now() ? 'rh-overdue' : undefined}>截止 {fmtDue(r.dueAt)}</span> : '设截止时间'}
            </FactButton>
            <span className="req-fact">创建于 {fmtRelative(r.createdAt)}</span>
            <span className="req-fact">更新于 {fmtRelative(r.updatedAt)}</span>
            <span className="req-fact" title="这个需求全部运行（含 Lead 回合、临时任务）的用量合计；预算条只统计最近一次流水线运行">
              <span className="mono">{fmtTokens(totalTokens(r.usage))}</span> tokens · 全部 {r.runs.length} 次运行合计
              {r.usage.costUsd ? (
                <>
                  {' · '}
                  <span className="mono">{fmtCost(r.usage.costUsd)}</span>
                </>
              ) : null}
            </span>
            <span className="req-fact">
              公共存放区 <span className="mono">.takt/workspaces/{id}/</span>
            </span>
          </>
        ) : (
          <Skeleton w={420} h={12} />
        )}
      </div>
    </>
  )
}
