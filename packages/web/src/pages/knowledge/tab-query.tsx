import type { KnowledgeBaseDetail } from '@taktflow/core'
import { useAsync } from '../../api'
import { useLocation } from '../../lib/router'
import { QueryPanel } from './query-panel'

/** 检索测试 Tab：示例问题取自类型卡片。 */
export function QueryTab({ base }: { base: KnowledgeBaseDetail }) {
  const { query } = useLocation()
  const kinds = useAsync((d) => d.knowledgeKinds(), [])
  const example = kinds.data?.find((k) => k.kind === base.kind)?.example
  return <QueryPanel base={base} example={example} initial={query.get('q') ?? undefined} />
}
