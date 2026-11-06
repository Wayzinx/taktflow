import { agent, defineWorkflow, gate, review } from '@taktflow/core'
import { runQuickTests } from './quick-fix.hooks.js'

export default defineWorkflow({
  id: 'quick-fix', title: '轻量改动交付', version: '1.0.0', tiers: ['T0', 'T1'],
  useWhen: '给定明确改动的 T0，或仅涉及一个模块、目录或仓库的 T1；保留独立代码评审和交付证据校验。',
  leadInstructions: '安全默认直接推进；只询问一个最重要的问题。先给结论，通过必须有证据。',
  stages: [{ id: 'change', title: '实现' }, { id: 'verify', title: '交付校验' }],
  nodes: [
    agent({ id: 'spec', title: '简短需求说明', stage: 'change', role: 'pm', owner: 'pm', goal: '明确改动与验收标准',
      when: (ctx) => ctx.args.tier !== 'T0', inputs: [{ path: 'inputs/**' }], outputs: [{ path: 'spec/quick.md', kind: 'spec' }, { path: 'cases/*.json', kind: 'case' }],
      prompt: '写简短 spec/quick.md：范围、约束与可验证 AC-<n>；依据需求将验收用例写入 cases/<id>.json，每条包含 id、covers、输入、预期，适配项目现有测试入口。T0 使用已给定的 spec 与用例，不临时推测验收标准。' }),
    agent({ id: 'implement', title: '实现改动', stage: 'change', needs: ['spec'], role: 'dev', repo: 'app', owner: 'rd',
      goal: '实现改动并留下自测证据', completion: ['改动符合验收标准且自测结果有证据'], retry: { max: 3 },
      inputs: [{ path: 'inputs/**' }, { path: 'spec/**' }, { path: 'cases/**' }], outputs: [{ path: 'tasks/change.md', kind: 'task' }],
      prompt: '实现需求，记录改动与自测证据到 tasks/change.md；不修改测试断言。' }),
    review({ id: 'review-code', title: '独立代码评审', stage: 'verify', needs: ['implement'], owner: 'rd', when: (ctx) => ctx.args.tier !== 'T0',
      target: { code: { repo: 'app' } }, author: { role: 'dev' }, reviewers: [{ role: 'reviewer' }], maxRounds: 2, onExhausted: 'human' }),
    gate({ id: 'delivery-check', title: '交付校验', stage: 'verify', needs: ['review-code'], owner: 'qa',
      inputs: [{ path: 'spec/**' }, { path: 'cases/**' }], outputs: [{ path: 'evidence/**', kind: 'evidence' }],
      checks: [{ id: 'tests', kind: 'function', fn: runQuickTests }, { id: 'acceptance', kind: 'acceptance', role: 'verifier' }] }),
  ],
})
