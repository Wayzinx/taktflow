import type { ProjectStores } from '../interfaces.js'
import { assertArtifactPath } from '../store/paths.js'
import { readJsonFile } from '../store/fs-utils.js'
import { proposalDiff } from '../steward/diff.js'
import { changesFile, nodeChanges, type ChangeCapture } from './changes.js'

export async function nodeDiff(stores: ProjectStores, runId: string, nodeId: string, path?: string): Promise<{ patch: string }> {
  if (path !== undefined) assertArtifactPath(path)
  const changes = await nodeChanges(stores, runId, nodeId)
  const state = (await stores.runs.get(runId))!
  const capture = await readJsonFile<ChangeCapture>(changesFile(stores, runId, nodeId))
  const files = changes.files.filter(file => path === undefined || file.path === path)
  if (path !== undefined && !files.length) throw new Error('该路径不在节点改动中，请从改动卡选择文件')
  const patches: string[] = []
  for (const file of files) {
    if (file.scope === 'repo') {
      const frozen = capture?.attempt === state.nodes[nodeId]!.attempts
        ? capture.end?.patches?.find(patch => patch.repo === file.repo && patch.path === file.path) : undefined
      if (!frozen) throw new Error('该节点尚无冻结的仓库 diff，请等待执行结束或重新运行节点')
      patches.push(frozen.patch)
    } else {
      const read = async (version?: number) => {
        if (version === undefined) return ''
        const content = await stores.workspaces.readArtifact({ workspace: state.requirementId, path: file.path, version })
        if (!content) throw new Error(`产物历史版本不可读：${file.path}@${version}，请修复存储后重试`)
        return content.toString('utf8')
      }
      patches.push(await proposalDiff(file.path, await read(file.from), await read(file.to)))
    }
  }
  return { patch: patches.join('') }
}
