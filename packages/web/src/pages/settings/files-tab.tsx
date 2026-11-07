import { useEffect, useState, type KeyboardEvent } from 'react'
import { FileText, Save, Sparkles, UserRoundCog } from 'lucide-react'
import type { SpaceDetail } from '@taktflow/core'
import { useAsync, useSource } from '../../api'
import type { SpaceFileKind } from '../../api/source'
import { EmptyState, ErrorState, SkeletonRows, toast, useStagger } from '../../components/ui'
import { StewardEditButton } from './ask-steward'
import { setQuery, useLocation } from '../../lib/router'
import './space-files.css'

interface Entry {
  name: string
  title: string
  description: string
  meta: string[]
}

function entries(kind: SpaceFileKind, sp: SpaceDetail): Entry[] {
  if (kind === 'skill') return sp.skills.map((s) => ({ name: s.name, title: s.name, description: s.description, meta: [s.path] }))
  return sp.agents.map((a) => ({ name: a.role, title: a.title, description: a.description, meta: [a.role, [a.harness.harness, a.harness.model].filter(Boolean).join(' · '), `写 ${a.writeScope.join(' ')}`] }))
}

/** 粗略的改动行数：按行号逐行比较，够用来提示"改了多少"。 */
function changedLines(a: string, b: string): number {
  const x = a.split('\n')
  const y = b.split('\n')
  let n = Math.abs(x.length - y.length)
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) n++
  return n
}

function Editor({ kind, name, onDirty }: { kind: SpaceFileKind; name: string; onDirty: (dirty: boolean) => void }) {
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

export function FilesTab({ kind, space }: { kind: SpaceFileKind; space?: SpaceDetail }) {
  const { query } = useLocation()
  const [dirty, setDirty] = useState(false)
  const st = useStagger(space ? entries(kind, space).length : 0)
  if (!space) return <div className="card"><SkeletonRows rows={6} /></div>
  const list = entries(kind, space)
  const isSkill = kind === 'skill'
  if (list.length === 0) {
    return (
      <div className="card">
        <EmptyState
          icon={isSkill ? Sparkles : UserRoundCog}
          title={isSkill ? '还没有技能' : '还没有角色'}
          body={isSkill ? '技能是团队沉淀的做事方法，运行前会同步给每个 Agent。说说你们怎么做事，管家帮你写成技能。' : '角色决定节点由谁来做：职责说明、默认模型和写权限。'}
          action={<StewardEditButton ask={isSkill ? '帮我新建一个技能，内容是：' : '帮我新建一个角色，负责：'} label={isSkill ? '让管家写一个技能' : '让管家建一个角色'} size="md" />}
        />
      </div>
    )
  }
  const selected = list.find((e) => e.name === query.get('name')) ?? list[0]!
  return (
    <div className="files-layout">
      <ul className="card file-list" aria-label={isSkill ? '技能列表' : '角色列表'}>
        {list.map((e, i) => (
          <li key={e.name} {...st(i)}>
            <button className={`file-item${e.name === selected.name ? ' on' : ''}`} aria-current={e.name === selected.name ? 'true' : undefined} onClick={() => {
                if (e.name === selected.name) return
                if (dirty && !window.confirm(`${selected.title} 有未保存的修改，切换后会丢失。继续？`)) return
                setQuery({ name: e.name })
              }}>
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
        <Editor key={selected.name} kind={kind} name={selected.name} onDirty={setDirty} />
      </div>
    </div>
  )
}
