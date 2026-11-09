import { useRef, useState } from 'react'
import { Hash, MessageSquare, MoreHorizontal, Pencil, Plus, Send, Trash2, Webhook, type LucideIcon } from 'lucide-react'
import type { ChannelConfig, ChannelView } from '@taktflow/core'
import { useSource } from '../../api'
import { EmptyState, Menu, ReasonDialog, Segmented, toast } from '../../components/ui'
import { EditorDrawer, Field, KeySource } from '../settings/runtime/shared'
import { AUTOMATION_ID, CHANNEL_KINDS } from './model'

const KIND_ICON: Record<ChannelConfig['kind'], LucideIcon> = { feishu: MessageSquare, slack: Hash, webhook: Webhook }
const envName = (id: string, suffix: string) => `TAKT_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_${suffix}`
const ENV = /^[A-Z_][A-Z0-9_]*$/

/** 渠道编辑：地址和签名密钥只存名字（环境变量或本机密钥库），粘贴的值直接进本机密钥库，任何接口都不回传。 */
export function ChannelEditor({ open, onClose, initial, takenIds, onSaved }: { open: boolean; onClose: () => void; initial?: ChannelView; takenIds: string[]; onSaved: (id: string) => void }) {
  const ds = useSource()
  const isNew = !initial
  const blank = (): ChannelConfig => ({ id: '', title: '', kind: 'feishu', urlEnv: '' })
  const [d, setD] = useState<ChannelConfig>(blank)
  const [url, setUrl] = useState('')
  const [secret, setSecret] = useState('')
  const [openKey, setOpenKey] = useState(open)
  if (open !== openKey) {
    setOpenKey(open)
    if (open) {
      setD(initial ? { id: initial.id, title: initial.title, kind: initial.kind, urlEnv: initial.urlEnv, ...(initial.secretEnv ? { secretEnv: initial.secretEnv } : {}) } : blank())
      setUrl('')
      setSecret('')
    }
  }
  const set = (patch: Partial<ChannelConfig>) => setD((x) => ({ ...x, ...patch }))
  const urlEnv = d.urlEnv || (d.id ? envName(d.id, 'URL') : '')
  const secretEnv = d.secretEnv || (secret && d.id ? envName(d.id, 'SECRET') : '')
  const idBad = isNew && (!AUTOMATION_ID.test(d.id) || takenIds.includes(d.id))
  const urlBad = !!url && !/^https?:\/\//.test(url.trim())
  // 地址可以不粘：serve 进程里已有同名环境变量时直接用它；都没有时渠道显示"缺失"
  const canSave = !idBad && !!urlEnv && ENV.test(urlEnv) && (!secretEnv || ENV.test(secretEnv)) && !urlBad
  const signable = d.kind !== 'slack'

  const save = async (reason: string) => {
    if (url.trim()) await ds.putSecret(urlEnv, url.trim(), reason)
    if (secret.trim() && secretEnv) await ds.putSecret(secretEnv, secret.trim(), reason)
    const channel: ChannelConfig = { id: d.id, kind: d.kind, urlEnv, ...(d.title?.trim() ? { title: d.title.trim() } : {}), ...(signable && secretEnv ? { secretEnv } : {}) }
    await ds.saveChannel(channel, reason)
    toast(isNew ? `已添加渠道「${channel.title ?? channel.id}」` : `已保存渠道「${channel.title ?? channel.id}」`, { body: url ? '地址存进了本机密钥库（不进空间目录与 git）。可以点"测试"发一条试试。' : undefined })
    onSaved(channel.id)
  }

  return (
    <EditorDrawer open={open} onClose={onClose} title={isNew ? '添加通知渠道' : `编辑渠道「${initial.title ?? initial.id}」`} description="自动化的结果发到这里。地址只存名字，值放环境变量或本机密钥库。" canSave={canSave} onSave={save} width={520}>
      <Field label="类型" req hint={CHANNEL_KINDS[d.kind].hint}>
        <Segmented<ChannelConfig['kind']> size="sm" ariaLabel="渠道类型" value={d.kind} onChange={(kind) => set({ kind })} options={(Object.keys(CHANNEL_KINDS) as ChannelConfig['kind'][]).map((k) => ({ value: k, label: CHANNEL_KINDS[k].label }))} />
      </Field>
      <div className="au-ed-row">
        <Field label="名字" hint="群名之类，方便认">
          <input className="input" value={d.title ?? ''} placeholder="交付群" onChange={(e) => set({ title: e.target.value })} data-autofocus />
        </Field>
        {isNew && (
          <Field label="id" req>
            <input className={`input mono${idBad && d.id ? ' is-bad' : ''}`} value={d.id} placeholder="team-feishu" onChange={(e) => set({ id: e.target.value.trim() })} />
            {idBad && d.id && <span className="rt-field-err">{takenIds.includes(d.id) ? '已经有这个 id 了' : '只能用小写字母、数字和 -'}</span>}
          </Field>
        )}
      </div>
      <Field label="webhook 地址" hint={initial ? <KeySource name={initial.urlEnv} source={initial.url} /> : '存进本机密钥库'}>
        <input className={`input mono${urlBad ? ' is-bad' : ''}`} type="password" autoComplete="off" value={url} placeholder={initial && initial.url !== 'missing' ? '已配置；要换地址再粘贴' : 'https://open.feishu.cn/open-apis/bot/v2/hook/…'} onChange={(e) => setUrl(e.target.value)} />
        {urlBad && <span className="rt-field-err">要以 http:// 或 https:// 开头</span>}
      </Field>
      <Field label="地址的名字" hint="环境变量名；serve 进程里有这个环境变量时优先用它">
        <input className={`input mono${urlEnv && !ENV.test(urlEnv) ? ' is-bad' : ''}`} value={d.urlEnv} placeholder={urlEnv || 'TAKT_TEAM_FEISHU_URL'} onChange={(e) => set({ urlEnv: e.target.value.trim() })} />
      </Field>
      {signable && (
        <Field label="签名密钥" hint={initial?.secretEnv ? <KeySource name={initial.secretEnv} source={initial.secret} /> : d.kind === 'feishu' ? '机器人开了"签名校验"才需要' : '填了会带 X-Takt-Signature'}>
          <input className="input mono" type="password" autoComplete="off" value={secret} placeholder={initial?.secretEnv ? '已配置；要换再粘贴' : '可选'} onChange={(e) => setSecret(e.target.value)} />
        </Field>
      )}
    </EditorDrawer>
  )
}

function ChannelRow({ c, onEdit, onChanged }: { c: ChannelView; onEdit: () => void; onChanged: () => void }) {
  const ds = useSource()
  const Icon = KIND_ICON[c.kind]
  const more = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [testing, setTesting] = useState(false)
  const test = async () => {
    setTesting(true)
    try {
      const r = await ds.testChannel(c.id, `测试渠道「${c.title ?? c.id}」`)
      if (r.ok) toast(`发出去了：${c.title ?? c.id}`, { body: '去群里看看有没有收到"takt 渠道测试"。' })
      else toast(`没发出去：${c.title ?? c.id}`, { tone: 'failed', body: `${r.status ? `HTTP ${r.status} · ` : ''}${r.error ?? '未知错误'}` })
    } catch (e) {
      toast('没发出去', { tone: 'failed', body: (e as Error).message })
    } finally {
      setTesting(false)
    }
  }
  return (
    <li className="au-ch">
      <span className="au-ch-icon" data-kind={c.kind}>
        <Icon aria-hidden />
      </span>
      <span className="au-ch-main">
        <b className="truncate">{c.title ?? c.id}</b>
        <span className="faint">
          {CHANNEL_KINDS[c.kind].label} · <span className="mono">{c.id}</span>
          {c.usedBy.length ? ` · ${c.usedBy.length} 个自动化在用` : ' · 没有自动化在用'}
        </span>
      </span>
      <KeySource name={c.urlEnv} source={c.url} />
      <button type="button" className="btn btn-sm" onClick={() => void test()} disabled={testing || c.url === 'missing'} title={c.url === 'missing' ? '还没有地址' : '发一条测试消息'}>
        <Send aria-hidden />
        {testing ? '发送中…' : '测试'}
      </button>
      <button ref={more} type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={`${c.title ?? c.id} 的更多操作`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(true)}>
        <MoreHorizontal />
      </button>
      <Menu
        open={menu}
        onClose={() => setMenu(false)}
        anchor={more}
        placement="bottom-end"
        items={[
          { id: 'edit', label: '编辑', icon: Pencil, onSelect: onEdit },
          { id: 'delete', label: '删除', icon: Trash2, danger: true, separator: true, disabled: c.usedBy.length > 0, description: c.usedBy.length ? `先从 ${c.usedBy.join('、')} 里去掉` : undefined, onSelect: () => setRemoving(true) },
        ]}
      />
      <ReasonDialog
        open={removing}
        onClose={() => setRemoving(false)}
        risk="dangerous"
        title={`删除渠道「${c.title ?? c.id}」`}
        description="只删配置；本机密钥库里的地址不会删。"
        confirmLabel="删除"
        onSubmit={async (reason) => {
          await ds.deleteChannel(c.id, reason)
          toast(`已删除渠道「${c.title ?? c.id}」`)
          onChanged()
        }}
      />
    </li>
  )
}

export function ChannelsCard({ channels, onAdd, onEdit, onChanged }: { channels: ChannelView[]; onAdd: () => void; onEdit: (c: ChannelView) => void; onChanged: () => void }) {
  return (
    <section className="card au-channels" aria-labelledby="au-ch-title">
      <div className="card-head">
        <span className="card-title" id="au-ch-title">
          通知渠道
        </span>
        <span className="faint au-head-hint">飞书 / Slack / Webhook</span>
        <span className="spacer" />
        {channels.length > 0 && (
          <button type="button" className="btn btn-sm" onClick={onAdd}>
            <Plus aria-hidden /> 添加渠道
          </button>
        )}
      </div>
      {channels.length ? (
        <ul className="au-ch-list">
          {channels.map((c) => (
            <ChannelRow key={c.id} c={c} onEdit={() => onEdit(c)} onChanged={onChanged} />
          ))}
        </ul>
      ) : (
        <EmptyState compact title="还没有通知渠道" body="加一个飞书群机器人或 Slack webhook，自动化的结果就能推到群里。" action={<button type="button" className="btn btn-sm btn-primary" onClick={onAdd}>添加渠道</button>} />
      )}
    </section>
  )
}
