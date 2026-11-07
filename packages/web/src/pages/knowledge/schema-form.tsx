import type { ReactNode } from 'react'
import { Lock } from 'lucide-react'
import { useAsync } from '../../api'
import { Segmented } from '../../components/ui'
import { Dropzone, ListInput, SecretPicker, type PendingFile } from './fields'
import { OpsPicker } from './ops-picker'

/** configSchema 的子集：页面表单从这里生成（docs/design/23「类型」）。 */
export interface Schema {
  type?: string
  title?: string
  enum?: string[]
  default?: unknown
  format?: string
  items?: Schema
  properties?: Record<string, Schema>
  required?: string[]
}
type Config = Record<string, unknown>

const LABEL: Record<string, string> = { sources: '数据从哪来', chunk: '切块', size: '块大小（字符）', overlap: '块重叠（字符）', from: '来源', path: 'Wiki 目录', repo: '仓库', scope: '范围 glob', granularity: '粒度', driver: '驱动', dsn: '连接串', schema: 'Schema', tables: '表白名单', readOnly: '只读', spec: 'OpenAPI 地址或文件', operations: '允许调用的操作', auth: '认证', header: '请求头', secret: '密钥', repos: '仓库', since: '时间范围', includeRequirements: '包含过往需求', glob: '文件 glob', urls: 'URL 列表' }
const ENUM_LABEL: Record<string, Record<string, string>> = {
  kind: { upload: '拖拽上传', repo: '仓库 + glob', urls: 'URL 列表' },
  from: { wiki: '已有 Wiki 目录', repo: '从代码仓库生成' },
  granularity: { dir: '按目录', module: '按模块' },
}
const HINT: Record<string, string> = { glob: '例如 docs/**/*.md', scope: '只为这些路径生成 Wiki 页面', tables: '回车添加；留空表示 schema 下所有表', since: '例如 6m、1y', size: '800 左右适合大多数文档', dsn: '存为密钥引用，页面读不到明文' }

const asSchema = (v: unknown) => (v ?? {}) as Schema

export function defaultsOf(schema: Schema): Config {
  const out: Config = {}
  for (const [k, s] of Object.entries(schema.properties ?? {})) {
    if (s.default !== undefined) out[k] = s.default
    else if (s.type === 'object') out[k] = defaultsOf(s)
    else if (s.enum) out[k] = s.enum[0]
    else if (k === 'sources') out[k] = [{ kind: 'upload' }]
    else if (s.type === 'array') out[k] = []
  }
  return out
}

/** 必填项里还空着的（下一步按钮旁显示）。上传类源要求至少一个文件（新建时）或已有文档。 */
export function missingFields(kind: string, cfg: Config, files: PendingFile[], schema: Schema): string[] {
  const miss: string[] = []
  for (const k of schema.required ?? []) {
    const v = cfg[k]
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) miss.push(LABEL[k] ?? k)
  }
  if (kind === 'rag') {
    const src = (cfg.sources as Config[] | undefined)?.[0]
    if (src?.kind === 'upload' && !files.length) miss.push('至少上传一个文件')
    if (src?.kind === 'repo' && !src.repo) miss.push('仓库')
    if (src?.kind === 'urls' && !(src.urls as string[] | undefined)?.length) miss.push('URL')
  }
  if (kind === 'llm-wiki') {
    if (cfg.from === 'wiki' && !cfg.path) miss.push('Wiki 目录')
    if (cfg.from === 'repo' && !cfg.repo) miss.push('仓库')
  }
  return [...new Set(miss)]
}

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

/**
 * 按 kind 的 configSchema 生成表单，配专用控件：
 * rag 来源三选一（拖拽上传 / 仓库 + glob / URL 列表）、format: secret 用密钥选择器、api 的 operations 用操作勾选、字符串数组用标签输入。
 */
export function SchemaForm({ kind, schema, value, onChange, files, onFiles }: { kind: string; schema: Schema; value: Config; onChange: (v: Config) => void; files: PendingFile[]; onFiles: (f: PendingFile[]) => void }) {
  const repos = useAsync((ds) => ds.space().then((s) => s.repos.map((r) => r.id)).catch(() => [] as string[]), [])
  const repoIds = repos.data ?? []
  const set = (k: string, v: unknown) => onChange({ ...value, [k]: v })

  function render(key: string, s: Schema, v: unknown, put: (v: unknown) => void, path: string): ReactNode {
    const id = `kb-f-${path}`
    const label = LABEL[key] ?? s.title ?? key
    if (key === 'sources') {
      const src = ((v as Config[] | undefined)?.[0] ?? { kind: 'upload' }) as Config
      const putSrc = (patch: Config) => put([{ ...src, ...patch }])
      const kinds = asSchema(s.items?.properties?.kind).enum ?? ['upload', 'repo', 'urls']
      return (
        <Field key={key} label={label}>
          <Segmented size="sm" ariaLabel="数据来源" value={String(src.kind ?? 'upload')} onChange={(k) => putSrc({ kind: k })} options={kinds.map((k) => ({ value: k, label: ENUM_LABEL.kind?.[k] ?? k }))} />
          <div key={String(src.kind)} className="kb-src-body tab-panel">
            {src.kind === 'upload' && <Dropzone files={files} onChange={onFiles} />}
            {src.kind === 'repo' && (
              <div className="kb-row-2">
                <Field label="仓库" htmlFor={`${id}-repo`}>
                  <select id={`${id}-repo`} className="select" value={String(src.repo ?? '')} onChange={(e) => putSrc({ repo: e.target.value })}>
                    <option value="">选择本空间的仓库</option>
                    {repoIds.map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                </Field>
                <Field label="文件 glob" hint={HINT.glob} htmlFor={`${id}-glob`}>
                  <input id={`${id}-glob`} className="input mono" value={String(src.glob ?? 'docs/**/*.md')} onChange={(e) => putSrc({ glob: e.target.value })} />
                </Field>
              </div>
            )}
            {src.kind === 'urls' && <ListInput mono value={(src.urls as string[] | undefined) ?? []} onChange={(urls) => putSrc({ urls })} placeholder="粘贴 URL，回车添加" />}
          </div>
        </Field>
      )
    }
    if (kind === 'llm-wiki' && ((key === 'path' && value.from !== 'wiki') || (['repo', 'scope', 'granularity'].includes(key) && value.from !== 'repo'))) return null
    if (key === 'operations') return <Field key={key} label={label}><OpsPicker spec={String(value.spec ?? '')} value={(v as string[] | undefined) ?? []} onChange={put} /></Field>
    if (s.format === 'secret') return <Field key={key} label={label} hint={HINT[key]} htmlFor={id}><SecretPicker id={id} value={v as string | undefined} onChange={put} /></Field>
    if (key === 'readOnly') return (
      <div key={key} className="kb-locked">
        <Lock aria-hidden />
        只读守卫始终开启：只允许 SELECT / WITH / SHOW / DESCRIBE / EXPLAIN，自动补 LIMIT 200。
      </div>
    )
    if (key === 'repo' && repoIds.length) return (
      <Field key={key} label={label} htmlFor={id}>
        <select id={id} className="select" value={String(v ?? '')} onChange={(e) => put(e.target.value)}>
          <option value="">选择本空间的仓库</option>
          {repoIds.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      </Field>
    )
    if (s.enum) {
      const opts = s.enum.map((e) => ({ value: e, label: ENUM_LABEL[key]?.[e] ?? e }))
      return (
        <Field key={key} label={label}>
          <Segmented size="sm" ariaLabel={label} value={String(v ?? s.enum[0])} onChange={put} options={opts} />
        </Field>
      )
    }
    if (s.type === 'object') return (
      <fieldset key={key} className="kb-fieldset">
        <legend className="section-label">{label}</legend>
        <div className="kb-row-2">{Object.entries(s.properties ?? {}).map(([k2, s2]) => render(k2, s2, (v as Config | undefined)?.[k2], (x) => put({ ...((v as Config) ?? {}), [k2]: x }), `${path}-${k2}`))}</div>
      </fieldset>
    )
    if (s.type === 'array') return <Field key={key} label={label} hint={HINT[key]}><ListInput mono value={(v as string[] | undefined) ?? []} onChange={put} placeholder="回车添加" suggestions={key === 'repos' ? repoIds : undefined} /></Field>
    if (s.type === 'boolean') return (
      <label key={key} className="kb-check">
        <input type="checkbox" checked={Boolean(v)} onChange={(e) => put(e.target.checked)} />
        {label}
      </label>
    )
    if (s.type === 'number') return <Field key={key} label={label} hint={HINT[key]} htmlFor={id}><input id={id} className="input num" type="number" value={Number(v ?? 0)} onChange={(e) => put(Number(e.target.value))} /></Field>
    return <Field key={key} label={label} hint={HINT[key]} htmlFor={id}><input id={id} className={`input${/glob|scope|path|spec|schema|since/.test(key) ? ' mono' : ''}`} value={String(v ?? '')} placeholder={key === 'spec' ? 'https://open.example.com/openapi.json' : undefined} onChange={(e) => put(e.target.value)} /></Field>
  }

  const props = Object.entries(schema.properties ?? {})
  if (!props.length) return <p className="kb-help">这个类型不需要额外配置。</p>
  return <div className="ov-form">{props.map(([k, s]) => render(k, s, value[k], (v) => set(k, v), k))}</div>
}
