import { defineWorkflow, human, script } from '@taktflow/core'
import { runTeamWorker } from '@taktflow/server'

export default defineWorkflow({
  id: 'team-delivery',
  title: '团队 Worker 交付',
  version: '1',
  description: '把需求交给空间的远端 Worker，收到结果后由人复核实际改动。',
  tiers: [],
  stages: [
    { id: 'implement', title: '远端实现' },
    { id: 'review', title: '人工复核' },
  ],
  nodes: [
    script({
      id: 'implement', title: '派发到团队 Worker', stage: 'implement',
      inputs: [{ path: 'inputs/prd.md', kind: 'input' }],
      run: async ctx => {
        const prd = await ctx.readArtifact('inputs/prd.md')
        if (!prd?.trim()) return { status: 'blocked', message: '请先填写 inputs/prd.md' }
        const nodeId = ctx.args.teamNodeId
        if (nodeId !== undefined && (typeof nodeId !== 'string' || !nodeId.trim())) {
          return { status: 'blocked', message: 'teamNodeId 必须是非空字符串' }
        }
        return runTeamWorker(ctx, {
          harness: 'codex',
          nodeId,
          prompt: `在已配置的 Worker 工作目录中实现需求 ${ctx.requirementId}。运行相关测试并报告改动文件、测试结果和未解决风险。不要提交或推送。\n\n${prd}`,
        })
      },
    }),
    human({
      id: 'review', title: '核查远端实际改动', stage: 'review', needs: ['implement'], form: 'approve',
      ask: '查看上游节点日志里的 jobId、Worker nodeId 和结果；到指定 Worker 或经人工交接的代码库检查实际 diff、测试和风险。文件未同步；核验后再批准。',
    }),
  ],
})
