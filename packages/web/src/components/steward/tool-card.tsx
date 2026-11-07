import { useState } from 'react'
import { Check, ChevronRight, Wrench, X } from 'lucide-react'
import type { StewardToolCall } from '@taktflow/core'
import './cards.css'

const fmtMs = (ms?: number) => (ms === undefined ? '' : ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} 秒` : `${ms}ms`)
const json = (v: unknown) => {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

/**
 * 工具调用卡（docs/design/22 §1.3）：查了什么、耗时、返回几条；进行中时标题扫光 + 状态点呼吸；
 * 点开用 grid-template-rows 展开原始输入 / 输出。
 */
export function ToolCard({ tool, animate }: { tool: StewardToolCall; animate?: boolean }) {
  const [open, setOpen] = useState(false)
  const running = tool.ok === undefined
  const failed = tool.ok === false
  return (
    <div className={`stw-tool${animate ? ' stw-in' : ''}`} data-state={running ? 'running' : failed ? 'failed' : 'done'}>
      <button type="button" className="stw-tool-head pressable" aria-expanded={open} onClick={() => setOpen((v) => !v)} disabled={running}>
        <span className={`stw-tool-dot${running ? ' live-ring' : ''}`} aria-hidden>
          {running ? <Wrench /> : failed ? <X /> : <Check />}
        </span>
        <span className="stw-tool-name mono">{tool.tool}</span>
        <span className={`stw-tool-sum truncate${running ? ' shimmer-text' : ''}`}>{running ? '正在查询' : (tool.summary ?? (failed ? '调用失败' : '完成'))}</span>
        {!running && <span className="stw-tool-ms num">{fmtMs(tool.ms)}</span>}
        {!running && <ChevronRight className="stw-chev" aria-hidden />}
      </button>
      <div className="expand" data-open={open}>
        <div>
          <div className="stw-tool-body">
            <div className="section-label">输入</div>
            <pre className="stw-pre">{json(tool.input)}</pre>
            {tool.output !== undefined && (
              <>
                <div className="section-label">返回</div>
                <pre className="stw-pre">{json(tool.output)}</pre>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
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
