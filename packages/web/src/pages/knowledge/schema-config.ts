/**
 * 知识库配置表单的纯逻辑：字段名以服务端 packages/knowledge/src/kinds/* 的 configSchema 为准（mock 由同步测试保证一致）。
 * rag：sources[].type = upload / path / repo / url；llm-wiki：source = space / path / git，或 generate.repo（从代码生成）；
 * database：driver / connection（密钥）/ tables / schemas / rowLimit；api：openapi / allow / baseURL / headers（密钥）/ maxBytes。
 */

/** configSchema 的子集：页面表单从这里生成（docs/design/23「类型」）。 */
export interface Schema {
  type?: string
  title?: string
  enum?: string[]
  default?: unknown
  format?: string
  items?: Schema
  properties?: Record<string, Schema>
  additionalProperties?: Schema | boolean
  required?: string[]
}
export type Config = Record<string, unknown>

export const LABEL: Record<string, string> = {
  sources: '数据从哪来', chunkTokens: '块大小（token）', overlapTokens: '块重叠（token）',
  source: '来源', path: '目录', url: 'Git 地址', branch: '分支', generate: '从代码生成', repo: '仓库', granularity: '粒度',
  driver: '驱动', connection: '连接串', tables: '表白名单', schemas: 'Schema 白名单', rowLimit: '最多返回行数',
  openapi: 'OpenAPI 地址或文件', allow: '允许调用的操作', baseURL: '接口地址', headers: '认证请求头', maxBytes: '单次响应上限（字节）',
  ignore: '忽略的路径', repos: '仓库', workspacePath: '需求存放区目录', urls: 'URL 列表',
}
/** 枚举文案：先按 `${kind}.${字段}` 找，再按字段找。 */
export const ENUM_LABEL: Record<string, Record<string, string>> = {
  'rag.type': { upload: '拖拽上传', path: '空间内目录', repo: '仓库', url: 'URL 列表' },
  'llm-wiki.mode': { space: '上传 Markdown', path: '空间内目录', git: 'Git 仓库', generate: '从代码生成' },
  'history.source': { 'git-history': '提交历史', workspace: '过往需求', both: '两者都要' },
  granularity: { directory: '按目录', module: '按模块' },
}
export const HINT: Record<string, string> = {
  tables: '回车添加；留空表示全部表', schemas: '留空表示全部', chunkTokens: '800 左右适合大多数文档', connection: '存为密钥引用，页面读不到明文',
  openapi: 'OpenAPI 3 JSON 的 URL，或空间内的文件路径', baseURL: '留空时用 spec 里的 servers', path: '相对空间目录', workspacePath: '留空用本空间的 .takt',
}
export const enumLabel = (kind: string, key: string, v: string) => ENUM_LABEL[`${kind}.${key}`]?.[v] ?? ENUM_LABEL[key]?.[v] ?? v

/** 必填但 schema 里没给 property 的字段（例如 api.openapi）也当字符串渲染。 */
export function fieldsOf(schema: Schema): Array<[string, Schema]> {
  const props = Object.entries(schema.properties ?? {})
  const extra = (schema.required ?? []).filter((k) => !schema.properties?.[k]).map((k): [string, Schema] => [k, { type: 'string' }])
  return [...extra, ...props]
}

export function defaultsOf(schema: Schema): Config {
  const out: Config = {}
  for (const [k, s] of fieldsOf(schema)) {
    if (s.default !== undefined) out[k] = s.default
    else if (k === 'sources') out[k] = [{ type: 'upload' }]
    else if (s.enum) out[k] = s.enum[0]
    else if (s.type === 'array') out[k] = []
  }
  return out
}

/** llm-wiki 的来源：generate 存在就是"从代码生成"，否则看 source。 */
export const wikiMode = (cfg: Config) => (cfg.generate ? 'generate' : String(cfg.source ?? 'space'))
export function setWikiMode(cfg: Config, mode: string): Config {
  const { generate: _g, source: _s, ...rest } = cfg
  return mode === 'generate' ? { ...rest, generate: { repo: '', granularity: 'module', ...((cfg.generate as Config | undefined) ?? {}) } } : { ...rest, source: mode }
}
/** 这个字段在当前配置下是否显示（llm-wiki 按来源切换字段）。 */
export function visible(kind: string, key: string, cfg: Config): boolean {
  if (kind !== 'llm-wiki') return true
  const mode = wikiMode(cfg)
  if (key === 'source' || key === 'generate') return false
  if (key === 'path') return mode === 'path'
  if (key === 'url' || key === 'branch') return mode === 'git'
  return true
}
/** 是否需要上传文件：rag 的 upload 源、llm-wiki 的 space 来源。 */
export function wantsUpload(kind: string, cfg: Config): boolean {
  if (kind === 'rag') return ((cfg.sources as Config[] | undefined) ?? []).some((s) => s.type === 'upload')
  if (kind === 'llm-wiki') return wikiMode(cfg) === 'space'
  return false
}

const empty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)

/** 必填项里还空着的（下一步按钮旁显示）。上传类源要求至少一个文件（新建时）或已有文档（hasDocs）。 */
export function missingFields(kind: string, cfg: Config, files: number, schema: Schema, hasDocs = false): string[] {
  const miss: string[] = []
  for (const k of schema.required ?? []) if (empty(cfg[k])) miss.push(LABEL[k] ?? k)
  if (wantsUpload(kind, cfg) && !files && !hasDocs) miss.push('至少上传一个文件')
  if (kind === 'rag') {
    for (const s of (cfg.sources as Config[] | undefined) ?? []) {
      if (s.type === 'repo' && !s.repo) miss.push('仓库')
      if (s.type === 'path' && !s.path) miss.push('目录')
      if (s.type === 'url' && empty(s.urls)) miss.push('URL')
    }
  }
  if (kind === 'llm-wiki') {
    const mode = wikiMode(cfg)
    if (mode === 'path' && !cfg.path) miss.push('目录')
    if (mode === 'git' && !cfg.url) miss.push('Git 地址')
    if (mode === 'generate' && !(cfg.generate as Config | undefined)?.repo) miss.push('仓库')
  }
  return [...new Set(miss)]
}

/** 数字输入：空串 → undefined（不提交），integer 取整。 */
export function parseNumber(raw: string, integer: boolean): number | undefined {
  if (raw.trim() === '') return undefined
  const n = Number(raw)
  if (!Number.isFinite(n)) return undefined
  return integer ? Math.trunc(n) : n
}

/**
 * 提交前去掉"没填"的白名单：表单里 tables / schemas / ignore 这类数组默认是 []，
 * 而服务端把空数组当成"一个都不允许"（database 的 tables: [] 会让快照 0 张表），界面上写的却是"留空表示全部"。
 * 只去掉顶层的空数组与空字符串；sources 等结构化字段原样保留。
 */
export function compactConfig(cfg: Config): Config {
  return Object.fromEntries(Object.entries(cfg).filter(([k, v]) => k === 'sources' || !((Array.isArray(v) && v.length === 0) || v === '')))
}
