import { spaceLock } from './space-lock.js'
import { readFile, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { explicitRoleHarness, harnessSelectors, listSkills, parseFrontmatter, parseRoleProfile, patchFrontmatter, loadPlugins, roleSources, selectHarness, sha256, systemWrite, validateHarnessSelector,
  type AgentRoleView, type HarnessSelector, type ProjectStores } from '@taktflow/core'
import { createHarnesses, createRedactor, collectSecrets } from '@taktflow/harness'
import { actor, authorize, body, HttpError, text } from './http.js'
import { atomicWrite, auditSpace, spaceFile, workflowStore } from './space.js'
import type { Handler } from './routes.js'
import type { M3Callbacks } from './m3-routes.js'

const roleId = (id: string) => { if (!/^[a-z][a-z0-9-]{0,39}$/.test(id)) throw new HttpError(400, 'role 不合法，请使用小写字母开头的字母、数字或短横线，最多 40 位'); return id }
const fields = ['title', 'description', 'harness', 'skills', 'knowledge', 'writeScope', 'readScope', 'allowBash'] as const

async function roleProblems(stores: ProjectStores, profile: ReturnType<typeof parseRoleProfile>, selector: HarnessSelector, options: M3Callbacks): Promise<string[]> {
  const errors: string[] = []
  const skills = new Set((await listSkills(stores.paths.skills)).map(s => s.name))
  for (const id of profile.skills) if (!skills.has(id)) errors.push(`skills：技能 ${id} 不存在，请先添加技能`)
  for (const id of profile.knowledge ?? []) if (!stores.config.knowledgeBindings?.some(b => b.baseId === id)) errors.push(`knowledge：知识库 ${id} 未绑定，请先绑定知识库`)
  const plugins = await loadPlugins(stores.config, stores.projectDir, url => import(url))
  const harnesses = { ...createHarnesses({ config: stores.config, projectDir: stores.projectDir }), ...plugins.harnesses }
  try { validateHarnessSelector(selector, stores.config, harnesses) }
  catch (error) { errors.push(`harness：${createRedactor(collectSecrets(undefined, stores.config.providers))((error as Error).message)}，请修改角色配置`) }
  for (const choice of harnessSelectors(selector)) {
    if (choice.model && !stores.config.models?.[choice.model] && !Object.values(stores.config.models ?? {}).some(m => m.id === choice.model)) {
      // 适配器没有列原始模型的协议；已知 CLI 名称可直接使用，其他模型先登记别名。
      const native = choice.harness === 'claude-code' ? /^(default|sonnet|opus|haiku|claude-[\w.-]+)$/ : choice.harness === 'codex' ? /^(gpt-[\w.-]+|o[134](?:-[\w.-]+)?)$/ : choice.harness === 'gemini-cli' ? /^gemini-[\w.-]+$/ : /$^/
      if (!native.test(choice.model)) errors.push(`harness.model：模型 ${choice.model} 未配置，请先登记模型别名`)
    }
  }
  return errors
}

export async function agentRoles(stores: ProjectStores, options: M3Callbacks = {}): Promise<AgentRoleView[]> {
  const sources = await roleSources(stores), registry = workflowStore(stores)
  const workflows = await Promise.all((await registry.list({ record: false })).map(w => registry.get(w.id, { record: false })))
  const profiles = Object.fromEntries(Object.entries(sources).map(([role, source]) => [role, parseRoleProfile(source.markdown, role)]))
  return Promise.all(Object.entries(sources).map(async ([role, source]) => {
    const profile = profiles[role]!, harness = explicitRoleHarness(profile)
    const usedBy: AgentRoleView['usedBy'] = []
    const visit = (value: unknown, workflowId: string, workflowTitle?: string, parentId?: string): void => {
      if (Array.isArray(value)) { value.forEach(v => visit(v, workflowId, workflowTitle, parentId)); return }
      if (!value || typeof value !== 'object') return
      const node = value as Record<string, unknown>, nodeId = typeof node.id === 'string' ? node.id : parentId
      if (node.role === role && nodeId) usedBy.push({ workflowId, workflowTitle, nodeId, ...(node.harness ? { harness: node.harness as HarnessSelector } : {}) })
      for (const [key, v] of Object.entries(node)) if (['nodes', 'body', 'workflow', 'author', 'reviewers', 'checks'].includes(key)) visit(v, workflowId, workflowTitle, nodeId)
    }
    for (const doc of workflows) {
      if (doc.snapshot) visit(doc.snapshot.nodes, doc.id, doc.snapshot.title)
      else {
        const unpack = (nodes: typeof doc.model.nodes): unknown[] => nodes.map(node => ({ id: node.id,
          ...Object.fromEntries(Object.entries(node.props).filter(([, v]) => v.kind === 'literal').map(([k, v]) => [k, v.kind === 'literal' ? v.value : undefined])),
          ...(node.body ? { body: unpack(node.body) } : {}),
        }))
        visit(unpack(doc.model.nodes), doc.id, doc.model.meta.title.kind === 'literal' ? String(doc.model.meta.title.value) : doc.id)
      }
    }
    for (const workflow of (await loadPlugins(stores.config, stores.projectDir, url => import(url))).workflows) visit(workflow.nodes, workflow.id, workflow.title)
    const effective: AgentRoleView['effective'] = { harness: selectHarness(role, undefined, { config: stores.config, profiles, harnesses: {} }), source: harness ? 'role' : stores.config.roles?.[role] ? 'space-default' : 'builtin' }
    return { ...profile, instructions: parseFrontmatter(source.markdown).body, harness, role, origin: source.origin, revision: sha256(source.markdown),
      ...(source.path ? { path: relative(stores.projectDir, source.path) } : {}), effective, usedBy, problems: await roleProblems(stores, profile, effective.harness, options) }
  }))
}

export function agentRoutes(add: (method: string, path: string, handler: Handler) => void, options: M3Callbacks) {
  const wrap = (handler: Handler): Handler => async context => {
    try { return await handler(context) } catch (error) {
      if (error instanceof HttpError) throw error
      throw new HttpError(400, createRedactor(collectSecrets(undefined, context.stores.config.providers))(`${(error as Error).message}；请检查角色配置后重试`))
    }
  }
  add('GET', '/api/space/agents', wrap(({ stores }) => agentRoles(stores, options)))
  add('GET', '/api/space/agents/:role', wrap(async ({ stores, params }) => {
    const found = (await agentRoles(stores, options)).find(r => r.role === roleId(params.role!))
    if (!found) throw new HttpError(404, '角色不存在，请刷新角色列表')
    return found
  }))
  for (const method of ['PUT', 'DELETE']) add(method, '/api/space/agents/:role', wrap(async ({ stores, params, request, response }) => {
    authorize(request, stores, 'owner')
    const role = roleId(params.role!), input = await body(request), reason = text(input.reason, 'reason（修改原因）')
    return spaceLock(join(stores.taktDir, 'agent-edit'), async () => {
      const source = (await roleSources(stores))[role]
      const checkedFile = await spaceFile(stores, 'agent', source?.path ? relative(stores.paths.agents, source.path) : role)
      const file = join(stores.projectDir, checkedFile.path)
      if (method === 'DELETE') {
        if (source?.origin !== 'space') throw new HttpError(400, '只能删除空间档案，请先保存为本空间角色')
        const usedBy = (await agentRoles(stores, options)).find(r => r.role === role)!.usedBy
        if (usedBy.length) throw new HttpError(409, `角色仍被 ${usedBy.map(n => `${n.workflowId}/${n.nodeId}`).join('、')} 使用，请先修改 workflow`)
        await systemWrite(stores.projectDir, [checkedFile.path, '.takt/space-events.jsonl*'], async () => {
          await auditSpace(stores, actor(request, stores), reason, `删除角色 ${role}`)
          await rm(file)
        })
        response.writeHead(204); response.end(); return (await import('./routes.js')).STREAMING
      }
      if (input.baseRevision !== undefined && input.baseRevision !== (source ? sha256(source.markdown) : undefined)) throw new HttpError(409, '角色档案已被其他人修改，请刷新后重试')
      const patch: Record<string, unknown> = {}
      for (const key of Object.keys(input)) if (![...fields, 'instructions', 'reason', 'baseRevision'].includes(key)) throw new HttpError(400, `字段 ${key} 不支持，请检查角色表单`)
      for (const key of fields) if (Object.hasOwn(input, key)) patch[key] = input[key]
      for (const key of ['title', 'description', 'instructions']) if (input[key] !== undefined) text(input[key], key, true)
      for (const key of ['writeScope', 'readScope']) if (input[key] !== undefined && input[key] !== null) {
        if (!Array.isArray(input[key]) || (input[key] as unknown[]).some(p => typeof p !== 'string' || !p || p.startsWith('/') || p.includes('..') || p.includes('\\') || /^[A-Za-z]:/.test(p))) throw new HttpError(400, `${key} 必须是相对路径 glob，不能包含 ..，请修正路径`)
      }
      const content = patchFrontmatter(source?.markdown ?? '', patch, input.instructions as string | undefined)
      const profile = parseRoleProfile(content, role)
      const selector = selectHarness(role, undefined, { config: stores.config, profiles: { [role]: profile }, harnesses: {} })
      const problems = await roleProblems(stores, profile, selector, options)
      if (problems.length) throw new HttpError(400, problems.join('；'))
      await systemWrite(stores.projectDir, [checkedFile.path, `${checkedFile.path}.*.tmp`, '.takt/space-events.jsonl*'], async () => {
        await auditSpace(stores, actor(request, stores), reason, `更新角色 ${role}`)
        await atomicWrite(file, content)
        if (await readFile(file, 'utf8') !== content) throw new Error('角色档案写后读取不一致')
        parseRoleProfile(await readFile(file, 'utf8'), role)
      })
      return (await agentRoles(stores, options)).find(r => r.role === role)
    })
  }))
}
