// 此模块只供测试生成临时源码，不从公共入口导出。
export const coreUrl = new URL('../../core/dist/index.js', import.meta.url).href
export const workflowFixture = `import { defineWorkflow, agent, script, loop } from ${JSON.stringify(coreUrl)}
export default defineWorkflow({
  id: 'demo',
  title: 'Demo',
  version: '1',
  stages: [],
  nodes: [
    agent({
      id: 'a',
      title: 'A',
      role: 'pm',
      prompt: 'first',
    }),

    agent({
      id: 'b',
      title: 'B',
      role: 'dev',
      prompt: 'second',
    }),
  ],
})
`
