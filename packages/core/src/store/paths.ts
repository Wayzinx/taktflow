import path from 'node:path'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function assertSafeId(kind: string, id: string): string {
  if (!SAFE_ID.test(id)) throw new Error(`非法${kind} ID：${id}`)
  return id
}

export function assertRequirementId(id: string): string {
  return assertSafeId('需求', id)
}

export function assertRunId(runId: string): string {
  return assertSafeId('运行', runId)
}

/** 节点 ID 允许 `/`（planner 展开），但不允许空段、`.`、`..` 和反斜杠。 */
export function assertNodeId(nodeId: string): string {
  if (nodeId === '' || nodeId.startsWith('/') || nodeId.includes('\\') || nodeId.includes('\0')) throw new Error(`非法节点 ID：${nodeId}`)
  for (const seg of nodeId.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') throw new Error(`非法节点 ID：${nodeId}`)
  }
  return nodeId
}

/** 产物路径是相对存放区目录的 POSIX 路径，禁止绝对路径、`..` 和空段。 */
export function assertArtifactPath(artifactPath: string): string {
  if (artifactPath === '' || artifactPath.startsWith('/') || artifactPath.includes('\\') || artifactPath.includes('\0')) {
    throw new Error(`非法产物路径：${artifactPath}`)
  }
  for (const seg of artifactPath.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') throw new Error(`非法产物路径：${artifactPath}`)
  }
  if (['requirement.json', 'manifest.json', 'comments.jsonl'].includes(artifactPath.split('/')[0]!.toLowerCase())) {
    throw new Error(`产物路径与元数据文件冲突：${artifactPath}`)
  }
  return artifactPath
}

export const workspacesDir = (taktDir: string): string => path.join(taktDir, 'workspaces')

export const workspaceDir = (taktDir: string, id: string): string =>
  path.resolve(workspacesDir(taktDir), assertRequirementId(id))

export const objectsDir = (taktDir: string): string => path.join(taktDir, 'objects')

export const runsDir = (taktDir: string): string => path.join(taktDir, 'runs')

export const runDir = (taktDir: string, runId: string): string => path.join(runsDir(taktDir), assertRunId(runId))

export const eventsFile = (taktDir: string, runId: string): string => path.join(runDir(taktDir, runId), 'events.jsonl')

export const contextFile = (taktDir: string, runId: string, nodeId: string): string =>
  path.join(runDir(taktDir, runId), 'context', `${assertNodeId(nodeId).replaceAll('/', '__')}.json`)

export const attentionFile = (taktDir: string): string => path.join(taktDir, 'attention.jsonl')

export const requirementFile = (taktDir: string, id: string): string =>
  path.join(workspaceDir(taktDir, id), 'requirement.json')

export const manifestFile = (taktDir: string, id: string): string => path.join(workspaceDir(taktDir, id), 'manifest.json')

export const commentsFile = (taktDir: string, id: string): string => path.join(workspaceDir(taktDir, id), 'comments.jsonl')
