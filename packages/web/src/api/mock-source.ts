import type { SpaceDetail, SpaceSummary } from '@taktflow/core'
import { currentSpaceId } from '../lib/space'
import { createProjectMock, type ProjectSource } from './mock'
import { createMockDb, type MockDb } from './mock-data'
import { createMockSpaces, fakeHead, type MockSpace } from './mock-space'
import type { DataSource } from './source'

const clone = <T,>(v: T): T => structuredClone(v)
const delay = <T,>(v: T, ms = 90): Promise<T> => new Promise((r) => setTimeout(() => r(clone(v)), ms))
const fail = (msg: string) => Promise.reject(new Error(msg))

/** 空空间：沿用演示数据的结构，但没有需求、运行和待办。 */
function emptyDb(space: SpaceDetail): MockDb {
  const db = createMockDb()
  return { ...db, project: { name: space.name, description: space.description ?? '' }, requirements: [], artifacts: new Map(), contents: new Map(), comments: [], runs: new Map(), attention: [], traces: new Map(), metrics: new Map() }
}

/**
 * 多空间演示数据源：按当前 URL 的 /s/:spaceId 把请求分给对应空间的 ProjectSource。
 * 不带前缀时是第一个空间（默认空间）。
 */
export function createMockSource(): DataSource {
  const spaces = createMockSpaces()
  const projects = new Map<string, ProjectSource>()

  function current(): MockSpace | undefined {
    const id = currentSpaceId()
    return id ? spaces.find((s) => s.detail.id === id) : spaces[0]
  }
  function project(): ProjectSource {
    const sp = current() ?? spaces[0]!
    let p = projects.get(sp.detail.id)
    if (!p) {
      p = createProjectMock(sp.seeded ? createMockDb() : emptyDb(sp.detail))
      projects.set(sp.detail.id, p)
    }
    return p
  }
  const withSpace = <T,>(fn: (sp: MockSpace) => T | Promise<T>): Promise<T> => {
    const sp = current()
    if (!sp) return fail(`空间 ${currentSpaceId()} 不存在`)
    return Promise.resolve(fn(sp))
  }
  const summary = (d: SpaceDetail): SpaceSummary => ({ id: d.id, name: d.name, description: d.description, requirements: d.requirements, active: d.active })

  const spaceApi: Pick<DataSource, 'spaces' | 'space' | 'setMembers' | 'addRepo' | 'syncRepo' | 'spaceFile' | 'saveSpaceFile'> = {
    spaces: () => delay(spaces.map((s) => summary(s.detail)), 60),
    space: () => withSpace((sp) => delay(sp.detail)),
    setMembers: (members) =>
      withSpace((sp) => {
        if (!members.some((m) => m.role === 'owner')) return fail('至少保留一位 owner')
        sp.detail.members = clone(members)
        return delay(sp.detail, 160)
      }),
    addRepo: (repo) =>
      withSpace((sp) => {
        if (sp.detail.repos.some((r) => r.id === repo.id)) return fail(`代码仓库 ${repo.id} 已存在`)
        sp.detail.repos.push({ ...repo, status: 'missing', message: '已登记，点同步拉取镜像。' })
        return delay(sp.detail, 160)
      }),
    syncRepo: (repoId) =>
      withSpace((sp) => {
        const repo = sp.detail.repos.find((r) => r.id === repoId)
        if (!repo) return fail(`代码仓库 ${repoId} 不存在`)
        // 演示：带 error 的仓库同步仍然失败（权限问题不会自己好）
        if (repo.status === 'error') return new Promise<never>((_, rej) => setTimeout(() => rej(new Error(repo.message ?? '同步失败')), 1400))
        repo.status = 'syncing'
        return new Promise<{ head: string }>((r) =>
          setTimeout(() => {
            Object.assign(repo, { status: 'ready', head: fakeHead(), message: undefined })
            r({ head: repo.head! })
          }, 1600),
        )
      }),
    spaceFile: (kind, name) =>
      withSpace((sp) => {
        const content = sp.files.get(`${kind}:${name}`)
        if (content === undefined) return fail(`${kind === 'skill' ? '技能' : '角色'} ${name} 不存在`)
        const path = kind === 'skill' ? `skills/${name}/SKILL.md` : `agents/${name}.md`
        return delay({ kind, name, path, content }, 80)
      }),
    saveSpaceFile: (kind, name, body) =>
      withSpace((sp) => {
        if (!body.reason.trim()) return fail('修改原因必填')
        const key = `${kind}:${name}`
        if (!sp.files.has(key)) return fail(`${name} 不存在`)
        sp.files.set(key, body.content)
        const path = kind === 'skill' ? `skills/${name}/SKILL.md` : `agents/${name}.md`
        return delay({ kind, name, path, content: body.content }, 220)
      }),
  }

  // 所有需求 / 运行类接口按当前空间转发；方法在调用时取空间，切换空间不需要重建数据源
  return new Proxy({ mock: true, ...spaceApi } as DataSource, {
    get(target, key: string) {
      if (key in target) return target[key as keyof DataSource]
      const p = project() as unknown as Record<string, unknown>
      const v = p[key]
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(p) : v
    },
  })
}
