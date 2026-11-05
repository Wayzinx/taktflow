import { copyFile, mkdir, stat } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import { constants } from 'node:fs'
import { initProject } from '@taktflow/core'
import { atomicWrite } from '@taktflow/server'
import { UsageError } from '../args.js'
import { createPrinter } from '../output.js'
import { templatesDir } from '../project.js'

/** 复制 templates 下的角色与流水线；已存在不覆盖。 */
export async function runInit(project: string | undefined, options: { name?: string; json: boolean; layout?: string }, dir?: string): Promise<string> {
  const target = resolve(project ?? process.cwd(), dir ?? '.')
  if (options.layout !== undefined && options.layout !== 'space' && options.layout !== 'legacy') throw new UsageError('--layout 必须是 space 或 legacy')
  const stores = await initProject(target, { name: options.name, layout: options.layout })
  const agentSource = join(templatesDir, 'agents')
  const workflowSource = join(templatesDir, 'workflows')
  const agentTarget = stores.paths.agents
  const workflowTarget = stores.paths.workflows
  await mkdir(agentTarget, { recursive: true })
  await mkdir(workflowTarget, { recursive: true })
  const { readdir } = await import('node:fs/promises')
  const agents: string[] = []
  for (const entry of await readdir(agentSource)) {
    if (!entry.endsWith('.md')) continue
    const copied = await copyIfAbsent(join(agentSource, entry), join(agentTarget, entry))
    if (copied) agents.push(entry)
  }
  const workflows: string[] = []
  for (const entry of await readdir(workflowSource)) {
    if (entry.endsWith('.ts') && await copyIfAbsent(join(workflowSource, entry), join(workflowTarget, entry))) workflows.push(entry)
  }
  const registered = ['sdlc.workflow.ts', 'taktflow-standard.workflow.ts'].map((name) => relative(stores.projectDir, join(workflowTarget, name)))
  if (registered.some((entry) => !stores.config.workflows.includes(entry))) {
    stores.config.workflows = [...new Set([...stores.config.workflows, ...registered])]
    await atomicWrite(join(stores.projectDir, 'takt.config.json'), JSON.stringify(stores.config, null, 2) + '\n')
  }
  const workflowCopied = workflows.includes('sdlc.workflow.ts')
  const compose = (await Promise.all(['docker-compose.yml', 'compose.yaml'].map(async (name) => {
    try { return (await stat(join(target, name))).isFile() ? name : undefined }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }))).find(Boolean)
  const environmentSuggestion = compose ? {
    deploy: 'docker compose up -d --build', teardown: 'docker compose down',
  } : undefined
  const printer = createPrinter(options.json)
  if (options.json) {
    printer.data({
      projectDir: stores.projectDir,
      name: stores.config.project.name,
      agents,
      workflow: workflowCopied ? 'sdlc.workflow.ts' : undefined, workflows,
      environmentSuggestion,
    })
  } else {
    const colors = printer.colors
    printer.text(`${colors.green('✔')} 已初始化项目 ${colors.bold(storeName(stores.config.project.name))}：${stores.projectDir}`)
    printer.text(`  角色：${agents.length ? agents.join(', ') : '（已存在，跳过）'}`)
    printer.text(`  流水线：${workflows.length ? workflows.join(', ') : '（已存在，跳过）'}`)
    printer.text('  运行默认流水线前，请确保项目使用 ESM（package.json 的 type 为 module）且可解析 @taktflow/core。')
    if (environmentSuggestion) printer.text(`  检测到 ${compose}；可在 takt.config.json 中配置 environment（尚未启用）：${JSON.stringify(environmentSuggestion)}`)
  }
  return stores.projectDir
}

const storeName = (value: string) => basename(value === '' ? '.' : value)

async function copyIfAbsent(from: string, to: string): Promise<boolean> {
  try {
    await copyFile(from, to, constants.COPYFILE_EXCL)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}
