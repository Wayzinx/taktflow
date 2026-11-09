import { useRef, useState, type CSSProperties } from 'react'
import { BellRing, CalendarClock, FileText, History, MoreHorizontal, OctagonAlert, Pencil, Play, Plus, Trash2, Zap, type LucideIcon } from 'lucide-react'
import type { AutomationAction, AutomationConfig, AutomationView, ChannelView } from '@taktflow/core'
import { useAsync, useSource } from '../../api'
import { useCrumbs } from '../../components/layout'
import { EmptyState, ErrorState, Menu, PageHeader, ReasonDialog, SkeletonRows, StatusDot, Switch, toast, useStagger, type MenuItem } from '../../components/ui'
import { fmtRelative, fmtUpcoming } from '../../lib/format'
import { ChannelEditor, ChannelsCard } from './channels'
import { AutomationEditor } from './editor'
import { actionText, blankAutomation, CHANNEL_KINDS, freeId, RUN_STATUS, TEMPLATES, triggerText, type Template } from './model'
import { RunLog } from './run-log'
import './automations.css'

const ACTION_ICON: Record<AutomationAction['kind'], LucideIcon> = { digest: FileText, notify: BellRing, start_workflow: Play }

function AutomationRow({ a, channels, onEdit, onLog, onChanged, stagger }: { a: AutomationView; channels: ChannelView[]; onEdit: () => void; onLog: () => void; onChanged: () => void; stagger?: { className?: string; style?: CSSProperties } }) {
  const ds = useSource()
  const more = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [busy, setBusy] = useState<'run' | 'toggle'>()
  const Icon = ACTION_ICON[a.action.kind]
  const scheduled = 'schedule' in a.trigger
  const TriggerIcon = scheduled ? CalendarClock : Zap
  const names = (a.notify?.channels ?? []).map((id) => {
    const c = channels.find((x) => x.id === id)
    return c ? `${CHANNEL_KINDS[c.kind].label} · ${c.title ?? c.id}` : id
  })
  const config = (v: AutomationView): AutomationConfig => {
    const { nextAt: _n, lastRun: _l, problems: _p, ...rest } = v
    return rest
  }

  const toggle = async (enabled: boolean) => {
    setBusy('toggle')
    try {
      await ds.saveAutomation({ ...config(a), enabled }, `${enabled ? '启用' : '停用'}「${a.title}」`)
      toast(enabled ? `已启用「${a.title}」` : `已停用「${a.title}」`, { undo: () => ds.saveAutomation({ ...config(a), enabled: !enabled }, `撤销：${enabled ? '停用' : '启用'}「${a.title}」`).then(onChanged) })
      onChanged()
    } catch (e) {
      toast('没改成', { tone: 'failed', body: (e as Error).message })
    } finally {
      setBusy(undefined)
    }
  }
  const run = async () => {
    setBusy('run')
    try {
      const r = await ds.triggerAutomation(a.id, `手动执行「${a.title}」`)
      const bad = r.deliveries.filter((d) => !d.ok)
      toast(r.status === 'ok' ? `执行完了：${a.title}` : r.status === 'skipped' ? `跳过了：${a.title}` : `执行失败：${a.title}`, { tone: r.status === 'failed' ? 'failed' : undefined, body: bad.length ? `${r.summary}（${bad.map((d) => d.channel).join('、')} 没发出去）` : r.summary })
      onChanged()
    } catch (e) {
      toast('没执行成', { tone: 'failed', body: (e as Error).message })
    } finally {
      setBusy(undefined)
    }
  }

  const last = a.lastRun
  const items: MenuItem[] = [
    { id: 'edit', label: '编辑', icon: Pencil, onSelect: onEdit },
    { id: 'log', label: '执行记录', icon: History, onSelect: onLog },
    { id: 'delete', label: '删除', icon: Trash2, danger: true, separator: true, onSelect: () => setRemoving(true) },
  ]
  return (
    <li className={`au-row${a.enabled ? '' : ' off'}${stagger?.className ? ` ${stagger.className}` : ''}`} style={stagger?.style}>
      <span className="au-row-icon" data-kind={a.action.kind}>
        <Icon aria-hidden />
      </span>
      <button type="button" className="au-row-main" onClick={onEdit}>
        <b className="truncate">{a.title}</b>
        <span className="au-row-line">
          <TriggerIcon aria-hidden />
          <span className="truncate">
            {triggerText(a)} · {actionText(a)}
            {names.length ? ` → ${names.join('、')}` : ''}
          </span>
        </span>
        {a.problems?.length ? (
          <span className="au-row-problem">
            <OctagonAlert aria-hidden />
            <span className="truncate">{a.problems.join('；')}</span>
          </span>
        ) : null}
      </button>
      <span className="au-row-status">
        {a.enabled && a.nextAt && <span className="faint">下次 {fmtUpcoming(a.nextAt)}</span>}
        {last ? (
          <button type="button" className="au-last pressable" onClick={onLog} title={last.summary}>
            <StatusDot tone={RUN_STATUS[last.status].tone} pulse={last.status === 'running'} />
            <span className="truncate">
              {fmtRelative(last.at)} · {RUN_STATUS[last.status].label}
            </span>
          </button>
        ) : (
          <span className="faint">还没执行过</span>
        )}
      </span>
      <button type="button" className="btn btn-sm" onClick={() => void run()} disabled={!!busy || !!a.problems?.length} title={a.problems?.length ? '先处理上面的问题' : '现在就执行一次'}>
        <Play aria-hidden />
        {busy === 'run' ? '执行中…' : '立即执行'}
      </button>
      {/* 开关的写原因由动作本身生成（"停用「每日进展」"），不再弹框 */}
      <Switch on={a.enabled} label={`${a.enabled ? '停用' : '启用'}「${a.title}」`} onChange={(v) => void toggle(v)} disabled={!!busy} />
      <button ref={more} type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={`${a.title} 的更多操作`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(true)}>
        <MoreHorizontal />
      </button>
      <Menu open={menu} onClose={() => setMenu(false)} anchor={more} placement="bottom-end" items={items} />
      <ReasonDialog
        open={removing}
        onClose={() => setRemoving(false)}
        risk="dangerous"
        title={`删除自动化「${a.title}」`}
        description="从空间配置里删掉；执行记录会保留。只是想暂停的话，关掉右边的开关就行。"
        confirmLabel="删除"
        onSubmit={async (reason) => {
          await ds.deleteAutomation(a.id, reason)
          toast(`已删除「${a.title}」`)
          onChanged()
        }}
      />
    </li>
  )
}

function Templates({ onPick }: { onPick: (t: Template) => void }) {
  return (
    <ul className="au-templates" aria-label="从模板开始">
      {TEMPLATES.map((t) => {
        const Icon = ACTION_ICON[t.make().action.kind]
        return (
          <li key={t.id}>
            <button type="button" className="au-template pressable" onClick={() => onPick(t)}>
              <span className="au-row-icon" data-kind={t.make().action.kind}>
                <Icon aria-hidden />
              </span>
              <b>{t.title}</b>
              <span className="faint">{t.body}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/** 自动化（docs/design/30 §4）：定时或事件触发，发汇报 / 发消息 / 启动 workflow，结果推到 IM。 */
export function AutomationsPage() {
  useCrumbs([{ label: '自动化' }], [])
  const q = useAsync((d) => d.automations(), [])
  const [editing, setEditing] = useState<{ open: boolean; value: AutomationConfig; isNew: boolean }>({ open: false, value: blankAutomation(), isNew: true })
  const [channel, setChannel] = useState<{ open: boolean; value?: ChannelView }>({ open: false })
  const [log, setLog] = useState<{ open: boolean; value?: AutomationConfig }>({ open: false })
  const newBtn = useRef<HTMLButtonElement>(null)
  const [newMenu, setNewMenu] = useState(false)
  const v = q.data
  const st = useStagger(v?.automations.length ?? 0)
  const ids = v?.automations.map((a) => a.id) ?? []
  const start = (value: AutomationConfig) => {
    // 只有一个渠道时直接替用户勾上
    const only = v?.channels.length === 1 ? [v.channels[0]!.id] : []
    setEditing({ open: true, isNew: true, value: { ...value, id: freeId(value.id, ids), ...(value.notify ? { notify: { channels: value.notify.channels.length ? value.notify.channels : only } } : {}) } })
  }

  return (
    <div className="page au">
      <PageHeader
        title="自动化"
        description="定时或在事件发生时自动做一件事：发进展汇报、发告警、启动 workflow，结果推到飞书 / Slack / Webhook。"
        actions={
          v && v.automations.length > 0 ? (
            <>
              <button ref={newBtn} type="button" className="btn btn-primary" aria-haspopup="menu" aria-expanded={newMenu} onClick={() => setNewMenu(true)}>
                <Plus aria-hidden /> 新建自动化
              </button>
              <Menu
                open={newMenu}
                onClose={() => setNewMenu(false)}
                anchor={newBtn}
                placement="bottom-end"
                minWidth={260}
                items={[
                  ...TEMPLATES.map((t, i): MenuItem => ({ id: t.id, label: t.title, description: t.body, icon: ACTION_ICON[t.make().action.kind], section: i === 0 ? '从模板开始' : undefined, onSelect: () => start(t.make()) })),
                  { id: 'blank', label: '空白', icon: Plus, separator: true, onSelect: () => start(blankAutomation()) },
                ]}
              />
            </>
          ) : undefined
        }
      />
      {q.error && !v ? (
        <div className="card">
          <ErrorState error={q.error} onRetry={q.reload} />
        </div>
      ) : !v ? (
        <div className="card">
          <SkeletonRows rows={4} />
        </div>
      ) : (
        <>
          {v.automations.length === 0 ? (
            <section className="card au-empty">
              <EmptyState title="还没有自动化" body="从一个模板开始：选好时间或事件、发到哪个群，保存就生效。" stewardAsk="帮我建一个自动化：工作日 18:30 把进展发到飞书群" />
              <Templates onPick={(t) => start(t.make())} />
            </section>
          ) : (
            <section className="card" aria-label="自动化列表">
              <ul className="au-list">
                {v.automations.map((a, i) => (
                  <AutomationRow
                    key={a.id}
                    a={a}
                    channels={v.channels}
                    stagger={st(i)}
                    onEdit={() => {
                      const { nextAt: _n, lastRun: _l, problems: _p, ...value } = a
                      setEditing({ open: true, isNew: false, value })
                    }}
                    onLog={() => setLog({ open: true, value: a })}
                    onChanged={q.reload}
                  />
                ))}
              </ul>
            </section>
          )}
          <ChannelsCard channels={v.channels} onAdd={() => setChannel({ open: true })} onEdit={(c) => setChannel({ open: true, value: c })} onChanged={q.reload} />
        </>
      )}
      <AutomationEditor
        open={editing.open}
        onClose={() => setEditing((x) => ({ ...x, open: false }))}
        initial={editing.value}
        isNew={editing.isNew}
        channels={v?.channels ?? []}
        takenIds={ids}
        timezone={v?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}
        onSaved={q.reload}
        onAddChannel={() => setChannel({ open: true })}
      />
      <ChannelEditor open={channel.open} onClose={() => setChannel({ open: false })} initial={channel.value} takenIds={v?.channels.map((c) => c.id) ?? []} onSaved={() => q.reload()} />
      <RunLog automation={log.value} channels={v?.channels ?? []} open={log.open} onClose={() => setLog((x) => ({ ...x, open: false }))} onChanged={q.reload} />
    </div>
  )
}
