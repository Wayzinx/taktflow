import { useState } from 'react'
import type { StewardToolCall } from '@taktflow/core'
import { groupActions, stewardAction } from '../../lib/actions'
import { ActionRow } from '../action-row'
import './cards.css'

/** 工具结果常是一段 JSON 文本：先解析再缩进，不然显示成一整行带转义的字符串；太长的只留开头。 */
const json = (v: unknown) => {
  let value = v
  if (typeof v === 'string' && /^\s*[[{]/.test(v)) {
    try {
      value = JSON.parse(v)
    } catch {
      // 不是完整 JSON，原样显示
    }
  }
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  } catch {
    text = String(value)
  }
  return text.length > 6000 ? `${text.slice(0, 6000)}\n…（共 ${text.length} 字，只显示开头）` : text
}

function Raw({ tool }: { tool: StewardToolCall }) {
  return (
    <>
      <div className="section-label">输入</div>
      <pre className="stw-pre">{json(tool.input)}</pre>
      {tool.output !== undefined && (
        <>
          <div className="section-label">返回</div>
          <pre className="stw-pre">{json(tool.output)}</pre>
        </>
      )}
      {tool.ok === false && tool.summary && <p className="stw-tool-err">{tool.summary}</p>}
    </>
  )
}

/**
 * 管家动作清单（docs/design/25 §1）：一行一个动作"动词 + 对象 + 结果"，连续调用同一个工具合并成 ×N；
 * 进行中的那行图标带节拍光环、文字扫光；点开看原始输入 / 输出。
 */
export function ToolList({ tools, animate }: { tools: StewardToolCall[]; animate?: boolean }) {
  const [open, setOpen] = useState<string | undefined>()
  const groups = groupActions(tools, stewardAction, (t) => t.tool)
  return (
    <ul className="act-list stw-tools" aria-label="管家查了什么">
      {groups.map(({ action, items }) => {
        const state = items.some((t) => t.ok === undefined) ? 'running' : action.ok === false ? 'failed' : 'done'
        const ms = items.reduce((n, t) => n + (t.ms ?? 0), 0)
        const id = items[0]!.id
        return (
          <ActionRow key={id} action={action} count={items.length} state={state} ms={ms} animate={animate} open={open === id} onToggle={() => setOpen((v) => (v === id ? undefined : id))}>
            {items.map((t) => (
              <Raw key={t.id} tool={t} />
            ))}
          </ActionRow>
        )
      })}
    </ul>
  )
}

/** 统一 diff：+ 绿、- 红、@@ 中性；只读。 */
export function DiffView({ diff, maxHeight = 260 }: { diff: string; maxHeight?: number }) {
  // 去掉 git 的元信息行（diff --git / index / 临时文件名），文件名由调用方单独显示
  const lines = diff.replace(/\n$/, '').split('\n').filter((l) => !/^(diff --git |index [0-9a-f]+\.\.[0-9a-f]+|--- a\/before|\+\+\+ b\/after)/.test(l))
  return (
    <pre className="stw-diff" style={{ maxHeight }} aria-label="改动预览">
      {lines.map((l, i) => {
        const t = l.startsWith('+++') || l.startsWith('---') ? 'file' : l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : 'ctx'
        return (
          <span key={i} className="stw-diff-line" data-t={t}>
            {l || ' '}
          </span>
        )
      })}
    </pre>
  )
}
