import { useState } from 'react'
import type { KnowledgeTestResult } from '@taktflow/core'
import { RotateCw, ShieldAlert } from 'lucide-react'
import { useSource } from '../../api'
import { ErrorState, SkeletonRows } from '../../components/ui'

export interface ApiOperation {
  /** 服务端操作 id（operationId，或 `METHOD /path`）：写进 config.allow 的就是它。 */
  id: string
  method: string
  path: string
  summary: string
}

/**
 * 从"测试连接"的结果里取操作清单：服务端 api.test 解析 OpenAPI 后，preview 每项是 { title: 摘要, ref: 操作 id, snippet: 'GET /path' }。
 * 不伪造：拿不到就是空清单。
 */
export function operationsFromPreview(result?: KnowledgeTestResult): ApiOperation[] {
  return (result?.preview ?? []).flatMap((p) => {
    const m = /^([A-Z]+)\s+(\S+)/.exec(p.snippet ?? '')
    return m ? [{ id: p.ref, method: m[1]!, path: m[2]!, summary: p.title }] : []
  })
}

/** 结果文案里的"读取 N 个操作"：比清单多时提示清单不全。 */
const totalOf = (result?: KnowledgeTestResult) => Number(/读取\s*(\d+)\s*个操作/.exec(result?.message ?? '')?.[1] ?? 0)

/** 操作勾选：本期服务端只允许 GET 实时查询，其他方法只展示不可勾。 */
export function OpsPicker({ result, value, onChange }: { result?: KnowledgeTestResult; value: string[]; onChange: (v: string[]) => void }) {
  const ops = operationsFromPreview(result)
  const [filter, setFilter] = useState('')
  if (!ops.length) return <p className="kb-help">{result ? '没有从 OpenAPI 里读到操作，检查地址或文件后再测一次。' : '测试连接后，这里会列出 OpenAPI 里的操作。'}</p>
  const shown = ops.filter((o) => !filter || `${o.path} ${o.summary}`.toLowerCase().includes(filter.toLowerCase()))
  const gets = ops.filter((o) => o.method === 'GET').map((o) => o.id)
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])
  const total = totalOf(result)
  return (
    <div className="kb-ops">
      <div className="kb-ops-bar">
        <input className="input" placeholder="筛选操作" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="筛选操作" />
        <button type="button" className="btn btn-sm" onClick={() => onChange([...new Set([...value, ...gets])])}>
          全选 GET
        </button>
        <span className="faint num">
          已选 {value.length}/{gets.length}
        </span>
      </div>
      <ul className="kb-ops-list">
        {shown.map((o) => {
          const disabled = o.method !== 'GET'
          return (
            <li key={o.id}>
              <label className={`kb-op${disabled ? ' disabled' : ''}`} title={disabled ? '本期只允许 GET 实时查询' : undefined}>
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
      <p className="kb-ops-write">
        <ShieldAlert aria-hidden />
        只允许 GET：写操作会真实改数据，本期不开放。
        {total > ops.length && <span className="faint"> 测试只返回了前 {ops.length} 个（共 {total} 个），其余可以直接按 id 填写。</span>}
      </p>
    </div>
  )
}

/** 详情页设置里用：按需"读取操作"（调测试连接），再勾选。 */
export function LiveOpsPicker({ baseId, value, onChange }: { baseId: string; value: string[]; onChange: (v: string[]) => void }) {
  const ds = useSource()
  const [result, setResult] = useState<KnowledgeTestResult>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error>()
  async function load() {
    setBusy(true)
    setError(undefined)
    try {
      setResult(await ds.testKnowledgeBase(baseId))
    } catch (e) {
      setError(e as Error)
    } finally {
      setBusy(false)
    }
  }
  if (error) return <ErrorState compact error={error} onRetry={() => void load()} title="没能读取操作" />
  if (busy) return <SkeletonRows rows={3} icon={false} />
  if (!result)
    return (
      <div className="kb-ops-load">
        {value.length > 0 && <span className="mono faint truncate">{value.join('、')}</span>}
        <button type="button" className="btn btn-sm" onClick={() => void load()}>
          <RotateCw />
          读取操作
        </button>
      </div>
    )
  return <OpsPicker result={result} value={value} onChange={onChange} />
}
