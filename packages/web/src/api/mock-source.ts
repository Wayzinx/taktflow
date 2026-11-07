import type { SpaceDetail } from '@taktflow/core'
import { currentSpaceId } from '../lib/space'
import { actingUser } from '../lib/acting-user'
import { createProjectMock, type ProjectSource } from './mock'
import { createMockDb, type MockDb } from './mock-data'
import { createMockSpaces, fakeHead, type MockSpace } from './mock-space'
import { createMockWorkflows, type WorkflowApi } from './mock-workflows'
import { archivedSpaces, createMockSpaceCrud, extraSpaces, MOCK_SERVER_INFO } from './mock-crud'
import { createMockKnowledge } from './mock-knowledge'
import { createMockSteward } from './mock-steward'
import type { DataSource } from './source'
import type { CrudSource, KnowledgeSource } from './source-m4'

const clone = <T,>(v: T): T => structuredClone(v)
const delay = <T,>(v: T, ms = 90): Promise<T> => new Promise((r) => setTimeout(() => r(clone(v)), ms))
const fail = (msg: string) => Promise.reject(new Error(msg))
/** 与服务端 text(reason, 'reason') 一致：空间写操作没有原因时 400。 */
const needReason = (reason: string | undefined) => (reason?.trim() ? undefined : fail('reason 必须是非空字符串'))

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
  const spaces = [...createMockSpaces(), ...extraSpaces()]
  const archived = archivedSpaces()
  const projects = new Map<string, ProjectSource>()
  const flows = new Map<string, WorkflowApi>()
  const knowledge = new Map<string, KnowledgeSource>()
  const crud = createMockSpaceCrud(spaces, archived, () => undefined)
  const steward = createMockSteward()

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
  function workflowsOf(sp: MockSpace): WorkflowApi {
    let w = flows.get(sp.detail.id)
    if (!w) {
      w = createMockWorkflows(sp.seeded)
      flows.set(sp.detail.id, w)
    }
    return w
  }
  // workflow 接口按调用时的空间转发
  const wf = <K extends keyof WorkflowApi>(key: K) =>
    ((...args: unknown[]) => {
      const sp = current()
      if (!sp) return fail(`空间 ${currentSpaceId()} 不存在`)
      return (workflowsOf(sp)[key] as (...a: unknown[]) => unknown)(...args)
    }) as WorkflowApi[K]
  const workflowApi: WorkflowApi = {
    workflows: wf('workflows'),
    workflow: wf('workflow'),
    editWorkflow: wf('editWorkflow'),
    replaceWorkflowSource: wf('replaceWorkflowSource'),
    saveWorkflowLayout: wf('saveWorkflowLayout'),
    workflowRevisions: wf('workflowRevisions'),
    workflowRevision: wf('workflowRevision'),
    rollbackWorkflow: wf('rollbackWorkflow'),
    convertWorkflow: wf('convertWorkflow'),
    subscribeWorkflow: (id, on) => {
      const sp = current()
      return sp ? workflowsOf(sp).subscribeWorkflow(id, on) : () => {}
    },
  }

  const withSpace = <T,>(fn: (sp: MockSpace) => T | Promise<T>): Promise<T> => {
    const sp = current()
    if (!sp) return fail(`空间 ${currentSpaceId()} 不存在`)
    return Promise.resolve(fn(sp))
  }
  // 知识库：每个空间一份，按调用时的空间转发（只有带种子数据的空间有内容）
  const kb = new Proxy({} as KnowledgeSource, {
    get(_t, key: string) {
      return (...args: unknown[]) => {
        const sp = current()
        if (!sp) return fail(`空间 ${currentSpaceId()} 不存在`)
        let k = knowledge.get(sp.detail.id)
        if (!k) knowledge.set(sp.detail.id, (k = createMockKnowledge(sp.seeded)))
        return (k[key as keyof KnowledgeSource] as (...a: unknown[]) => unknown)(...args)
      }
    },
  })
  const crudApi: CrudSource = {
    serverInfo: () => delay(MOCK_SERVER_INFO, 50),
    createSpace: crud.createSpace,
    updateSpace: crud.updateSpace,
    archiveSpace: crud.archiveSpace,
    restoreSpace: crud.restoreSpace,
    deleteSpace: crud.deleteSpace,
    convertWorkflow: workflowApi.convertWorkflow,
    // 需求增删改在单空间的 ProjectSource 里（mock.ts → mock-crud.ts），由下面的 Proxy 转发
    createRequirement: (body) => project().createRequirement(body),
    updateRequirement: (id, body) => project().updateRequirement(id, body),
    archiveRequirement: (id, reason) => project().archiveRequirement(id, reason),
    restoreRequirement: (id, reason) => project().restoreRequirement(id, reason),
    deleteRequirement: (id, reason) => project().deleteRequirement(id, reason),
  }

  const spaceApi: Pick<DataSource, 'me' | 'spaces' | 'space' | 'setMembers' | 'addRepo' | 'updateRepo' | 'syncRepo' | 'spaceFile' | 'saveSpaceFile'> = {
    // 与服务端 viewer() 一致：x-takt-user（这里是界面上选的身份），缺省为第一个 owner
    me: () =>
      withSpace((sp) => {
        const members = sp.detail.members
        const id = actingUser() || members.find((m) => m.role === 'owner')?.id || 'web'
        const member = members.find((m) => m.id === id)
        return delay({ id, name: member?.name ?? id, member }, 40)
      }),
    spaces: (opts) => delay(crud.list(opts?.archived), 60),
    // 空间详情里的 workflow 列表以 workflow 存储为准（编辑后 rev / 更新时间会变）
    space: () => withSpace(async (sp) => ({ ...(await delay(sp.detail)), workflows: await workflowsOf(sp).workflows() })),
    setMembers: (members, reason) =>
      needReason(reason) ??
      withSpace((sp) => {
        if (!members.some((m) => m.role === 'owner')) return fail('至少保留一位 owner')
        sp.detail.members = clone(members)
        return delay(sp.detail, 160)
      }),
    addRepo: (repo, reason) =>
      needReason(reason) ??
      withSpace((sp) => {
        if (sp.detail.repos.some((r) => r.id === repo.id)) return fail(`代码仓库 ${repo.id} 已存在`)
        sp.detail.repos.push({ ...repo, status: 'missing', message: '已登记，点同步拉取镜像。' })
        return delay(sp.detail, 160)
      }),
    updateRepo: (repoId, patch, reason) =>
      needReason(reason) ??
      withSpace((sp) => {
        const repo = sp.detail.repos.find((r) => r.id === repoId)
        if (!repo) return fail(`代码仓库 ${repoId} 不存在`)
        // 与 HTTP 一致：undefined 等于没传（JSON 会丢掉），null 表示清除该字段
        const fields = repo as unknown as Record<string, unknown>
        for (const [k, v] of Object.entries(patch)) {
          if (v === null) delete fields[k]
          else if (v !== undefined) fields[k] = clone(v)
        }
        return delay(sp.detail, 160)
      }),
    syncRepo: (repoId, reason) =>
      needReason(reason) ??
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
  const globals = { mock: true, ...spaceApi, ...workflowApi, ...crudApi, ...steward }
  return new Proxy(globals as DataSource, {
    get(target, key: string) {
      if (key in target) return target[key as keyof DataSource]
      if (key.startsWith('knowledge') || /Knowledge/.test(key)) return kb[key as keyof KnowledgeSource]
      const p = project() as unknown as Record<string, unknown>
      const v = p[key]
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(p) : v
    },
  })
}
