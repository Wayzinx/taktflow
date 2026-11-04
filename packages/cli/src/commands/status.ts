import type { Requirement, ProjectStores, RunState, StageProgress } from '@taktflow/core'
import { createInsights, stageProgress } from '@taktflow/core'
import { createPrinter } from '../output.js'
import { openStores } from '../project.js'

const STATUS_ICON: Record<StageProgress['status'], string> = {
  done: '✔',
  running: '●',
  waiting_human: '◐',
  failed: '✘',
  todo: '○',
}

export async function runStatus(project: string | undefined, req: string | undefined, json: boolean): Promise<void> {
  const stores = await openStores(project)
  const printer = createPrinter(json)
  const requirements = await stores.workspaces.listRequirements()
  const selected = req === undefined ? requirements : requirements.filter((item) => item.id === req)
  if (req !== undefined && selected.length === 0) throw new Error(`需求不存在：${req}`)
  const attention = await stores.attention.list({ pending: true })
  const runs = await stores.runs.list(req === undefined ? undefined : { requirementId: req })
  const stages = await Promise.all(selected.map(async (requirement) => {
    const latest = runs.filter((run) => run.requirementId === requirement.id).at(-1)
    return latest === undefined ? [] : await stageBar(stores, latest)
  }))
  if (json) {
    printer.data(selected.map((requirement, index) => ({
      requirement,
      stages: stages[index] ?? [],
      runs: runs.filter((run) => run.requirementId === requirement.id),
      attention: attention.filter((item) => item.requirementId === requirement.id),
    })))
    return
  }
  if (selected.length === 0) {
    printer.text(printer.colors.dim('还没有需求。用 takt req new "<title>" 创建。'))
    return
  }
  for (const [index, requirement] of selected.entries()) {
    const stageText = (stages[index] ?? []).map((stage) => {
      const color = stage.status === 'done' ? printer.colors.green
        : stage.status === 'failed' ? printer.colors.red
          : stage.status === 'running' || stage.status === 'waiting_human' ? printer.colors.yellow
            : printer.colors.dim
      return `${color(stage.title)} ${color(STATUS_ICON[stage.status])}`
    }).join(printer.colors.dim(' → '))
    printer.text(`${printer.colors.cyan(requirement.id)}  ${requirement.title}  ${printer.colors.dim(requirement.status)}`)
    if (stageText !== '') printer.text(`  ${stageText}`)
    const own = runs.filter((run) => run.requirementId === requirement.id)
    const latest = own.at(-1)
    if (latest) printer.text(`  最近运行：${latest.runId}  ${latest.status}  ${printer.colors.dim(latest.startedAt)}`)
    for (const item of attention.filter((item) => item.requirementId === requirement.id)) {
      printer.text(`  ${printer.colors.yellow('待办')} ${printer.colors.cyan(item.requestId)} ${item.ask}`)
    }
  }
}

async function stageBar(stores: ProjectStores, run: RunState): Promise<StageProgress[]> {
  const snapshot = await stores.runs.getWorkflow(run.runId)
  if (snapshot) return stageProgress(snapshot, run)
  return []
}

export async function runTrace(project: string | undefined, req: string, json: boolean): Promise<void> {
  const stores = await openStores(project)
  const requirement: Requirement | undefined = await stores.workspaces.getRequirement(req)
  if (!requirement) throw new Error(`需求不存在：${req}`)
  const insights = createInsights(stores)
  const graph = await insights.traceGraph(req)
  const printer = createPrinter(json)
  const metrics = await insights.metrics(req)
  if (json) {
    printer.data({ ...graph, acCoverage: metrics.acCoverage ?? [] })
    return
  }
  printer.text(printer.colors.bold(`追溯：${req} ${requirement.title}`))
  if (metrics.acCoverage !== undefined) {
    printer.text('AC 覆盖：')
    for (const item of metrics.acCoverage) {
      const icon = item.status === 'covered' ? printer.colors.green('✔') : item.status === 'partial' ? printer.colors.yellow('◐') : printer.colors.red('✘')
      printer.text(`  ${icon} ${item.ac}  ${item.title}  用例 ${item.cases} 通过 ${item.passed} 失败 ${item.failed}`)
    }
  }
  printer.text('追溯边：')
  for (const edge of graph.edges) {
    const label = edge.rel === 'covers' ? '覆盖' : edge.rel === 'verifies' ? '验证' : edge.rel === 'derives' ? '派生' : edge.rel === 'produced' ? '产出' : edge.rel === 'judged' ? '判决' : '实现'
    printer.text(`  ${printer.colors.cyan(edge.from)} -${label}→ ${edge.to}`)
  }
}
