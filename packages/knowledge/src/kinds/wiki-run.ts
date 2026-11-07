import { join } from 'node:path'
import { mkdir, copyFile } from 'node:fs/promises'
import {
  createEngine,
  knowledgeWikiWorkflow,
  listFiles,
  loadProfiles,
  writeFileAtomic,
  type EngineDeps,
  type KnowledgeBase,
  type KnowledgeKindContext,
  type HarnessAdapter,
  type SandboxProvider,
} from '@taktflow/core'
import { safePath, repositoryPath } from '../store/files.js'
export type WikiRuntime = (
  ctx: KnowledgeKindContext,
) => Promise<Pick<EngineDeps, 'harnesses' | 'profiles' | 'sandbox' | 'repos'>>
export async function generateWiki(
  kb: KnowledgeBase,
  ctx: KnowledgeKindContext,
  runtime?: WikiRuntime,
): Promise<string> {
  const generate = kb.config.generate as { repo: string; include?: string[]; granularity?: string }
  const repo = ctx.stores.config.repos?.find((record) => record.id === generate.repo)
  if (!repo) throw new Error('生成 Wiki 的仓库未绑定，请先绑定仓库')
  const repoPath = await repositoryPath(ctx.stores, repo.id)
  const loaded: Awaited<ReturnType<WikiRuntime>> = runtime
    ? await runtime(ctx)
    : await (async () => {
        const name = '@taktflow/harness'
        const module = (await import(name)) as {
          createHarnesses(opts: unknown): Record<string, HarnessAdapter>
        }
        return {
          profiles: await loadProfiles(ctx.stores.paths),
          harnesses: module.createHarnesses({
            config: ctx.stores.config,
            projectDir: ctx.stores.projectDir,
          }),
        }
      })()
  if (!loaded.profiles['wiki-writer'] || !loaded.profiles.reviewer)
    throw new Error('缺少 wiki-writer 或 reviewer 角色，请先安装 Wiki 模板角色')
  const requirement = await ctx.stores.workspaces.createRequirement({
    title: `知识库 ${kb.name} Wiki 生成提案`,
  })
  const runStores = {
    ...ctx.stores,
    runs: new Proxy(ctx.stores.runs, {
      get(target, property, receiver) {
        if (property === 'create')
          return async (...args: Parameters<typeof target.create>) => {
            await target.create(...args)
            await writeFileAtomic(
              join(ctx.indexDir, 'run.json'),
              JSON.stringify({ runId: args[0].runId }),
            )
          }
        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }),
  }
  const sandboxModule = '@taktflow/sandbox'
  const adapters = (await import(sandboxModule)) as {
    selectSandboxProvider(config: typeof ctx.stores.config.sandbox): Promise<SandboxProvider>
  }
  const provider =
    loaded.sandbox ?? (await adapters.selectSandboxProvider(ctx.stores.config.sandbox))
  const sandbox: SandboxProvider = {
    id: provider.id,
    available: () => provider.available(),
    create: (spec) =>
      provider.create({
        ...spec,
        mounts: [...spec.mounts, { source: repoPath, target: repoPath, mode: 'ro' }],
      }),
  }
  const engine = createEngine({ ...loaded, sandbox, stores: runStores, knowledge: [] })
  const onAbort = () => {
    void ctx.stores.runs
      .list({ requirementId: requirement.id })
      .then((runs) =>
        Promise.all(
          runs
            .filter((record2) => record2.status === 'running')
            .map((record3) => engine.cancel(record3.runId)),
        ),
      )
  }
  ctx.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const running = engine.start({
      requirementId: requirement.id,
      workflow: knowledgeWikiWorkflow(),
      kind: 'task',
      args: { ...generate, repoPath },
    })
    const state = await running
    await writeFileAtomic(join(ctx.indexDir, 'run.json'), JSON.stringify({ runId: state.runId }))
    if (state.status !== 'succeeded')
      throw new Error(`Wiki 生成运行 ${state.runId} 未通过评审，请查看运行日志`)
    const source = join(ctx.stores.workspaces.dir(requirement.id), 'generated')
    const target = join(ctx.indexDir, 'generated')
    await mkdir(target, { recursive: true })
    for (const file of await listFiles(source, ['**/*.md'])) {
      const dest = await safePath(target, file)
      await mkdir(join(dest, '..'), { recursive: true })
      await copyFile(await safePath(source, file), dest)
    }
    return target
  } finally {
    ctx.signal?.removeEventListener('abort', onAbort)
  }
}
