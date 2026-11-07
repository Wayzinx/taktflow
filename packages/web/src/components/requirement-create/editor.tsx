import { useRef, useState, type ClipboardEvent, type DragEvent } from 'react'
import { FileText, Paperclip, Upload } from 'lucide-react'
import { Chip, toast } from '../ui'
import { MAX_ATTACHMENT, fmtSize, readAttachment, type Attachment } from './draft'

/**
 * 大文本框 + 附件：可以直接粘贴 PRD，也可以把文件拖进来（或粘贴文件、点回形针选文件）。
 * 附件创建时写进需求的 inputs/。
 */
export function DraftEditor({
  text,
  onText,
  attachments,
  onAttachments,
}: {
  text: string
  onText: (v: string) => void
  attachments: Attachment[]
  onAttachments: (fn: (a: Attachment[]) => Attachment[]) => void
}) {
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  const picker = useRef<HTMLInputElement>(null)

  const add = async (files: FileList | File[]) => {
    const list = [...files]
    const big = list.filter((f) => f.size > MAX_ATTACHMENT)
    if (big.length) toast(`${big.map((f) => f.name).join('、')} 超过 5 MB，没有添加`, { tone: 'waiting' })
    const ok = list.filter((f) => f.size <= MAX_ATTACHMENT)
    try {
      const read = await Promise.all(ok.map(readAttachment))
      onAttachments((a) => [...a.filter((x) => !read.some((r) => r.name === x.name)), ...read])
    } catch (e) {
      toast('读取附件失败', { tone: 'failed', body: (e as Error).message })
    }
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    depth.current = 0
    setOver(false)
    if (e.dataTransfer.files.length) void add(e.dataTransfer.files)
  }
  const hasFiles = (e: DragEvent) => [...e.dataTransfer.types].includes('Files')
  const onPaste = (e: ClipboardEvent) => {
    if (e.clipboardData.files.length) {
      e.preventDefault()
      void add(e.clipboardData.files)
    }
  }

  return (
    <div
      className={`rc-editor${over ? ' over' : ''}`}
      onDragEnter={(e) => {
        if (!hasFiles(e)) return
        depth.current++
        setOver(true)
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1)
        if (!depth.current) setOver(false)
      }}
      onDragOver={(e) => hasFiles(e) && e.preventDefault()}
      onDrop={onDrop}
    >
      <textarea
        className="rc-textarea"
        value={text}
        onChange={(e) => onText(e.target.value)}
        onPaste={onPaste}
        placeholder={'购物车支持批量删除\n\n背景：用户一次要清掉很多失效商品，只能一个个删。\n目标：列表里多选后一键删除。\n验收标准：\n- 选中后底部出现"删除 N 件"'}
        aria-label="需求描述：第一行是标题，下面写背景、目标和验收标准"
        data-autofocus
        rows={9}
      />
      <div className="rc-editor-bar">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => picker.current?.click()} title="添加附件（也可以直接拖进来或粘贴）">
          <Paperclip />
          附件
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) void add(e.target.files)
            e.target.value = ''
          }}
        />
        {attachments.map((a) => (
          <Chip key={a.name} icon={FileText} onRemove={() => onAttachments((xs) => xs.filter((x) => x.name !== a.name))} title={`${a.name} · ${fmtSize(a.size)}`}>
            <span className="truncate rc-att-name">{a.name}</span>
            <span className="faint">{fmtSize(a.size)}</span>
          </Chip>
        ))}
        <span className="rc-editor-hint faint">{text.length > 0 ? `${text.length} 字` : '可粘贴 PRD，或把文件拖进来'}</span>
      </div>
      <div className="rc-drop" aria-hidden={!over} data-on={over || undefined}>
        <Upload aria-hidden />
        松手添加为附件
      </div>
    </div>
  )
}
