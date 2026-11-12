import { Compass, LayoutDashboard, Search } from 'lucide-react'
import { useAsync } from '../api'
import { setPaletteOpen } from '../components/command-palette'
import { suggestPage } from '../components/command-palette/pages'
import { useCrumbs } from '../components/layout'
import { EmptyState } from '../components/ui'
import { Link, useLocation } from '../lib/router'
import { lastSpaceId, spacePath } from '../lib/space'
import { SHORTCUTS, shortcutLabel } from '../lib/shortcuts'

/** 空间内不存在的页面：给回到总览、⌘K 两个出口；地址像是打错了某个页面时直接问"是不是要找…"（TF-090）。 */
export function NotFoundPage() {
  const { path } = useLocation()
  const guess = suggestPage(path)
  useCrumbs([{ label: '未找到' }], [])
  return (
    <div className="card" style={{ maxWidth: 640, margin: '40px auto' }}>
      <EmptyState
        icon={Compass}
        title="页面不存在"
        body={guess ? <>链接可能已失效。你是不是要找 <Link to={guess.to}>{guess.label}</Link>？</> : '链接可能已失效，或者地址打错了。'}
        action={
          <>
            <Link to={guess?.to ?? '/'} className="btn btn-primary">
              {guess ? <guess.icon aria-hidden /> : <LayoutDashboard aria-hidden />}
              {guess ? `去${guess.label}` : '回到总览'}
            </Link>
            {guess && (
              <Link to="/" className="btn">
                回到总览
              </Link>
            )}
            <button type="button" className="btn" onClick={() => setPaletteOpen(true)}>
              <Search aria-hidden />
              搜索或跳转 <span className="kbd">{shortcutLabel(SHORTCUTS.palette)}</span>
            </button>
          </>
        }
      />
    </div>
  )
}

/**
 * 地址里的空间不存在或已归档（TF-057）：说明原因，给"回到上次的空间""全部空间"两个出口；已归档的去全部空间里恢复。
 * 重试没有意义，不放重试按钮。
 */
export function SpaceNotFoundPage({ id, archived }: { id: string; archived: boolean }) {
  useCrumbs([{ label: archived ? '空间已归档' : '空间不存在' }], [archived])
  const spaces = useAsync((ds) => ds.spaces(), []).data ?? []
  const last = lastSpaceId()
  const back = spaces.find((s) => s.id === last && s.id !== id) ?? spaces.find((s) => s.id !== id)
  // 站内链接会自动补上当前（不存在的）空间前缀：出口一律写成带目标空间前缀的绝对地址
  const all = back ? spacePath(back.id, '/spaces') : '/spaces'
  return (
    <div className="card" style={{ maxWidth: 640, margin: '40px auto' }}>
      <EmptyState
        mascot="ask"
        title={archived ? `空间「${id}」已归档` : `空间「${id}」不存在`}
        body={archived ? '归档的空间不能直接打开。可以在“全部空间”的已归档列表里恢复它。' : '链接里的空间可能被删除、改了名，或者地址打错了。'}
        action={
          <>
            {back && (
              <Link to={spacePath(back.id)} className="btn btn-primary">
                回到「{back.name}」
              </Link>
            )}
            <Link to={all} className={back ? 'btn' : 'btn btn-primary'}>
              {archived ? '去全部空间恢复' : '查看全部空间'}
            </Link>
          </>
        }
      />
    </div>
  )
}
