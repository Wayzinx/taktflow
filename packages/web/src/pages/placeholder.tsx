import { Compass } from 'lucide-react'
import { useCrumbs } from '../components/layout'
import { EmptyState } from '../components/ui'

export function NotFoundPage() {
  useCrumbs([{ label: '未找到' }], [])
  return (
    <div className="card" style={{ maxWidth: 640, margin: '40px auto' }}>
      <EmptyState icon={Compass} title="页面不存在" hint="链接可能已失效。" />
    </div>
  )
}
