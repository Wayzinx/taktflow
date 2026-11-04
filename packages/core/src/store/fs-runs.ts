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
import { withLock } from './locks.js'
import { contextFile, runDir, runsDir } from './paths.js'

type ContextFile = Awaited<ReturnType<RunStore['getContext']>>

export class FsRunStore implements RunStore {
  constructor(private readonly taktDir: string) {}

  async create(state: RunState, workflow: WorkflowSnapshot): Promise<void> {
    const dir = runDir(this.taktDir, state.runId)
    await withLock(dir, async () => {
      if (await fileExists(path.join(dir, 'state.json'))) throw new Error(`运行已存在：${state.runId}`)
      await writeFileAtomic(path.join(dir, 'workflow.json'), toJsonText(workflow))
      await writeFileAtomic(path.join(dir, 'state.json'), toJsonText(state))
    })
  }

  async getWorkflow(runId: RunId): Promise<WorkflowSnapshot | undefined> {
    return readJsonFile<WorkflowSnapshot>(path.join(runDir(this.taktDir, runId), 'workflow.json'))
  }

  async save(state: RunState): Promise<void> {
    const dir = runDir(this.taktDir, state.runId)
    const file = path.join(dir, 'state.json')
    await withLock(dir, async () => {
      await writeFileAtomic(file, toJsonText(state))
    })
  }

  async get(runId: RunId): Promise<RunState | undefined> {
    return readJsonFile<RunState>(path.join(runDir(this.taktDir, runId), 'state.json'))
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
      const state = await readJsonFile<RunState>(path.join(root, entry.name, 'state.json'))
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
    await withLock(file, async () => {
      const current = await this.readContext(runId, nodeId)
      mutate(current)
      await writeFileAtomic(file, toJsonText(current))
    })
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
