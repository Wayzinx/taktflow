import { useEffect, useState, type KeyboardEvent } from 'react'
import { FileText, Save } from 'lucide-react'
import type { AgentRoleView, SpaceDetail } from '@taktflow/core'
import { useAsync, useSource } from '../../api'
import type { SpaceFileKind } from '../../api/source'
import { AgentMark } from '../../components/agent-mark'
import { EmptyState, ErrorState, SkeletonRows, toast, useStagger } from '../../components/ui'
import { StewardEditButton } from './ask-steward'
import { RoleForm, RoleHead } from './role-form'
import { selectorText } from './runtime/shared'
import { setQuery, useLocation } from '../../lib/router'
import './space-files.css'

interface Entry {
  name: string
  title: string
  description: string
  harness?: string
  meta: string[]
  role?: AgentRoleView
}

const SOURCE_SHORT: Record<AgentRoleView['effective']['source'], string> = { role: '', 'space-default': '默认路由', builtin: '内置' }

/** 角色优先用结构化接口（含插件角色、生效来源）；服务端没有这个接口时退回空间详情里的列表。 */
function entries(kind: SpaceFileKind, sp: SpaceDetail, roles?: AgentRoleView[]): Entry[] {
  if (kind === 'skill') return sp.skills.map((s) => ({ name: s.name, title: s.name, description: s.description, meta: [s.path] }))
  if (roles)
    return roles.map((r) => {
      const src = SOURCE_SHORT[r.effective.source]
      return { name: r.role, title: r.title, description: r.description, harness: r.effective.harness.harness, role: r, meta: [r.role, `${selectorText(r.effective.harness)}${src ? `（${src}）` : ''}`, r.origin === 'space' ? `写 ${r.writeScope.join(' ')}` : '插件角色'] }
    })
  return sp.agents.map((a) => ({ name: a.role, title: a.title, description: a.description, harness: a.harness.harness, meta: [a.role, [a.harness.harness, a.harness.model].filter(Boolean).join(' · '), `写 ${a.writeScope.join(' ')}`] }))
}

/** 粗略的改动行数：按行号逐行比较，够用来提示"改了多少"。 */
function changedLines(a: string, b: string): number {
  const x = a.split('\n')
  const y = b.split('\n')
  let n = Math.abs(x.length - y.length)
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) n++
  return n
}

function Editor({ kind, name, onDirty, onSaved }: { kind: SpaceFileKind; name: string; onDirty: (dirty: boolean) => void; onSaved?: () => void }) {
  const ds = useSource()
  const q = useAsync((d) => d.spaceFile(kind, name), [kind, name])
  const [text, setText] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const original = q.data?.content
  useEffect(() => {
    if (original !== undefined) setText(original)
    setReason('')
  }, [original])

  const changed = original === undefined ? 0 : changedLines(original, text)
  useEffect(() => onDirty(changed > 0), [changed > 0])
  useEffect(() => () => onDirty(false), [])

  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={q.reload} />
  if (!q.data) return <SkeletonRows rows={10} />
  const canSave = changed > 0 && reason.trim() !== '' && !busy

  async function save() {
    if (!canSave) return
    setBusy(true)
    try {
      await ds.saveSpaceFile(kind, name, { content: text, reason: reason.trim() })
      toast(`已保存 ${q.data!.path}`, { body: `原因：${reason.trim()}。运行前会同步到各 harness 的技能目录。` })
      q.reload()
      onSaved?.()
    } catch (e) {
      toast('保存失败', { body: (e as Error).message, tone: 'failed' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="file-editor"
      onKeyDown={(e: KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 's') {
          e.preventDefault()
          void save()
        }
      }}
    >
      <div className="file-editor-head">
        <FileText aria-hidden />
        <span className="mono truncate">{q.data.path}</span>
        <span className="spacer" />
        {changed > 0 ? <span className="file-dirty">改动 <span className="num">{changed}</span> 行</span> : <span className="faint">未修改</span>}
      </div>
      <textarea className="textarea mono file-text" spellCheck={false} aria-label={`${q.data.path} 内容`} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="file-save">
        <label className="grow">
          <span className="field-label">修改原因（必填，写进修订记录）</span>
          <input className="input" placeholder={changed ? '例如：补充舍入方式示例' : '修改内容后填写'} value={reason} onChange={(e) => setReason(e.target.value)} disabled={changed === 0} aria-required />
        </label>
        <button className="btn" onClick={() => setText(original ?? '')} disabled={changed === 0 || busy}>
          还原
        </button>
        <button className="btn btn-primary" onClick={save} disabled={!canSave} title="⌘S / Ctrl+S">
          <Save />
          保存
        </button>
      </div>
      {changed > 0 && !reason.trim() && <p className="file-save-hint">写一句修改原因才能保存：它和改动一起进修订记录，方便回看为什么这么改。</p>}
    </div>
  )
}

export function FilesTab({ kind, space, onChanged }: { kind: SpaceFileKind; space?: SpaceDetail; onChanged?: () => void }) {
  const { query } = useLocation()
  const [dirty, setDirty] = useState(false)
  const [mode, setMode] = useState<'form' | 'source'>('form')
  const isSkill = kind === 'skill'
  // 结构化接口不可用（老版本服务端）时 data 为 null：只有源码编辑
  const rq = useAsync((d) => (isSkill ? Promise.resolve(null) : d.agentRoles().catch(() => null)), [isSkill])
  const roles = rq.data ?? undefined
  const list = space ? entries(kind, space, roles) : []
  const st = useStagger(list.length)
  if (!space || (!isSkill && rq.loading && rq.data === undefined)) return <div className="card"><SkeletonRows rows={6} /></div>
  if (list.length === 0) {
    return (
      <div className="card">
        <EmptyState
          title={isSkill ? '还没有技能' : '还没有角色'}
          body={isSkill ? '技能是团队沉淀的做事方法，运行前会同步给每个 Agent。说说你们怎么做事，管家帮你写成技能。' : '角色决定节点由谁来做：职责说明、默认模型和写权限。'}
          action={<StewardEditButton ask={isSkill ? '帮我新建一个技能，内容是：' : '帮我新建一个角色，负责：'} label={isSkill ? '让管家写一个技能' : '让管家建一个角色'} size="md" />}
        />
      </div>
    )
  }
  const selected = list.find((e) => e.name === query.get('name')) ?? list[0]!
  const changed = () => {
    rq.reload()
    onChanged?.()
  }
  const sourceUnavailable = !isSkill && selected.role && selected.role.origin !== 'space'
  return (
    <div className="files-layout">
      <ul className="card file-list" aria-label={isSkill ? '技能列表' : '角色列表'}>
        {list.map((e, i) => (
          <li key={e.name} {...st(i)}>
            <button className={`file-item${e.name === selected.name ? ' on' : ''}${isSkill ? '' : ' has-mark'}`} aria-current={e.name === selected.name ? 'true' : undefined} onClick={() => {
                if (e.name === selected.name) return
                if (dirty && !window.confirm(`${selected.title} 有未保存的修改，切换后会丢失。继续？`)) return
                setQuery({ name: e.name })
              }}>
              {!isSkill && <AgentMark state="idle" role={e.name} size={28} className="file-item-mark" />}
              <span className="file-item-title">
                <span className={isSkill ? 'mono' : undefined}>{e.title}</span>
                {!isSkill && <span className="faint mono">{e.name}</span>}
                {dirty && e.name === selected.name && <span className="file-item-dirty">未保存</span>}
              </span>
              <span className="file-item-desc">{e.description}</span>
              {!isSkill && (
                <span className="file-item-meta mono">
                  {e.meta.slice(1).map((m) => (
                    <span key={m} className="truncate">{m}</span>
                  ))}
                </span>
              )}
            </button>
          </li>
        ))}
        <li className="file-list-foot">
          <StewardEditButton ask={isSkill ? '帮我新建一个技能，内容是：' : '帮我新建一个角色，负责：'} label={isSkill ? '让管家新建技能' : '让管家新建角色'} ghost />
        </li>
      </ul>
      <div className="card">
        {isSkill ? (
          <Editor key={selected.name} kind={kind} name={selected.name} onDirty={setDirty} />
        ) : (
          <>
            <RoleHead
              role={selected.name}
              title={selected.title}
              origin={selected.role?.origin}
              path={selected.role?.path}
              mode={roles ? mode : 'source'}
              onMode={(m) => {
                if (dirty && !window.confirm('有未保存的修改，切换后会丢失。继续？')) return
                setMode(m)
              }}
              onDeleted={() => {
                setQuery({ name: undefined })
                changed()
              }}
            />
            {roles && mode === 'form' ? (
              <RoleForm key={selected.name} role={selected.name} space={space} onDirty={setDirty} onSaved={changed} />
            ) : sourceUnavailable ? (
              <p className="file-note">这是插件带的角色，空间里还没有它的档案。在表单里保存一次，会在空间里建一份 <span className="mono">agents/{selected.name}.md</span>，之后就能看源码了。</p>
            ) : (
              <Editor key={selected.name} kind={kind} name={selected.name} onDirty={setDirty} onSaved={changed} />
            )}
          </>
        )}
      </div>
    </div>
  )
}
