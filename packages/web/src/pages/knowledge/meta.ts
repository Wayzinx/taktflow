import type { KnowledgeBase, KnowledgeBaseSummary, KnowledgeEvalCase, KnowledgeIntent, KnowledgeMissDiagnosis } from '@taktflow/core'
import {
  AlertTriangle,
  ArrowDownWideNarrow,
  BookOpen,
  CircleCheck,
  CircleDashed,
  Clock,
  Database,
  FileQuestion,
  FileText,
  GitCommitHorizontal,
  Library,
  LoaderCircle,
  Network,
  PlugZap,
  Rocket,
  SearchX,
  type LucideIcon,
} from 'lucide-react'
import type { StatusMeta, Tone } from '../../lib/status'

/** 知识库类型 → 图标、短名、色系（--c-*，只给图标底色用）。 */
export const KIND_META: Record<string, { icon: LucideIcon; label: string; color: string; unit: string }> = {
  rag: { icon: FileText, label: '文档检索', color: 'var(--c-1)', unit: '文档' },
  'llm-wiki': { icon: BookOpen, label: 'LLM Wiki', color: 'var(--c-3)', unit: '页' },
  database: { icon: Database, label: '数据库', color: 'var(--c-2)', unit: '表' },
  api: { icon: PlugZap, label: '接口', color: 'var(--c-4)', unit: '操作' },
  history: { icon: GitCommitHorizontal, label: '历史', color: 'var(--c-6)', unit: '提交' },
  code: { icon: Network, label: '代码图谱', color: 'var(--c-5)', unit: '符号' },
}
export const kindMeta = (kind: string) => KIND_META[kind] ?? { icon: Library, label: kind, color: 'var(--c-7)', unit: '项' }

export const KB_STATUS: Record<KnowledgeBase['status'], StatusMeta> = {
  draft: { label: '草稿', tone: 'skipped', icon: CircleDashed },
  building: { label: '构建中', tone: 'running', icon: LoaderCircle, spin: true },
  ready: { label: '可用', tone: 'success', icon: CircleCheck },
  stale: { label: '已过期', tone: 'stale', icon: Clock },
  error: { label: '出错', tone: 'failed', icon: AlertTriangle },
}

/**
 * 列表 / 详情 / 绑定里显示的状态：构建中优先；后端在"有没发布的候选版本"时也记为 stale，
 * 来源没变（staleDocs 为 0）时显示"待发布"，不说"已过期"。
 */
export function kbStatusMeta(b: Pick<KnowledgeBaseSummary, 'status' | 'version' | 'candidateVersion' | 'staleDocs'>, running?: boolean): StatusMeta {
  if (running) return KB_STATUS.building
  if (b.status === 'stale' && !b.staleDocs && b.candidateVersion !== undefined && b.candidateVersion > b.version) return { label: '待发布', tone: 'waiting', icon: Rocket }
  return KB_STATUS[b.status]
}

export const INTENTS: Array<{ id: KnowledgeIntent; label: string; hint: string }> = [
  { id: 'business', label: '业务规则', hint: '规范、约定、产品知识' },
  { id: 'fact', label: '实时事实', hint: '配置取值、接口返回' },
  { id: 'schema', label: '表结构', hint: '表、字段口径' },
  { id: 'impact', label: '影响面', hint: '调用链、改了影响哪里' },
  { id: 'symbol', label: '符号', hint: '某个东西在哪、有没有' },
  { id: 'history', label: '历史', hint: '为什么这么写' },
]
export const intentLabel = (i: KnowledgeIntent) => INTENTS.find((x) => x.id === i)?.label ?? i

export const SOURCE_META: Record<KnowledgeEvalCase['source'], { label: string; tone: Tone; hint: string }> = {
  manual: { label: '手工', tone: 'success', hint: '在检索测试里标注，发布门槛的主力' },
  synthetic: { label: '合成', tone: 'running', hint: '模型从文档出题，只做回归' },
  harvested: { label: '线上采集', tone: 'waiting', hint: '真实查询里被引用的命中' },
  defect: { label: '缺陷', tone: 'failed', hint: '归因为知识问题的缺陷，必须全部通过' },
}

/** 四类诊断：不同图标 + 不同颜色 + 文字（The Never Color Alone Rule）。 */
export const DIAGNOSIS: Record<KnowledgeMissDiagnosis, { label: string; icon: LucideIcon; tone: Tone; advice: string }> = {
  ok: { label: '找到了', icon: CircleCheck, tone: 'success', advice: '' },
  no_doc: { label: '没有相关文档', icon: FileQuestion, tone: 'failed', advice: '补文档，或把它的来源加进数据源' },
  not_retrieved: { label: '有文档没召回', icon: SearchX, tone: 'waiting', advice: '加同义词、调小切块，或提高 BM25 / 向量权重' },
  low_rank: { label: '召回了但排名低', icon: ArrowDownWideNarrow, tone: 'stale', advice: '开启 rerank，或调整 minScore' },
}

export function fmtBytes(n: number | undefined): string {
  if (!n) return '0 B'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)} MB`
  if (n >= 1000) return `${Math.round(n / 1000)} KB`
  return `${n} B`
}

export const pct = (v: number | undefined, d = 0) => (v === undefined ? '—' : `${(v * 100).toFixed(d)}%`)
export const fmtScore = (v: number | undefined) => (v === undefined ? '—' : v.toFixed(2))

/** 规模一句话：214 文档 · 1,892 块。 */
export function scaleText(b: Pick<KnowledgeBase, 'kind' | 'stats'>): string {
  const s = b.stats
  if (!s) return '还没有构建'
  if (b.kind === 'database') return `${s.tables ?? s.docs} 张表`
  if (b.kind === 'api') return `${s.operations ?? 0} 个操作`
  if (b.kind === 'llm-wiki') return `${s.pages ?? s.docs} 页 · ${s.chunks.toLocaleString()} 块`
  return `${s.docs.toLocaleString()} 文档 · ${s.chunks.toLocaleString()} 块`
}

/** 给"需要原因"的写接口拼一句默认原因：人在页面上直接操作时不再弹框索要。 */
export const autoReason = (what: string) => `在知识库页面${what}`

/** 名字 → 知识库 id（只取 ASCII；中文名没有可用字符时用备用 id）。 */
export const kbId = (name: string, fallback: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || fallback

/**
 * 评测集显示名：检索测试的标注会写进 es-manual，服务端第一次写入时自动建集、标题就是 id（协议没有建集接口），
 * 这里给它一个人话名字。
 */
export const evalSetTitle = (s: { id: string; title: string }) => (s.title && s.title !== s.id ? s.title : s.id === 'es-manual' ? '手工标注' : s.title || s.id)
