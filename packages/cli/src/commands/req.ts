import { latestRun, requirementState } from '../requirement-state.js'
import { createPrinter } from '../output.js'
import { openStores } from '../project.js'

export async function runReqNew(project: string | undefined, title: string, options: { link?: string; json: boolean }): Promise<void> {
  const stores = await openStores(project)
  const links = options.link === undefined ? [] : [{ type: linkType(options.link), url: options.link }]
  const requirement = await stores.workspaces.createRequirement({ title, links })
  const printer = createPrinter(options.json)
  if (options.json) printer.data(requirement)
  else printer.text(`${printer.colors.green('✔')} 已创建 ${printer.colors.bold(requirement.id)}  ${requirement.title}`)
}

export async function runReqList(project: string | undefined, json: boolean): Promise<void> {
  const stores = await openStores(project)
  const runs = await stores.runs.list()
  const requirements = await Promise.all((await stores.workspaces.listRequirements()).map((item) => requirementState(stores, item, latestRun(runs, item.id))))
  const printer = createPrinter(json)
  if (json) {
    printer.data(requirements)
    return
  }
  if (requirements.length === 0) {
    printer.text(printer.colors.dim('还没有需求。用 takt req new "<title>" 创建。'))
    return
  }
  for (const requirement of requirements) {
    const stage = requirement.stage === undefined ? '' : printer.colors.dim(` [${requirement.stage}]`)
    printer.text(`${printer.colors.cyan(requirement.id)}  ${requirement.status.padEnd(9)} ${requirement.title}${stage}`)
  }
}

function linkType(url: string): string {
  if (/github\.com/i.test(url)) return 'github'
  if (/meego|jira/i.test(url)) return 'meego'
  if (/feishu|larksuite/i.test(url)) return 'feishu'
  return 'url'
}
