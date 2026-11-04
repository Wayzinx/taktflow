import { readdir } from 'node:fs/promises'
import path from 'node:path'
import type { RunStore } from '../interfaces.js'
import type {
  CompactionRecord,
  ContextSnapshot,
  NodeId,
  RequirementId,
  RunId,
  RunState,
  WorkflowSnapshot,
} from '../types.js'
import { fileExists, isEnoent, readJsonFile, toJsonText, writeFileAtomic } from './fs-utils.js'
import { withFileLock } from './file-lock.js'
import { mergeState } from './merge-state.js'
import { applyInvalidations, readInvalidations } from './run-invalidations.js'
import { contextFile, runDir, runsDir } from './paths.js'

type ContextFile = Awaited<ReturnType<RunStore['getContext']>>

export class FsRunStore implements RunStore {
  private readonly observed = new WeakMap<RunState, RunState>()
  private readonly submitted = new Map<string, RunState>()
  constructor(private readonly taktDir: string) {}

  async create(state: RunState, workflow: WorkflowSnapshot): Promise<void> {
    const dir = runDir(this.taktDir, state.runId)
    await withFileLock(path.join(dir, 'state.json'), async () => {
      if (await fileExists(path.join(dir, 'state.json'))) throw new Error(`运行已存在：${state.runId}`)
      await writeFileAtomic(path.join(dir, 'workflow.json'), toJsonText(workflow))
      await writeFileAtomic(path.join(dir, 'state.json'), toJsonText(state))
      this.submitted.set(state.runId, structuredClone(state))
    })
  }

  async getWorkflow(runId: RunId): Promise<WorkflowSnapshot | undefined> {
    return readJsonFile<WorkflowSnapshot>(path.join(runDir(this.taktDir, runId), 'workflow.json'))
  }

  async save(state: RunState): Promise<void> {
    const dir = runDir(this.taktDir, state.runId)
    const file = path.join(dir, 'state.json')
    const incoming = structuredClone(state)
    const observed = this.observed.get(state)
    await withFileLock(path.join(dir, 'state.json'), async () => {
      const current = await readJsonFile<RunState>(file)
      const invalidations = await readInvalidations(dir)
      const baseline = structuredClone(observed ?? this.submitted.get(state.runId) ?? current)
      const proposed = structuredClone(incoming)
      if (baseline) applyInvalidations(baseline, invalidations)
      applyInvalidations(proposed, invalidations)
      const merged = current ? mergeState(baseline, proposed, current) : proposed
      applyInvalidations(merged, invalidations)
      await writeFileAtomic(file, toJsonText(merged))
      this.submitted.set(state.runId, incoming)
      this.observed.set(state, structuredClone(incoming))
    })
  }

  async get(runId: RunId): Promise<RunState | undefined> {
    const dir = runDir(this.taktDir, runId)
    const state = await readJsonFile<RunState>(path.join(dir, 'state.json'))
    if (state) {
      await this.reconcile(dir, state)
      this.observed.set(state, structuredClone(state))
      if (!this.submitted.has(runId)) this.submitted.set(runId, structuredClone(state))
    }
    return state
  }

  async list(filter?: { requirementId?: RequirementId }): Promise<RunState[]> {
    const root = runsDir(this.taktDir)
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch (err) {
      if (isEnoent(err)) return []
      throw err
    }
    const runs: RunState[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.')) continue
      const state = await this.get(entry.name)
      if (!state) continue
      if (filter?.requirementId !== undefined && state.requirementId !== filter.requirementId) continue
      runs.push(state)
    }
    return runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.runId.localeCompare(b.runId))
  }

  async saveContext(runId: RunId, snapshot: ContextSnapshot): Promise<void> {
    await this.updateContext(runId, snapshot.nodeId, (file) => {
      file.snapshots.push(snapshot)
    })
  }

  async saveCompaction(runId: RunId, record: CompactionRecord): Promise<void> {
    await this.updateContext(runId, record.nodeId, (file) => {
      file.compactions.push(record)
    })
  }

  async getContext(runId: RunId, nodeId: NodeId): Promise<ContextFile> {
    const data = await this.readContext(runId, nodeId)
    // 协议要求 / 编码成 __，不同节点可能共用文件；按原始 ID 隔离读取，追加时保留全部记录。
    return {
      snapshots: data.snapshots.filter((item) => item.nodeId === nodeId),
      compactions: data.compactions.filter((item) => item.nodeId === nodeId),
    }
  }

  private async updateContext(
    runId: RunId,
    nodeId: NodeId,
    mutate: (file: ContextFile) => void,
  ): Promise<void> {
    const file = contextFile(this.taktDir, runId, nodeId)
    await withFileLock(file, async () => {
      const current = await this.readContext(runId, nodeId)
      mutate(current)
      await writeFileAtomic(file, toJsonText(current))
    })
  }

  private async reconcile(dir: string, state: RunState): Promise<void> {
    applyInvalidations(state, await readInvalidations(dir))
  }

  private async readContext(runId: RunId, nodeId: NodeId): Promise<ContextFile> {
    const file = contextFile(this.taktDir, runId, nodeId)
    const data = await readJsonFile<ContextFile>(file)
    if (data === undefined) return { snapshots: [], compactions: [] }
    if (!data || !Array.isArray(data.snapshots) || !Array.isArray(data.compactions)) {
      throw new Error(`上下文文件结构不合法：${file}`)
    }
    return data
  }
}
