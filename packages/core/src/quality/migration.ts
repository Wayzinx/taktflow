import type { ProjectStores, QualityStore } from '../interfaces.js'
import type { Defect, DefectAttribution, EvalCase } from '../types.js'
import { parseFrontmatter } from '../util/frontmatter.js'
import { evalRoot, jsonFiles } from '../eval/storage.js'
import { readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import { assertNoSymlinks, isEnoent } from '../store/fs-utils.js'

export type QualityInput = Parameters<QualityStore['append']>[0][number]
export const MIGRATION_KEY = 'm3:import:complete'
export const qualityActor = { type: 'system', id: 'quality' } as const

export async function importM3(stores: ProjectStores): Promise<QualityInput[]> {
  const entries: QualityInput[] = []
  for (const requirement of await stores.workspaces.listRequirements()) {
    for (const artifact of await stores.workspaces.listArtifacts(requirement.id)) {
      const match = /^defects\/(D-[1-9]\d*)\.md$/.exec(artifact.path)
      if (!match) continue
      const content = await stores.workspaces.readArtifact({ workspace: requirement.id, path: artifact.path })
      if (!content) throw new Error(`M3 缺陷文件缺失：${artifact.path}；请恢复文件后重试同步`)
      const defect = parseFrontmatter(content.toString()).data as unknown as Defect
      if (defect.id !== match[1] || defect.requirementId !== requirement.id) throw new Error(`M3 缺陷身份不匹配：${artifact.path}；请核对存放区`)
      const identity = `${requirement.id}:${defect.id}`
      entries.push({ kind: 'defect.created', key: `m3:defect:${identity}`, requirementId: requirement.id,
        data: { ...defect, reason: '首次加载导入 M3 缺陷' }, actor: defect.reportedBy })
      const attribution = await stores.workspaces.readArtifact({ workspace: requirement.id, path: `defects/${defect.id}.attribution.json` })
      if (!attribution) continue
      const value = JSON.parse(attribution.toString()) as DefectAttribution
      if (value.defectId !== defect.id) throw new Error(`M3 归因身份不匹配：${identity}；请核对归因文件`)
      entries.push({ kind: value.confirmed ? 'attribution.confirmed' : 'attribution.recorded', key: `m3:attribution:${identity}`,
        requirementId: requirement.id, data: { ...value, reason: '首次加载导入 M3 归因' }, actor: value.confirmed?.by ?? value.by })
    }
  }
  const root = evalRoot(stores)
  await assertNoSymlinks(stores.projectDir, root)
  let directories: Dirent[]
  try { directories = await readdir(root, { withFileTypes: true }) } catch (error) { if (!isEnoent(error)) throw error; directories = [] }
  for (const directory of directories) {
    if (!directory.isDirectory() || directory.name === 'runs') continue
    const dir = join(root, directory.name)
    await assertNoSymlinks(root, dir)
    for (const sample of await jsonFiles<EvalCase>(dir)) {
      if (sample.source?.kind !== 'defect') continue
      entries.push({ kind: 'sample.added', key: `m3:sample:${sample.id}`, data: { ...sample, reason: '首次同步导入 M3 缺陷样本' }, actor: qualityActor })
    }
  }
  entries.push({ kind: 'recovery', key: MIGRATION_KEY, data: { action: 'm3.imported', reason: 'M3 兼容数据已完整导入' }, actor: qualityActor })
  return entries
}
