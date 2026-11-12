import { useState } from 'react'
import { Plus } from 'lucide-react'
import { useSource } from '../../api'
import type { SpaceFileKind } from '../../api/source'
import { toast } from '../../components/ui'
import { ROLE_ID_RULE, SKILL_NAME_RULE, newFileNameError } from './rules'
import { EditorDrawer } from './runtime/shared'

// 新技能的骨架：frontmatter 的 name / description 进技能列表，正文留给人写
const skillTemplate = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${name}\n\n写清楚什么时候用这个技能、按什么步骤做、做完怎么检查。\n`

/**
 * "新建技能 / 新建角色"：填名字（与服务端同一条规则，就地提示）→ 建出空白档案 → 选中它，进现有的编辑器 / 表单。
 * 管家按钮仍在旁边，作为"说说想要什么、让管家写"的快捷方式。
 */
export function NewFileButton({ kind, taken, primary, onCreated }: { kind: SpaceFileKind; taken: string[]; primary?: boolean; onCreated: (name: string) => void }) {
  const ds = useSource()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const isSkill = kind === 'skill'
  const what = isSkill ? '技能' : '角色'
  const error = newFileNameError(kind, name, taken)

  return (
    <>
      <button
        type="button"
        className={`btn btn-sm${primary ? ' btn-primary' : ''}`}
        onClick={() => {
          setName('')
          setTitle('')
          setDescription('')
          setOpen(true)
        }}
      >
        <Plus aria-hidden />
        新建{what}
      </button>
      <EditorDrawer
        open={open}
        onClose={() => setOpen(false)}
        title={`新建${what}`}
        description={isSkill ? '填技能名和说明，创建后直接编辑正文。' : '填角色标识和名字，创建后直接编辑运行方式、技能和写范围。'}
        saveLabel="新建"
        canSave={!error}
        onSave={async (reason) => {
          const bad = newFileNameError(kind, name, taken)
          if (bad) throw new Error(bad)
          const id = name.trim()
          if (isSkill) await ds.saveSpaceFile('skill', id, { content: skillTemplate(id, description.trim()), reason })
          else await ds.saveAgentRole(id, { title: title.trim() || id, ...(description.trim() ? { description: description.trim() } : {}), reason })
          toast(`已新建${what} ${id}`, { body: isSkill ? '接着编辑正文并保存。' : '接着在表单里配置它；流水线节点可以引用这个角色。' })
          onCreated(id)
        }}
      >
        <label className="ov-field">
          <span className="ov-field-label">
            {isSkill ? '技能名' : '角色 id'} <span className="ov-req">必填</span>
            <span className="ov-field-hint">{isSkill ? SKILL_NAME_RULE : ROLE_ID_RULE}</span>
          </span>
          <input
            className={`input mono${error ? ' is-bad' : ''}`}
            value={name}
            placeholder={isSkill ? 'pr-review' : 'designer'}
            aria-invalid={Boolean(error)}
            onChange={(e) => setName(e.target.value)}
            data-autofocus
          />
          {error && (
            <span className="settings-field-err" role="alert">
              {error}
            </span>
          )}
        </label>
        {!isSkill && (
          <label className="ov-field">
            <span className="ov-field-label">
              名字<span className="ov-field-hint">不填就用 id</span>
            </span>
            <input className="input" value={title} placeholder="例如：交互设计" onChange={(e) => setTitle(e.target.value)} />
          </label>
        )}
        <label className="ov-field">
          <span className="ov-field-label">
            一句话说明<span className="ov-field-hint">可以以后再改</span>
          </span>
          <input className="input" value={description} placeholder={isSkill ? '例如：评审 PR 时逐项检查的清单' : '例如：出交互稿并标注边界状态'} onChange={(e) => setDescription(e.target.value)} />
        </label>
      </EditorDrawer>
    </>
  )
}
