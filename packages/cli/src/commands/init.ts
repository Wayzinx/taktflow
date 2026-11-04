import { copyFile, mkdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { constants } from 'node:fs'
import { initProject } from '@taktflow/core'
import { createPrinter } from '../output.js'
import { templatesDir } from '../project.js'

/** 复制 templates 下的角色与流水线；已存在不覆盖。 */
export async function runInit(project: string | undefined, options: { name?: string; json: boolean }, dir?: string): Promise<string> {
  const target = resolve(project ?? process.cwd(), dir ?? '.')
  const stores = await initProject(target, options.name === undefined ? undefined : { name: options.name })
  const agentSource = join(templatesDir, 'agents')
  const workflowSource = join(templatesDir, 'workflows', 'sdlc.workflow.ts')
  const agentTarget = join(stores.taktDir, 'agents')
  const workflowTarget = join(stores.taktDir, 'workflows')
  await mkdir(agentTarget, { recursive: true })
  await mkdir(workflowTarget, { recursive: true })
  const { readdir } = await import('node:fs/promises')
  const agents: string[] = []
  for (const entry of await readdir(agentSource)) {
    if (!entry.endsWith('.md')) continue
    const copied = await copyIfAbsent(join(agentSource, entry), join(agentTarget, entry))
    if (copied) agents.push(entry)
  }
  const workflowCopied = await copyIfAbsent(workflowSource, join(workflowTarget, 'sdlc.workflow.ts'))
  const printer = createPrinter(options.json)
  if (options.json) {
    printer.data({
      projectDir: stores.projectDir,
      name: stores.config.project.name,
      agents,
      workflow: workflowCopied ? 'sdlc.workflow.ts' : undefined,
    })
  } else {
    const colors = printer.colors
    printer.text(`${colors.green('✔')} 已初始化项目 ${colors.bold(storeName(stores.config.project.name))}：${stores.projectDir}`)
    printer.text(`  角色：${agents.length ? agents.join(', ') : '（已存在，跳过）'}`)
    printer.text(`  流水线：${workflowCopied ? 'sdlc.workflow.ts' : '（已存在，跳过）'}`)
    printer.text('  运行默认流水线前，请确保项目使用 ESM（package.json 的 type 为 module）且可解析 @taktflow/core。')
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
