import path from 'node:path'
import type { ProjectStores } from '../interfaces.js'
import type { ArtifactRef, ArtifactRecord } from '../types.js'
import type { InputSnapshot } from '../quality.js'
import { assertNoSymlinks } from './fs-utils.js'
import { assertArtifactPath, assertRequirementId } from './paths.js'
import { getObject } from './objects.js'
import { materializeReadonlyFiles, verifyReadonlyFiles } from './readonly-files.js'

export interface SnapshotMaterial {
  ref: ArtifactRef
  role: InputSnapshot['inputs'][number]['role']
  /** 已冻结 hash 的调用方可以额外约束 manifest，防止版本索引被替换。 */
  sha256?: string
}

/** 清单路径相对 dir，保留 ref.path；同路径不同内容必须拆为不同快照。 */
export async function materializeSnapshot(stores: Pick<ProjectStores, 'taktDir' | 'workspaces'>,
  refs: SnapshotMaterial[], dir: string): Promise<Record<string, string>> {
  const relative = path.relative(stores.taktDir, path.resolve(dir))
  if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    await assertNoSymlinks(stores.taktDir, dir)
    // 正式空间只允许落在指定快照目录，不能覆盖对象存储和质量日志。
    if (!relative.startsWith(`quality${path.sep}snapshots${path.sep}`)) throw new Error('空间快照必须位于 .takt/quality/snapshots/<checkpointId>/')
  }
  const artifacts = new Map<string, ArtifactRecord[]>()
  const files = new Map<string, Buffer>()
  for (const { ref, sha256: expected } of refs) {
    assertRequirementId(ref.workspace)
    assertArtifactPath(ref.path)
    if (!Number.isSafeInteger(ref.version) || ref.version! < 1) throw new Error(`快照必须指定产物版本：${ref.path}`)
    let records = artifacts.get(ref.workspace)
    if (!records) { records = await stores.workspaces.listArtifacts(ref.workspace); artifacts.set(ref.workspace, records) }
    const version = records.find((item) => item.path === ref.path)?.versions.find((item) => item.version === ref.version)
    if (!version) throw new Error(`快照产物版本不存在：${ref.workspace}/${ref.path}@${ref.version}`)
    if (expected !== undefined && expected !== version.sha256) throw new Error(`快照 hash 校验失败：${ref.path}`)
    const bytes = await getObject(stores, version.sha256)
    if (bytes.length !== version.size) throw new Error(`快照对象大小与版本不一致：${ref.path}`)
    const existing = files.get(ref.path)
    if (existing && !existing.equals(bytes)) throw new Error(`快照路径版本冲突：${ref.path}`)
    files.set(ref.path, bytes)
  }
  return materializeReadonlyFiles(dir, files)
}

export const verifySnapshot = verifyReadonlyFiles
