import { attributeDefectCheckpoints, type AttributionWriteOptions } from './checkpoint-attribution.js'
import { structuredLog } from '../util/structured-log.js'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { stringify } from 'yaml'
import type { EngineDeps, ProjectStores } from '../interfaces.js'
import type { DefectConfirmRequest, DefectDetail, DefectReportRequest } from '../api.js'
import type { Actor, Defect, DefectAttribution } from '../types.js'
import { parseFrontmatter } from '../util/frontmatter.js'
import { sha256 } from '../util/hash.js'
import { withLock } from '../store/locks.js'
import { withFileLock } from '../store/file-lock.js'
import { assertRequirementId } from '../store/paths.js'
import { validateSchema } from '../engine/schema.js'
import { snapshotNodes } from '../engine/recipe.js'
import { readOnlyModel } from '../eval/model.js'
import { defectCases, saveEvalCase, validateEvalCase } from '../eval/cases.js'
import { attributionSchema } from './schema.js'
import { precheckDefect } from './precheck.js'
import { QualityConflictError } from '../quality/index.js'
export { precheckDefect } from './precheck.js'
export { QualityConflictError } from '../quality/index.js'
export type { DefectPrecheck } from './precheck.js'

const system: Actor = { type: 'system', id: 'defects' }
function defectId(id: string): string { if (!/^D-[1-9]\d*$/.test(id)) throw new Error('非法缺陷 id'); return id }
const pending = new Map<string, Promise<void>>()
const key = (stores: ProjectStores, req: string, id: string) => `${stores.projectDir}:${req}:${id}`
async function requireReq(stores: ProjectStores, req: string) {
  assertRequirementId(req)
  if (!await stores.workspaces.getRequirement(req)) throw new Error(`需求不存在：${req}`)
}
async function write(stores: ProjectStores, defect: Defect, actor: Actor, reason: string, attribution?: DefectAttribution) {
  if (stores.quality) {
    const current = (await stores.quality.defects(defect.requirementId)).find((item) => item.id === defect.id)
    if (current && defect.revision === undefined) throw new QualityConflictError(`缺陷 ${defect.id} 已由另一写入者创建；请重新读取后重试`)
    const requestId = randomUUID()
    const entries: Parameters<typeof stores.quality.append>[0] = [{ kind: current ? 'defect.updated' : 'defect.created',
      key: `defect:${requestId}`, requirementId: defect.requirementId, data: { ...defect, reason }, actor }]
    if (attribution) entries.push({ kind: attribution.confirmed ? 'attribution.confirmed' : 'attribution.recorded',
      key: `attribution:${requestId}`, requirementId: defect.requirementId, data: { ...attribution, reason }, actor })
    await stores.quality.append(entries, current ? { baseRevision: { defectId: defect.id, revision: defect.revision ?? current.revision ?? 0 } } : undefined)
    // 日志是权威；投影失败不回滚日志，下次读缺陷仍能找到已经提交的记录。
    await withFileLock(join(stores.taktDir, 'quality', 'defect-projections'), async () => {
      const saved = (await stores.quality!.defects(defect.requirementId)).find((item) => item.id === defect.id)!
      const { attribution: savedAttribution, ...savedDefect } = saved
      Object.assign(defect, savedDefect)
      await project(stores, savedDefect, actor, reason, savedAttribution)
    })
    return
  }
  await project(stores, defect, actor, reason, attribution)
}
async function project(stores: ProjectStores, defect: Defect, actor: Actor, reason: string, attribution?: DefectAttribution) {
  const contents: Array<[string, string]> = []
  if (attribution) contents.push([`defects/${defect.id}.attribution.json`, JSON.stringify(attribution, null, 2)])
  contents.push([`defects/${defect.id}.md`, `---\n${stringify(defect)}---\n\n${defect.description}\n`])
  for (const [path, content] of contents) {
    const ref = await stores.workspaces.writeArtifact({ ref: { workspace: defect.requirementId, path }, content, kind: 'defect', author: actor, reason, title: defect.title })
    // 复用现有产物审计协议，未发生流水线运行的需求也有独立哈希链。
    const runId = `defect-${defect.requirementId}`
    await stores.events.append(runId, { type: 'artifact.written', actor, data: { ref, kind: 'defect', sha256: sha256(content) } })
    await stores.events.append(runId, { type: 'log', actor, data: structuredLog({ action: defect.status, ref, reason }) })
  }
}
export async function listDefects(stores: ProjectStores, requirementId: string): Promise<DefectDetail[]> {
  await requireReq(stores, requirementId)
  if (stores.quality) return (await stores.quality.defects(requirementId)).map((defect) => ({ ...defect,
    ...(pending.has(key(stores, requirementId, defect.id)) ? { attributing: true } : {}) }))
  const result: DefectDetail[] = []
  for (const artifact of await stores.workspaces.listArtifacts(requirementId)) {
    const match = /^defects\/(D-\d+)\.md$/.exec(artifact.path)
    if (match) result.push(await getDefect(stores, requirementId, match[1]!))
  }
  return result
}
export async function getDefect(stores: ProjectStores, req: string, id: string): Promise<DefectDetail> {
  await requireReq(stores, req); defectId(id)
  if (stores.quality) {
    const defect = (await stores.quality.defects(req)).find((item) => item.id === id)
    if (!defect) throw new Error(`缺陷不存在：${req}/${id}`)
    return { ...defect, ...(pending.has(key(stores, req, id)) ? { attributing: true } : {}) }
  }
  const content = await stores.workspaces.readArtifact({ workspace: req, path: `defects/${id}.md` })
  if (!content) throw new Error(`缺陷不存在：${req}/${id}`)
  const defect = parseFrontmatter(content.toString()).data as unknown as Defect
  const attribution = await stores.workspaces.readArtifact({ workspace: req, path: `defects/${id}.attribution.json` })
  return { ...defect, ...(attribution ? { attribution: JSON.parse(attribution.toString()) as DefectAttribution } : {}), ...(pending.has(key(stores, req, id)) ? { attributing: true } : {}) }
}
export async function reportDefect(stores: ProjectStores, requirementId: string, request: DefectReportRequest, by: Actor): Promise<DefectDetail> {
  await requireReq(stores, requirementId)
  if (!request.title?.trim() || !request.description?.trim() || !['critical', 'major', 'minor'].includes(request.severity)) throw new Error('缺陷必须有标题、描述和有效 severity')
  if (request.acs?.some((ac) => !/^AC-\d+(?:-\d+)?$/.test(ac))) throw new Error('AC id 不合法')
  return withFileLock(join(stores.workspaces.dir(requirementId), 'defects'), async () => {
    const existing = await listDefects(stores, requirementId)
    const id = `D-${Math.max(0, ...existing.map((item) => Number(item.id.slice(2)))) + 1}`
    const defect: Defect = { title: request.title, description: request.description, severity: request.severity, acs: request.acs, links: request.links, evidence: request.evidence,
      id, requirementId, foundAt: new Date().toISOString(), reportedBy: by, status: 'open' }
    await write(stores, defect, by, request.reason ?? '录入逃逸缺陷')
    return defect
  })
}
async function validateAttribution(stores: ProjectStores, req: string, attribution: DefectAttribution) {
  validateSchema(attribution, attributionSchema)
  if (!Number.isFinite(attribution.confidence) || attribution.confidence < 0 || attribution.confidence > 1) throw new Error('归因 confidence 必须在 0–1 之间')
  const runs = await stores.runs.list({ requirementId: req })
  for (const item of [attribution.introducedAt, ...attribution.missedBy]) {
    if (!item.evidence.length || item.evidence.some((text) => !text.trim())) throw new Error('归因必须附证据')
    if (!item.nodeId) continue
    const matches = runs.filter((run) => (!item.runId || item.runId === run.runId) && !!run.nodes[item.nodeId!])
    if (matches.length !== 1) throw new Error(`归因节点不存在或 runId 不唯一：${item.nodeId}`)
    item.runId = matches[0]!.runId
  }
  const artifact = attribution.introducedAt.artifact
  if (artifact && (artifact.workspace !== req || !Number.isSafeInteger(artifact.version) || !await stores.workspaces.readArtifact(artifact))) throw new Error('引入产物必须是本需求中存在的精确版本')
}
export async function attributeDefect(deps: EngineDeps, req: string, id: string): Promise<DefectDetail> {
  await requireReq(deps.stores, req); defectId(id)
  return withLock(join(deps.stores.workspaces.dir(req), 'defects', id), async () => {
    const { attribution: _old, attributing: _pending, ...defect } = await getDefect(deps.stores, req, id)
    if (defect.status === 'confirmed' || defect.status === 'closed') throw new Error('已确认缺陷不能被 Agent 覆盖')
    const artifacts = (await deps.stores.workspaces.listArtifacts(req)).filter((a) => a.kind !== 'defect')
    const roles = new Set<string>()
    const material: unknown[] = []
    for (const artifact of artifacts) for (const version of artifact.versions) {
      if (version.author.type === 'agent') roles.add(version.author.role)
      if (version.producedBy) {
        const snapshot = await deps.stores.runs.getWorkflow(version.producedBy.runId)
        const node = snapshotNodes(snapshot?.nodes ?? []).find((n) => n.id === version.producedBy!.nodeId)
        if (node?.role) roles.add(node.role)
      }
      material.push({ path: artifact.path, version, content: (await deps.stores.workspaces.readArtifact({ workspace: req, path: artifact.path, version: version.version }))?.toString() })
    }
    if (roles.has('auditor')) throw new Error('auditor 必须不同于任何产出角色')
    const precheck = await precheckDefect(deps.stores, defect)
    const response = await readOnlyModel(deps, 'auditor', `沿溯源归因，只输出候选，不得代人确认。证据不足时 origin=unknown。输出 JSON 满足 ${JSON.stringify(attributionSchema)}\n${JSON.stringify({ defect, precheck, artifacts: material })}`, attributionSchema)
    const attribution: DefectAttribution = { ...(response.data as DefectAttribution), defectId: id, precheck,
      by: { type: 'agent', role: 'auditor', harness: deps.profiles.auditor!.harness.harness }, at: new Date().toISOString() }
    delete attribution.confirmed
    await validateAttribution(deps.stores, req, attribution)
    defect.status = 'attributed'
    await write(deps.stores, defect, attribution.by, '独立 auditor 提交候选归因', attribution)
    return { ...defect, attribution }
  })
}
export async function startDefectAttribution(deps: EngineDeps, req: string, id: string, options?: AttributionWriteOptions): Promise<DefectDetail> {
  const current = await getDefect(deps.stores, req, id), identity = key(deps.stores, req, id)
  if (!pending.has(identity)) {
    if (current.status === 'confirmed' || current.status === 'closed') throw new Error('已确认缺陷不能重新归因')
    const task = (options ? attributeDefectCheckpoints(deps, req, id, options) : attributeDefect(deps, req, id)).then(() => {}, async (error: unknown) => {
      await deps.stores.events.append(`defect-${req}`, { type: 'log', actor: system, data: { level: 'error', message: `${id} 归因失败：${error instanceof Error ? error.message : String(error)}` } })
    }).finally(() => pending.delete(identity))
    pending.set(identity, task)
    void task.catch(() => {})
  }
  return { ...current, attributing: true }
}
export async function waitDefectAttribution(stores: ProjectStores, req: string, id: string): Promise<DefectDetail> {
  await pending.get(key(stores, req, id))
  return getDefect(stores, req, id)
}

export async function confirmDefect(stores: ProjectStores, req: string, id: string, request: DefectConfirmRequest, by: Actor): Promise<DefectDetail> {
  await requireReq(stores, req); defectId(id)
  if (by.type !== 'human') throw new Error('缺陷归因必须由人确认')
  if (request.attribution && !request.note?.trim()) throw new Error('修改归因必须填写备注')
  return withLock(join(stores.workspaces.dir(req), 'defects', id), async () => {
    const { attribution: old, attributing: _pending, ...defect } = await getDefect(stores, req, id)
    if (!old) throw new Error('必须先完成归因')
    const attribution: DefectAttribution = { ...old, introducedAt: request.attribution?.introducedAt ?? old.introducedAt,
      missedBy: request.attribution?.missedBy ?? old.missedBy, suggestions: request.attribution?.suggestions ?? old.suggestions,
      confirmed: { by, at: new Date().toISOString(), note: request.note, edited: !!request.attribution } }
    await validateAttribution(stores, req, attribution)
    defect.status = 'confirmed'
    const cases = await defectCases(stores, defect, attribution)
    for (const value of cases) validateEvalCase(value)
    for (const value of cases) await saveEvalCase(stores, value)
    await write(stores, defect, by, request.note?.trim() || '人工确认归因', attribution)
    return { ...defect, attribution }
  })
}
