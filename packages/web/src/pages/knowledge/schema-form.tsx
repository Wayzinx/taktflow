import type { ReactNode } from 'react'
import { Plus, X } from 'lucide-react'
import { useAsync } from '../../api'
import { Segmented } from '../../components/ui'
import { Dropzone, ListInput, SecretPicker, type PendingFile } from './fields'
import { LiveOpsPicker } from './ops-picker'
import { enumLabel, fieldsOf, HINT, LABEL, parseNumber, setWikiMode, visible, wantsUpload, wikiMode, type Config, type Schema } from './schema-config'

export { defaultsOf, missingFields, type Schema } from './schema-config'

function Field({ label, hint, children, htmlFor }: { label: string; hint?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="ov-field">
      <label className="ov-field-label" htmlFor={htmlFor}>
        {label}
        {hint && <span className="ov-field-hint">{hint}</span>}
      </label>
      {children}
    </div>
  )
}

/** 请求头 → 密钥引用（api.headers：additionalProperties 为 format: secret）。 */
function HeadersEditor({ value, onChange }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const rows = Object.entries(value)
  const put = (i: number, name: string, ref: string) => onChange(Object.fromEntries(rows.map((r, j) => (j === i ? [name, ref] : r))))
  return (
    <div className="kb-headers">
      {rows.map(([name, ref], i) => (
        <div key={i} className="kb-header-row">
          <input className="input mono" value={name} placeholder="Authorization" aria-label="请求头名" onChange={(e) => put(i, e.target.value, ref)} />
          <SecretPicker value={ref || undefined} onChange={(v) => put(i, name, v)} />
          <button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={`移除请求头 ${name}`} onClick={() => onChange(Object.fromEntries(rows.filter((_, j) => j !== i)))}>
            <X />
          </button>
        </div>
      ))}
      <span>
        <button type="button" className="btn btn-sm" disabled={rows.some(([n]) => !n)} onClick={() => onChange({ ...value, [rows.length ? '' : 'Authorization']: '' })}>
          <Plus />
          添加请求头
        </button>
      </span>
    </div>
  )
}

/**
 * 按 kind 的 configSchema 生成表单（字段名与服务端一致，见 schema-config.ts），配专用控件：
 * rag 数据源四选一（拖拽上传 / 空间内目录 / 仓库 / URL 列表）、llm-wiki 来源四选一、format: secret 用密钥选择器、
 * api 的 allow 用操作勾选（新建向导里在"测试"一步勾）、headers 用请求头 → 密钥、字符串数组用标签输入、integer 用数字框。
 * baseId：已存在的知识库（详情页设置），操作勾选可以就地读取操作。
 */
export function SchemaForm({ kind, schema, value, onChange, files, onFiles, baseId }: { kind: string; schema: Schema; value: Config; onChange: (v: Config) => void; files: PendingFile[]; onFiles: (f: PendingFile[]) => void; baseId?: string }) {
  const repos = useAsync((ds) => ds.space().then((s) => s.repos.map((r) => r.id)).catch(() => [] as string[]), [])
  const repoIds = repos.data ?? []
  const set = (k: string, v: unknown) => onChange({ ...value, [k]: v })

  const repoSelect = (id: string, v: unknown, put: (v: string) => void) =>
    repoIds.length ? (
      <select id={id} className="select" value={String(v ?? '')} onChange={(e) => put(e.target.value)}>
        <option value="">选择本空间的仓库</option>
        {repoIds.map((r) => (
          <option key={r}>{r}</option>
        ))}
      </select>
    ) : (
      <input id={id} className="input mono" value={String(v ?? '')} placeholder="仓库 id" onChange={(e) => put(e.target.value)} />
    )

  function render(key: string, s: Schema, v: unknown, put: (v: unknown) => void, path: string): ReactNode {
    const id = `kb-f-${path}`
    const label = LABEL[key] ?? s.title ?? key
    if (key === 'sources' && kind === 'rag') {
      const src = ((v as Config[] | undefined)?.[0] ?? { type: 'upload' }) as Config
      const putSrc = (patch: Config) => put([{ ...src, ...patch }, ...((v as Config[] | undefined) ?? []).slice(1)])
      const types = s.items?.properties?.type?.enum ?? ['upload']
      return (
        <Field key={key} label={label}>
          <Segmented size="sm" ariaLabel="数据来源" value={String(src.type ?? 'upload')} onChange={(t) => put([{ type: t }, ...((v as Config[] | undefined) ?? []).slice(1)])} options={types.map((t) => ({ value: t, label: enumLabel(kind, 'type', t) }))} />
          <div key={String(src.type)} className="kb-src-body tab-panel">
            {src.type === 'upload' && (baseId ? <p className="kb-help">上传的文件在"数据源"Tab 管理。</p> : <Dropzone files={files} onChange={onFiles} />)}
            {src.type === 'repo' && <Field label="仓库" htmlFor={`${id}-repo`}>{repoSelect(`${id}-repo`, src.repo, (repo) => putSrc({ repo }))}</Field>}
            {src.type === 'path' && (
              <Field label="目录" hint={HINT.path} htmlFor={`${id}-path`}>
                <input id={`${id}-path`} className="input mono" value={String(src.path ?? '')} placeholder="docs" onChange={(e) => putSrc({ path: e.target.value })} />
              </Field>
            )}
            {src.type === 'url' && <ListInput mono value={(src.urls as string[] | undefined) ?? []} onChange={(urls) => putSrc({ urls })} placeholder="粘贴 URL，回车添加" />}
          </div>
        </Field>
      )
    }
    if (key === 'allow' && kind === 'api')
      return (
        <Field key={key} label={label}>
          {baseId ? <LiveOpsPicker baseId={baseId} value={(v as string[] | undefined) ?? []} onChange={put} /> : <p className="kb-help">下一步测试连接时会列出 OpenAPI 里的操作，在那里勾选允许调用的 GET。</p>}
        </Field>
      )
    if (s.format === 'secret') return <Field key={key} label={label} hint={HINT[key]} htmlFor={id}><SecretPicker id={id} value={v as string | undefined} onChange={put} /></Field>
    if (s.type === 'object' && typeof s.additionalProperties === 'object' && s.additionalProperties.format === 'secret')
      return <Field key={key} label={label} hint="值存为密钥引用"><HeadersEditor value={(v as Record<string, string> | undefined) ?? {}} onChange={put} /></Field>
    if (key === 'repo') return <Field key={key} label={label} htmlFor={id}>{repoSelect(id, v, put)}</Field>
    if (s.enum) {
      const opts = s.enum.map((e) => ({ value: e, label: enumLabel(kind, key, e) }))
      return (
        <Field key={key} label={label}>
          <Segmented size="sm" ariaLabel={label} value={String(v ?? s.enum[0])} onChange={put} options={opts} />
        </Field>
      )
    }
    if (s.type === 'object') {
      // 没有声明字段的对象（database.notes / mask 等高级项）不在表单里编辑
      if (!s.properties) return null
      return (
        <fieldset key={key} className="kb-fieldset">
          <legend className="section-label">{label}</legend>
          <div className="kb-row-2">{Object.entries(s.properties).map(([k2, s2]) => render(k2, s2, (v as Config | undefined)?.[k2], (x) => put({ ...((v as Config) ?? {}), [k2]: x }), `${path}-${k2}`))}</div>
        </fieldset>
      )
    }
    if (s.type === 'array') return <Field key={key} label={label} hint={HINT[key]}><ListInput mono value={(v as string[] | undefined) ?? []} onChange={put} placeholder="回车添加" suggestions={key === 'repos' ? repoIds : undefined} /></Field>
    if (s.type === 'boolean')
      return (
        <label key={key} className="kb-check">
          <input type="checkbox" checked={Boolean(v)} onChange={(e) => put(e.target.checked)} />
          {label}
        </label>
      )
    if (s.type === 'integer' || s.type === 'number')
      return (
        <Field key={key} label={label} hint={HINT[key]} htmlFor={id}>
          <input id={id} className="input num" type="number" step={s.type === 'integer' ? 1 : 'any'} value={v === undefined || v === null ? '' : String(v)} placeholder="默认" onChange={(e) => put(parseNumber(e.target.value, s.type === 'integer'))} />
        </Field>
      )
    return <Field key={key} label={label} hint={HINT[key]} htmlFor={id}><input id={id} className={`input${/path|openapi|url|branch|baseURL/i.test(key) ? ' mono' : ''}`} value={String(v ?? '')} placeholder={key === 'openapi' ? 'https://open.example.com/openapi.json' : undefined} onChange={(e) => put(e.target.value)} /></Field>
  }

  const fields = fieldsOf(schema)
  const wiki = kind === 'llm-wiki'
  const mode = wikiMode(value)
  const gen = schema.properties?.generate
  if (!fields.length) return <p className="kb-help">这个类型不需要额外配置。</p>
  return (
    <div className="ov-form">
      {wiki && (
        <Field label="来源">
          <Segmented size="sm" ariaLabel="Wiki 来源" value={mode} onChange={(m) => onChange(setWikiMode(value, m))} options={[...(schema.properties?.source?.enum ?? ['space']), ...(gen ? ['generate'] : [])].map((m) => ({ value: m, label: enumLabel(kind, 'mode', m) }))} />
        </Field>
      )}
      {wiki && wantsUpload(kind, value) && (baseId ? <p className="kb-help">上传的 Markdown 在"数据源"Tab 管理。</p> : <Dropzone files={files} onChange={onFiles} />)}
      {wiki && mode === 'generate' && gen && render('generate', gen, value.generate, (x) => set('generate', x), 'generate')}
      {fields.filter(([k]) => visible(kind, k, value)).map(([k, s]) => render(k, s, value[k], (v) => set(k, v), k))}
    </div>
  )
}
