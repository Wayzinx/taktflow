import type { TeamSnapshot } from './team'

const time = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const example: TeamSnapshot = {
  messages: [
    { id: 'team-1', role: 'human', author: 'lin', text: '空名字的问候语走一遍交付流水线，特别确认默认称呼和正常姓名都能通过。', at: time(28) },
    { id: 'team-2', role: 'steward', author: '团队 Agent', text: '已关联需求和运行。空字符串和仅包含空格的名字会使用默认称呼，正常姓名不受影响。', at: time(27), requirementId: 'REQ-001', runId: 'run-20261104-0001' },
    { id: 'team-3', role: 'human', author: 'wayne', text: '再用开发机跑一下问候语用例，确认没有漏掉空白字符。', at: time(11) },
    { id: 'team-4', role: 'steward', author: '团队 Agent', text: '已派发给开发机。任务状态和结果会显示在这条消息下。', at: time(10), jobId: 'demo-job-1' },
  ],
  nodes: [
    { id: 'dev-mac', harness: 'codex', online: true },
    { id: 'team-linux', harness: 'claude-code', online: false },
  ],
  jobs: [
    { id: 'demo-job-1', nodeId: 'dev-mac', harness: 'codex', status: 'succeeded', result: '问候语用例全部通过，包括空字符串、纯空白和正常姓名。' },
  ],
}

export function mockTeam(seeded: boolean): TeamSnapshot {
  return seeded ? example : { messages: [], nodes: [], jobs: [] }
}
