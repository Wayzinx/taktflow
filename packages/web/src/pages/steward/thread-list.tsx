import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { Archive, ArchiveRestore, ChevronRight, Hourglass, ListFilter, MoreHorizontal, OctagonAlert, Pause, Pencil, Pin, PinOff, Search, Trash2, X } from 'lucide-react'
import type { StewardThread } from '@taktflow/core'
import { useAsync, useSource } from '../../api'
import { StewardMark } from '../../components/identity'
import { stripCitations } from '../../components/steward/cite-text'
import { Dialog, EmptyState, HoverCard, Menu, SkeletonRows, toast, useFlashRows, useHoverCard, useStagger, type MenuItem } from '../../components/ui'
import { fmtRelative, fmtTime } from '../../lib/format'
import { Link } from '../../lib/router'
import { groupThreads, type GroupBy } from './thread-groups'

/** 列表预览用纯文本：去掉 Markdown 链接 / 粗体 / 行内代码与 [n] 引用标记。 */
const plain = (t: string) => stripCitations(t.replace(/\[([^\]\n]+)\]\([^)\s]*\)/g, '$1').replace(/\*\*|`/g, ''))

const GROUPS: Array<{ id: GroupBy; label: string }> = [
  { id: 'time', label: '按最近对话' },
  { id: 'space', label: '按空间' },
  { id: 'requirement', label: '按需求' },
  { id: 'status', label: '按状态' },
]
const GROUP_KEY = 'taktflow.solo.threadGroup'
function readGroup(): GroupBy {
  try {
    const v = localStorage.getItem(GROUP_KEY)
    return GROUPS.some((g) => g.id === v) ? (v as GroupBy) : 'time'
  } catch {
    return 'time'
  }
}
function saveGroup(v: GroupBy) {
  try {
    localStorage.setItem(GROUP_KEY, v)
  } catch {
    // 无痕窗口等存不了就算了，只是下次回到默认分组
  }
}

/** 会话的状态徽标（docs/design/30 §2）：回复中、待你决定、出错、已中断；可以同时有两个（出错 + 待决定）。 */
function tagsOf(t: StewardThread): Array<{ key: string; tone: string; icon?: typeof Hourglass; label: string; live?: boolean }> {
  const tags = []
  if (t.status === 'replying') tags.push({ key: 'replying', tone: 'running', label: '回复中', live: true })
  if ((t.pendingProposals ?? 0) > 0) tags.push({ key: 'pending', tone: 'waiting', icon: Hourglass, label: `${t.pendingProposals} 个待决定` })
  if (t.status === 'error') tags.push({ key: 'error', tone: 'failed', icon: OctagonAlert, label: '出错' })
  if (t.status === 'interrupted') tags.push({ key: 'interrupted', tone: 'stale', icon: Pause, label: '已中断' })
  return tags
}

/** 会话的悬停卡：所在空间 / 需求（可点）、harness · 模型、消息数、更新时间、待决定的提案。 */
function ThreadCard({ t, spaceName }: { t: StewardThread; spaceName: (id: string) => string | undefined }) {
  const runtime = t.runtime ? [t.runtime.harness === 'native' || !t.runtime.harness ? '内置' : t.runtime.harness, t.runtime.model].filter(Boolean).join(' · ') : '跟随默认设置'
  return (
    <div className="stwp-card">
      <div className="stwp-card-title">{t.title}</div>
      <dl className="stwp-card-facts">
        {t.spaceId && (
          <>
            <dt>空间</dt>
            <dd>
              <Link to={`/s/${t.spaceId}/`}>{spaceName(t.spaceId) ?? t.spaceId}</Link>
            </dd>
          </>
        )}
        {t.requirementId && (
          <>
            <dt>需求</dt>
            <dd className="truncate">
              <Link to={`/s/${t.spaceId}/req/${t.requirementId}`}>
                <span className="mono">{t.requirementId}</span> {t.requirementTitle}
              </Link>
            </dd>
          </>
        )}
        <dt>运行</dt>
        <dd className="mono truncate">{runtime}</dd>
        <dt>消息</dt>
        <dd className="num">{t.messageCount ?? '—'}</dd>
        <dt>更新</dt>
        <dd className="num">{fmtTime(t.updatedAt)}</dd>
        {(t.pendingProposals ?? 0) > 0 && (
          <>
            <dt>待决定</dt>
            <dd className="num">{t.pendingProposals} 个提案</dd>
          </>
        )}
      </dl>
      {t.status === 'error' && t.error && <p className="stwp-card-error">{t.error}</p>}
    </div>
  )
}

function ThreadRow({ t, current, onPick, onChanged, spaceName, rowClass, rowStyle }: { t: StewardThread; current?: string; onPick: (id: string) => void; onChanged: (deletedId?: string) => void; spaceName: (id: string) => string | undefined; rowClass?: string; rowStyle?: CSSProperties }) {
  const ds = useSource()
  const hc = useHoverCard<HTMLLIElement>()
  const more = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(t.title)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)

  // 置顶 / 归档带撤销：给了 undo 就是它的反向补丁
  async function patch(p: Parameters<typeof ds.patchStewardThread>[1], done: string, undo?: Parameters<typeof ds.patchStewardThread>[1]) {
    setBusy(true)
    try {
      await ds.patchStewardThread(t.id, p)
      toast(done, undo ? { undo: () => ds.patchStewardThread(t.id, undo).then(() => onChanged()) } : undefined)
      onChanged()
    } catch (e) {
      toast('没改成', { tone: 'failed', body: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  async function rename() {
    setEditing(false)
    const title = draft.trim()
    if (!title || title === t.title) return setDraft(t.title)
    await patch({ title }, '已重命名')
  }
  async function remove() {
    setBusy(true)
    try {
      await ds.deleteStewardThread(t.id)
      setConfirm(false)
      toast('会话已删除')
      onChanged(t.id)
    } catch (e) {
      toast('删不了', { tone: 'failed', body: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') void rename()
    if (e.key === 'Escape') {
      setDraft(t.title)
      setEditing(false)
    }
  }
  const items: MenuItem[] = [
    { id: 'rename', label: '重命名', icon: Pencil, onSelect: () => (setDraft(t.title), setEditing(true)) },
    { id: 'pin', label: t.pinnedAt ? '取消置顶' : '置顶', icon: t.pinnedAt ? PinOff : Pin, onSelect: () => void patch({ pinned: !t.pinnedAt }, t.pinnedAt ? '已取消置顶' : '已置顶', { pinned: Boolean(t.pinnedAt) }) },
    { id: 'archive', label: t.archivedAt ? '移出归档' : '归档', icon: t.archivedAt ? ArchiveRestore : Archive, onSelect: () => void patch({ archived: !t.archivedAt }, t.archivedAt ? '已移出归档' : '已归档', { archived: Boolean(t.archivedAt) }) },
    { id: 'delete', label: '删除', icon: Trash2, danger: true, separator: true, onSelect: () => setConfirm(true) },
  ]
  const tags = tagsOf(t)
  const head = (
    <span className="stwp-item-top">
      {t.pinnedAt && <Pin className="stwp-pin" aria-label="已置顶" />}
      {editing ? (
        <input className="input input-sm stwp-rename" value={draft} autoFocus maxLength={80} aria-label="会话标题" onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} onBlur={() => void rename()} onClick={(e) => e.stopPropagation()} />
      ) : (
        <span className="stwp-item-title truncate">{t.title}</span>
      )}
      <span className="faint num">{fmtRelative(t.updatedAt)}</span>
    </span>
  )
  const body = (
    <>
      {head}
      {t.lastMessage && <span className="stwp-item-last truncate">{plain(t.lastMessage)}</span>}
      {tags.length > 0 && (
        <span className="stwp-tags">
          {tags.map((g) => (
            <span key={g.key} className="stw-tag" data-tone={g.tone}>
              {g.live ? <StewardMark size={14} state="work" label="" /> : g.icon && <g.icon aria-hidden />}
              {g.label}
            </span>
          ))}
        </span>
      )}
    </>
  )
  return (
    <li ref={hc.ref} className={`stwp-row${menu ? ' menu-open' : ''} ${rowClass ?? ''}`} style={rowStyle} {...hc.bind}>
      {editing ? (
        <div className="stwp-item" aria-current={t.id === current ? 'true' : undefined}>
          {body}
        </div>
      ) : (
        <button type="button" className="stwp-item pressable" aria-current={t.id === current ? 'true' : undefined} onClick={() => onPick(t.id)} disabled={busy}>
          {body}
        </button>
      )}
      <button ref={more} type="button" className="btn btn-ghost btn-icon btn-sm stwp-more" aria-label={`${t.title} 的操作`} aria-haspopup="menu" aria-expanded={menu} onClick={() => (hc.close(), setMenu(true))}>
        <MoreHorizontal />
      </button>
      <Menu open={menu} onClose={() => setMenu(false)} anchor={more} items={items} placement="bottom-end" ariaLabel="会话操作" minWidth={160} />
      {!menu && !editing && (
        <HoverCard {...hc.card}>
          <ThreadCard t={t} spaceName={spaceName} />
        </HoverCard>
      )}
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="删除这个会话？"
        description="会话和里面的消息都会删掉，不能恢复。动态里指向它的条目会保留。只是不想看到，可以改成归档。"
        tone="danger"
        size="sm"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setConfirm(false)}>
              取消
            </button>
            <button type="button" className="btn" onClick={() => (setConfirm(false), void patch({ archived: true }, '已归档', { archived: false }))}>
              改成归档
            </button>
            <button type="button" className="btn btn-danger" onClick={() => void remove()} disabled={busy}>
              删除
            </button>
          </>
        }
      />
    </li>
  )
}

/** 已归档：默认收起，点开才去拉。 */
function ArchivedGroup({ current, onPick, onChanged, spaceName }: { current?: string; onPick: (id: string) => void; onChanged: (deletedId?: string) => void; spaceName: (id: string) => string | undefined }) {
  const [open, setOpen] = useState(false)
  const [tick, setTick] = useState(0)
  const q = useAsync((ds) => (open ? ds.stewardThreads({ archived: true }) : Promise.resolve(undefined)), [open, tick])
  const changed = (id?: string) => {
    setTick((n) => n + 1)
    onChanged(id)
  }
  return (
    <section className="stwp-group stwp-archived">
      <button type="button" className="stwp-group-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <ChevronRight className="stwp-chev" aria-hidden />
        已归档
        {q.data && <span className="faint num">{q.data.length}</span>}
      </button>
      {open &&
        (!q.data ? (
          <SkeletonRows rows={2} />
        ) : q.data.length === 0 ? (
          <p className="stwp-group-empty faint">没有归档的会话</p>
        ) : (
          <ul className="stwp-list" aria-label="已归档的会话">
            {q.data.map((t) => (
              <ThreadRow key={t.id} t={t} current={current} onPick={onPick} onChanged={changed} spaceName={spaceName} />
            ))}
          </ul>
        ))}
    </section>
  )
}

/** 会话列表（docs/design/30 §2）：搜索、分组（存在本机）、置顶 / 归档 / 删除 / 重命名、悬停卡、状态徽标。 */
export function ThreadList({ threads, current, onPick, onChanged }: { threads: StewardThread[]; current?: string; onPick: (id: string) => void; onChanged: (deletedId?: string) => void }) {
  const [q, setQ] = useState('')
  const [by, setBy] = useState<GroupBy>(readGroup)
  const [groupMenu, setGroupMenu] = useState(false)
  const groupBtn = useRef<HTMLButtonElement>(null)
  const spaces = useAsync((ds) => (by === 'space' ? ds.spaces() : Promise.resolve([])), [by === 'space'])
  const spaceName = (id: string) => spaces.data?.find((s) => s.id === id)?.name
  const list = useMemo(() => threads.filter((t) => !q.trim() || t.title.toLowerCase().includes(q.trim().toLowerCase())), [threads, q])
  const groups = groupThreads(list, by, spaceName)
  const st = useStagger(list.length)
  const flash = useFlashRows(threads.map((t) => t.id))
  let n = 0
  return (
    <>
      <div className="stwp-search">
        <Search aria-hidden />
        <input className="stwp-search-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="按标题搜索会话" aria-label="搜索会话" />
        {q && (
          <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="清空" onClick={() => setQ('')}>
            <X />
          </button>
        )}
        <button ref={groupBtn} type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="分组方式" title={GROUPS.find((g) => g.id === by)!.label} aria-haspopup="menu" aria-expanded={groupMenu} onClick={() => setGroupMenu(true)}>
          <ListFilter />
        </button>
        <Menu
          open={groupMenu}
          onClose={() => setGroupMenu(false)}
          anchor={groupBtn}
          placement="bottom-end"
          ariaLabel="分组方式"
          items={GROUPS.map((g) => ({ id: g.id, label: g.label, checked: g.id === by, onSelect: () => (setBy(g.id), saveGroup(g.id)) }))}
        />
      </div>
      {list.length === 0 ? (
        <EmptyState compact title={q ? '没有匹配的会话' : '还没有会话'} body={q ? '换个关键词试试' : '在右边问一句，就会开始第一个会话'} />
      ) : (
        groups.map((g) => (
          <section key={g.key} className="stwp-group" aria-label={g.label}>
            <h4 className="stwp-group-head is-static">
              {g.label}
              <span className="faint num">{g.items.length}</span>
            </h4>
            <ul className="stwp-list">
              {g.items.map((t) => {
                const s = st(n++)
                return <ThreadRow key={t.id} t={t} current={current} onPick={onPick} onChanged={onChanged} spaceName={spaceName} rowClass={`${s.className ?? ''} ${flash(t.id)}`} rowStyle={s.style} />
              })}
            </ul>
          </section>
        ))
      )}
      {!q && <ArchivedGroup current={current} onPick={onPick} onChanged={onChanged} spaceName={spaceName} />}
    </>
  )
}
