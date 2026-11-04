import type { GraphNode, StageDef, StageProgress, StageStatus } from '@taktflow/core'

/**
 * 从运行图推导阶段进度（运行页用；需求摘要里的 stages 由 server 计算）。
 * 判定规则必须和 core 的 stageProgress（insights/graph.ts）逐条一致：web 只能 import type，没法直接调用它。
 * 等 RunDetail 带上 server 算好的 stages 后删掉这里（见交付说明里的协议变更请求）。
 */
export function computeStages(stages: StageDef[], nodes: GraphNode[]): StageProgress[] {
  return stages.map((s) => {
    const ns = nodes.filter((n) => n.stage === s.id)
    const done = ns.filter((n) => n.status === 'succeeded' || n.status === 'skipped').length
    const has = (...st: GraphNode['status'][]) => ns.some((n) => st.includes(n.status))
    let status: StageStatus = 'todo'
    if (has('failed', 'blocked', 'cancelled')) status = 'failed'
    else if (has('waiting_human')) status = 'waiting_human'
    else if (ns.length > 0 && done === ns.length) status = 'done'
    else if (done > 0 || has('running', 'ready', 'stale')) status = 'running'
    return { ...s, status, done, total: ns.length }
  })
}
