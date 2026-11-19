import { UsageError, type ParsedCli } from './args.js'
import { readLinkCode } from './link-code.js'
import { linkStore } from './link-store.js'
import { postTeamJson, record, RemoteError, teamEndpoint, validToken } from './team-transport.js'
import { workerDirectories } from './worker-harness.js'
import { reportWorker, runTeamWorker, withWorkerSignals } from './worker.js'

export function runLinkCommand({ options, positionals }: ParsedCli): Promise<number> {
  const { hub, space, node, project, relink } = options
  if (positionals.length || !hub || !space || node?.length !== 1 || !node[0] || !project) {
    throw new UsageError('用法：takt link --hub URL --space ID --node ID --project DIR [--relink]（配对码从 stdin 读入）')
  }
  const destination = { hub, space, node: node[0] }
  const endpoint = teamEndpoint(destination)
  return withWorkerSignals(async (stop) => {
    const { signal } = stop
    const { cwd, home } = await workerDirectories(project).catch((error: NodeJS.ErrnoException) => {
      if (error.code) throw new UsageError('无法访问 --project 或 Worker 配置目录')
      throw error
    })
    const store = await linkStore(home, cwd, endpoint)
    let token = await store.load()
    if (token === undefined || relink) {
      const code = await readLinkCode(stop)
      const reply = await postTeamJson(endpoint, 'link', { code, harness: 'codex' }, { signal })
      if (!record(reply) || typeof reply.token !== 'string' || !validToken(reply.token)) throw new Error('Team Hub 返回的链接凭据无效')
      token = reply.token
      await store.save(token)
    }
    if (signal.aborted) return
    try {
      await runTeamWorker({ ...destination, harness: 'codex', project: cwd, token }, signal, reportWorker)
    } catch (error) {
      if (error instanceof RemoteError && (error.status === 401 || error.status === 403)) {
        throw new Error(`${error.message}；请用新的配对码与 --relink 替换凭据`)
      }
      throw error
    }
  })
}
