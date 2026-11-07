import { useState } from 'react'
import { Link2, Plus, X } from 'lucide-react'
import type { ExternalLink } from '@taktflow/core'
import { LINK_LABEL, linkType } from './draft'
import { Tag } from './tag'

export function LinksTag({ value, onChange }: { value: ExternalLink[]; onChange: (v: ExternalLink[]) => void }) {
  return (
    <Tag icon={Link2} label="关联链接" value={value.length ? value.map((l) => LINK_LABEL[l.type] ?? l.type).join('、') : undefined} onClear={() => onChange([])} width={340}>
      {() => <LinkEditor value={value} onChange={onChange} />}
    </Tag>
  )
}

/** 链接列表 + 粘贴即加。类型从域名推断（Meego / 飞书 / GitHub / Jira）。需求页头部也用它。 */
export function LinkEditor({ value, onChange }: { value: ExternalLink[]; onChange: (v: ExternalLink[]) => void }) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string>()
  const add = () => {
    const u = url.trim()
    if (!u) return
    try {
      new URL(u)
    } catch {
      setError('不是有效的链接，以 http:// 或 https:// 开头')
      return
    }
    if (value.some((l) => l.url === u)) {
      setError('这个链接已经加过了')
      return
    }
    onChange([...value, { type: linkType(u), url: u }])
    setUrl('')
    setError(undefined)
  }
  return (
    <div className="rc-form">
      {value.length > 0 && (
        <ul className="rc-links">
          {value.map((l) => (
            <li key={l.url} className="rc-link">
              <span className="rc-link-type">{LINK_LABEL[l.type] ?? l.type}</span>
              <a href={l.url} target="_blank" rel="noreferrer" className="truncate mono">
                {l.title ?? l.url.replace(/^https?:\/\//, '')}
              </a>
              <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label="移除链接" title="移除" onClick={() => onChange(value.filter((x) => x.url !== l.url))}>
                <X />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="rc-inline">
        <input
          className="input"
          value={url}
          onChange={(e) => (setUrl(e.target.value), setError(undefined))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              e.stopPropagation()
              add()
            }
          }}
          placeholder="粘贴 Meego / 飞书 / GitHub 链接"
          aria-label="链接地址"
          autoFocus
        />
        <button type="button" className="btn btn-sm" onClick={add} disabled={!url.trim()}>
          <Plus />
          添加
        </button>
      </div>
      {error && <p className="rc-pop-error">{error}</p>}
    </div>
  )
}
