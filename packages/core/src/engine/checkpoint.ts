import { join } from 'node:path'
import type { ArtifactRef } from '../types.js'
import type { CheckpointRef } from '../quality.js'
import type { CapturedAsset } from './capture-types.js'
import type { HarnessHost } from './harness.js'
import { assetRef } from './capture-assets.js'
import { materializeSnapshot } from '../store/materialize-snapshot.js'

export async function scheduleCheckpoint(host: Pick<HarnessHost, 'deps' | 'state' | 'emit' | 'guard' | 'capture'>, nodeId: string, materials: Array<{ ref: ArtifactRef; role: 'target' | 'reference' }>, duty: CapturedAsset,
  identity: { round?: number; reviewer?: string; checkId?: string }): Promise<CheckpointRef> {
  const ns = host.state.nodes[nodeId]!
  const frozen: CheckpointRef['materials'] = []
  for (const { ref, role } of materials) {
    const records = await host.deps.stores.workspaces.listArtifacts(ref.workspace)
    const version = records.find((record) => record.path === ref.path)?.versions.find((version) => version.version === ref.version)
    if (!version) throw new Error(`检查点材料版本缺失：${ref.path} v${ref.version}`)
    frozen.push({ ref, sha256: version.sha256, role })
  }
  const checkpoint: CheckpointRef = { checkpointId: `${host.state.runId}:${nodeId}:${ns.attempts}:${identity.round ?? 0}:${identity.reviewer ?? identity.checkId}`,
    runId: host.state.runId, nodeId, attempt: ns.attempts, ...identity, materials: frozen, duty: assetRef(duty), status: 'scheduled' }
  await host.emit('checkpoint.scheduled', checkpoint, nodeId)
  return checkpoint
}

export async function materializeCheckpoint(host: Pick<HarnessHost, 'deps' | 'state' | 'emit' | 'guard' | 'capture'>, checkpoint: CheckpointRef): Promise<string> {
  const dir = join(host.deps.stores.taktDir, 'quality', 'snapshots', encodeURIComponent(checkpoint.checkpointId))
  const manifest = await host.guard.system(['.takt/quality/snapshots/**'], () =>
    (host.capture?.materializeSnapshot ?? materializeSnapshot)(host.deps.stores, checkpoint.materials, dir))
  for (const material of checkpoint.materials) {
    const hash = manifest[material.ref.path] ?? manifest[join(dir, material.ref.path)]
    if (hash !== material.sha256) throw new Error(`物化清单 hash 不一致：${material.ref.path}`)
  }
  return dir
}
