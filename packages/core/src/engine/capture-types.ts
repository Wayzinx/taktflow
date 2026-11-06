import type { ProjectStores } from '../interfaces.js'
import type { AssetRef, CheckpointRef, InputSnapshot, Invocation } from '../quality.js'
import type { ArtifactRef, HarnessSelector } from '../types.js'

export interface CapturedAsset extends AssetRef { content: string }
export interface WorkflowSource {
  id: string
  content: string
  dependencies?: Array<{ id: string; content: string }>
  revision?: string
}
export interface CaptureOptions {
  /** 加载入口提供；运行开始后冻结，resume 不重新读取当前源码。 */
  workflowSource?: WorkflowSource
  profiles?: Record<string, CapturedAsset>
  adapters?: Record<string, { version: string; model?: boolean; effort?: boolean; tools?: string[] }>
  putObject?: (stores: ProjectStores, content: string) => Promise<string>
  materializeSnapshot?: (stores: ProjectStores, refs: Array<{ ref: ArtifactRef; role: 'target' | 'reference' }>, dir: string) => Promise<Record<string, string>>
}
export interface ResultInput { from: { runId: string; nodeId: string; attempt: number }; value: unknown }
export interface CaptureContext {
  review?: Invocation['review']
  checkpoint?: CheckpointRef
  gateCheckId?: string
  materials?: Array<{ ref: ArtifactRef; role: 'target' | 'reference' | 'input' }>
  snapshotDir?: string
  render?: { kind: InputSnapshot['render']['template']['kind']; template: string; params: Record<string, unknown>; staticPrompt?: string; suffix?: string; duty?: CapturedAsset }
  replayNotes?: string[]
}
export interface CapturedInvocation extends Invocation {
  requested: Pick<HarnessSelector, 'harness' | 'provider' | 'model' | 'effort'>
  effective: { model: 'applied' | 'unsupported' | 'unknown'; effort: 'applied' | 'unsupported' | 'unknown' }
}
export interface CapturedInputSnapshot extends InputSnapshot {
  results: Array<{ from: ResultInput['from']; object: string }>
  workflow?: AssetRef & { object: string; closureSha256: string; redactions: number; dependencies: Array<AssetRef & { object: string }> }
  skillUse: Array<{ asset: AssetRef; declared: boolean; provided: boolean; loaded: 'unknown' | 'confirmed' }>
}
