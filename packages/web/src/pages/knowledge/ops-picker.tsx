import { useMemo, useState } from 'react'
import { ShieldAlert } from 'lucide-react'

export interface ApiOperation {
  id: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  summary: string
  tag: string
}

/**
 * OpenAPI 操作清单。协议里还没有"解析 spec、列出操作"的接口（knownIssues 已提），
 * 这里按 spec 地址本地构造一份演示清单；接上后换成服务端返回即可。
 */
export function demoOperations(spec: string): ApiOperation[] {
  if (!spec.trim()) return []
  const op = (method: ApiOperation['method'], path: string, summary: string, tag: string): ApiOperation => ({ id: `${method.toLowerCase()} ${path}`, method, path, summary, tag })
  return [
    op('GET', '/v2/orders/{id}', '查询订单详情', '订单'),
    op('GET', '/v2/orders', '按条件列出订单', '订单'),
    op('POST', '/v2/orders/{id}/cancel', '取消订单', '订单'),
    op('GET', '/v2/refunds/{id}', '查询退款', '退款'),
    op('POST', '/v2/refunds', '发起退款', '退款'),
    op('GET', '/v2/apps/{appId}', '查询应用注册信息', '应用'),
    op('PATCH', '/v2/apps/{appId}', '修改应用配置', '应用'),
    op('GET', '/v2/apps/{appId}/quota', '查询调用配额', '应用'),
    op('DELETE', '/v2/apps/{appId}/keys/{keyId}', '吊销密钥', '应用'),
  ]
}

/** 操作勾选：默认只开 GET；写操作要先展开"允许写操作"才能勾。 */
export function OpsPicker({ spec, value, onChange }: { spec: string; value: string[]; onChange: (v: string[]) => void }) {
  const ops = useMemo(() => demoOperations(spec), [spec])
  const [allowWrite, setAllowWrite] = useState(() => value.some((v) => !v.startsWith('get ')))
  const [filter, setFilter] = useState('')
  if (!ops.length) return <p className="kb-help">先填 OpenAPI 地址，这里会列出可调用的操作。</p>
  const shown = ops.filter((o) => !filter || `${o.path} ${o.summary} ${o.tag}`.toLowerCase().includes(filter.toLowerCase()))
  const gets = ops.filter((o) => o.method === 'GET').map((o) => o.id)
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])
  return (
    <div className="kb-ops">
      <div className="kb-ops-bar">
        <input className="input" placeholder="筛选操作" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="筛选操作" />
        <button type="button" className="btn btn-sm" onClick={() => onChange([...new Set([...value, ...gets])])}>
          全选 GET
        </button>
        <span className="faint num">
          已选 {value.length}/{ops.length}
        </span>
      </div>
      <ul className="kb-ops-list">
        {shown.map((o) => {
          const write = o.method !== 'GET'
          const disabled = write && !allowWrite
          return (
            <li key={o.id}>
              <label className={`kb-op${disabled ? ' disabled' : ''}`}>
                <input type="checkbox" checked={value.includes(o.id)} disabled={disabled} onChange={() => toggle(o.id)} />
                <span className="kb-method mono" data-m={o.method}>
                  {o.method}
                </span>
                <span className="mono truncate">{o.path}</span>
                <span className="faint truncate">{o.summary}</span>
              </label>
            </li>
          )
        })}
      </ul>
      <label className="kb-ops-write">
        <input type="checkbox" checked={allowWrite} onChange={(e) => (setAllowWrite(e.target.checked), e.target.checked || onChange(value.filter((v) => v.startsWith('get '))))} />
        <ShieldAlert aria-hidden />
        允许写操作（POST / PATCH / DELETE 会真实改数据，默认关闭）
      </label>
    </div>
  )
}
