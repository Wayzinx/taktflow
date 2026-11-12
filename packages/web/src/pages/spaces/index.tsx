import { useState } from 'react'
import { Boxes, Plus } from 'lucide-react'
import type { SpaceSummary } from '@taktflow/core'
import { invalidate, useAsync, useSource } from '../../api'
import { useCrumbs } from '../../components/layout'
import { EmptyState, ErrorState, PageHeader, SkeletonGrid, toast, useFlashRows, useStagger, useStewardSuggestions } from '../../components/ui'
import { navigate, useLocation } from '../../lib/router'
import { spacePath } from '../../lib/space'
import { openCreateSpace } from '../../lib/ui-store'
import { ArchivedSpaces } from './archived'
import { SpaceCard } from './card'
import { DeleteSpaceDialog, EditSpaceDialog } from './dialogs'
import './spaces.css'

/**
 * /spaces：全部空间的卡片网格（全局路由）。props 无。
 * 卡片：需求数、进行中、阻塞、待办、风险、最近活动；菜单里编辑（名称 / 描述 / 颜色）、复制为新空间、归档。
 * 已归档区：恢复，或输入 id 确认后彻底删除。
 */
export function SpacesPage() {
  const ds = useSource()
  const { spaceId } = useLocation()
  const q = useAsync((s) => Promise.all([s.spaces(), s.spaces({ archived: true }), s.serverInfo()]), [])
  const [live, archived, info] = q.data ?? []
  const suggestions = useStewardSuggestions('spaces')
  const st = useStagger(live?.length ?? 0)
  const flash = useFlashRows((live ?? []).map((s) => s.id))
  const flashArchived = useFlashRows((archived ?? []).map((s) => s.id))
  const [editing, setEditing] = useState<SpaceSummary>()
  const [deleting, setDeleting] = useState<SpaceSummary>()
  useCrumbs([{ label: '全部空间' }], [])
  const currentId = spaceId ?? live?.[0]?.id

  const archive = async (s: SpaceSummary) => {
    try {
      // 服务端归档会把 id 改成 <id>@<时间>：撤销（恢复）要用返回的归档 id
      const archivedSpace = await ds.archiveSpace(s.id, '网页归档空间')
      invalidate()
      // 归档的是当前空间：换到另一个空间继续看这个页面
      if (s.id === currentId) {
        const other = live?.find((x) => x.id !== s.id)
        if (other) navigate(spacePath(other.id, '/spaces'), { replace: true })
      }
      toast(`已归档「${s.name}」`, { body: '可以在下方"已归档"里恢复', undo: () => ds.restoreSpace(archivedSpace.id, '撤销归档').then(invalidate) })
    } catch (e) {
      toast('没能归档', { tone: 'failed', body: (e as Error).message })
    }
  }
  const restore = async (s: SpaceSummary) => {
    try {
      // 恢复后 id 变回原 id：撤销与"进入"都用返回值
      const restored = await ds.restoreSpace(s.id, '网页恢复空间')
      invalidate()
      toast(`已恢复「${s.name}」`, { undo: () => ds.archiveSpace(restored.id, '撤销恢复').then(invalidate), action: { label: '进入', onClick: () => navigate(spacePath(restored.id)) } })
    } catch (e) {
      toast('没能恢复', { tone: 'failed', body: (e as Error).message })
    }
  }

  const risky = live?.filter((s) => (s.risks ?? 0) > 0).length ?? 0
  const active = live?.reduce((n, s) => n + s.active, 0) ?? 0
  const blocked = live?.reduce((n, s) => n + (s.blocked ?? 0), 0) ?? 0
  const single = info && !info.multiSpace
  return (
    <div className="page sp-page">
      <PageHeader
        title="全部空间"
        description={live ? `${live.length} 个空间，${active} 个需求未交付${blocked ? `，${blocked} 个需求阻塞` : ''}${risky ? `，${risky} 个空间有待处理的风险` : ''}` : '每个空间是一条交付线：自己的需求、流水线、成员和知识库'}
        suggestions={suggestions}
        actions={
          <button type="button" className="btn btn-primary" onClick={() => openCreateSpace()} title={single ? '单空间模式下不能新建，点开看原因' : '新建空间'}>
            <Plus />
            新建空间
          </button>
        }
      />
      {q.error && !q.data ? (
        <ErrorState error={q.error} onRetry={q.reload} />
      ) : !live ? (
        <SkeletonGrid count={4} min={280} />
      ) : live.length === 0 ? (
        <EmptyState icon={Boxes} title="还没有空间" body="新建一个空间，开始第一条交付线。" action={<button type="button" className="btn btn-primary" onClick={() => openCreateSpace()}>新建空间</button>} stewardAsk="帮我新建一个空间并配好标准交付流水线" />
      ) : (
        <div className="sp-grid">
          {live.map((s, i) => (
            <SpaceCard
              key={s.id}
              s={s}
              current={s.id === currentId}
              className={`${st(i).className ?? ''} ${flash(s.id)}`}
              style={st(i).style}
              onEdit={() => setEditing(s)}
              onArchive={() => void archive(s)}
            />
          ))}
        </div>
      )}
      {archived && <ArchivedSpaces rows={archived} flash={flashArchived} onRestore={(s) => void restore(s)} onDelete={setDeleting} />}
      <EditSpaceDialog space={editing} live={live ?? []} onClose={() => setEditing(undefined)} />
      <DeleteSpaceDialog space={deleting} onClose={() => setDeleting(undefined)} />
    </div>
  )
}
