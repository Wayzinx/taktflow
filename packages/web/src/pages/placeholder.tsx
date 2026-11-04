import { BookOpen, Compass } from 'lucide-react'
import { PageHeader, useCrumbs } from '../components/layout'
import { EmptyState } from '../components/ui'

const PAGES = {
  knowledge: {
    title: '知识源',
    icon: BookOpen,
    sub: '存量项目的知识层：按问题类型路由到 rg / Wiki / CodeGraph / 数据库 / 接口注册 / git 历史。',
    hint: <>里程碑 M1 提供可视化管理。现在可以用 <span className="mono">takt kb query "&lt;问题&gt;" --intent impact</span> 检索，并在 takt.config.json 的 knowledge 里注册源。</>,
  },
} as const

export function PlaceholderPage({ kind }: { kind: keyof typeof PAGES }) {
  const p = PAGES[kind]
  useCrumbs([{ label: p.title }], [kind])
  return (
    <div className="page fade-in" style={{ maxWidth: 980 }}>
      <PageHeader title={p.title} sub={p.sub} />
      <div className="card">
        <EmptyState icon={p.icon} title="即将推出" hint={p.hint} />
      </div>
    </div>
  )
}

export function NotFoundPage() {
  useCrumbs([{ label: '未找到' }], [])
  return (
    <div className="card" style={{ maxWidth: 640, margin: '40px auto' }}>
      <EmptyState icon={Compass} title="页面不存在" hint="链接可能已失效。" />
    </div>
  )
}
