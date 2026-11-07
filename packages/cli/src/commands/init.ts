import { basename, resolve } from 'node:path'
import { initSpace } from '@taktflow/server'
import { UsageError } from '../args.js'
import { createPrinter } from '../output.js'

/** 复制 templates 下的角色与流水线；已存在不覆盖。 */
export async function runInit(project: string | undefined, options: { name?: string; json: boolean; layout?: string }, dir?: string): Promise<string> {
  const target = resolve(project ?? process.cwd(), dir ?? '.')
  if (options.layout !== undefined && options.layout !== 'space' && options.layout !== 'legacy') throw new UsageError('--layout 必须是 space 或 legacy')
  const before = await import('node:fs/promises').then(async ({ readdir }) => {
    const { openProject } = await import('@taktflow/core')
    try { const stores = await openProject(target); return { agents: await readdir(stores.paths.agents), workflows: await readdir(stores.paths.workflows) } }
    catch { return { agents: [] as string[], workflows: [] as string[] } }
  })
  const stores = await initSpace(target, 'standard', { name: options.name, layout: options.layout, includeLegacyWorkflow: true })
  const { readdir } = await import('node:fs/promises')
  const agents = (await readdir(stores.paths.agents)).filter((name) => name.endsWith('.md') && !before.agents.includes(name))
  const workflows = (await readdir(stores.paths.workflows)).filter((name) => name.endsWith('.workflow.ts') && !before.workflows.includes(name))
  const workflowCopied = workflows.includes('sdlc.workflow.ts')
  const printer = createPrinter(options.json)
  if (options.json) {
    printer.data({
      projectDir: stores.projectDir,
      name: stores.config.project.name,
      agents,
      workflow: workflowCopied ? 'sdlc.workflow.ts' : undefined, workflows,
    })
  } else {
    const colors = printer.colors
    printer.text(`${colors.green('✔')} 已初始化项目 ${colors.bold(storeName(stores.config.project.name))}：${stores.projectDir}`)
    printer.text(`  角色：${agents.length ? agents.join(', ') : '（已存在，跳过）'}`)
    printer.text(`  流水线：${workflows.length ? workflows.join(', ') : '（已存在，跳过）'}`)
    printer.text('  运行默认流水线前，请确保项目使用 ESM（package.json 的 type 为 module）且可解析 @taktflow/core。')
  }
  return stores.projectDir
}

const storeName = (value: string) => basename(value === '' ? '.' : value)
