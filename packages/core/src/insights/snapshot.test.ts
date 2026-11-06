import { expect, it } from 'vitest'
import { snapshotWorkflow } from '../store/snapshot.js'
import type { WorkflowDefinition } from '../types.js'

it('快照保留 human 表单与选项、rubric 阈值，嵌套定义深拷贝并去除函数', () => {
  const definition: WorkflowDefinition = {
    id: 'snapshot', title: '快照', version: '1', stages: [], nodes: [
      { id: 'approve', kind: 'human', title: '审批', ask: '继续？', form: 'approve' },
      { id: 'answer', kind: 'human', title: '回答', ask: '原因？', form: 'answer' },
      { id: 'loop', kind: 'loop', title: '循环', maxIterations: 2, until: () => true, body: [
        { id: 'choice', kind: 'human', title: '选择', ask: '方向？', form: 'choice', choices: ['甲', '乙'] },
        { id: 'gate', kind: 'gate', title: '门禁', checks: [
          { id: 'score', kind: 'rubric', title: '评分', role: 'reviewer', rubric: '质量', threshold: 80 },
          { id: 'zero', kind: 'rubric', role: 'reviewer', rubric: '零阈值', threshold: 0 },
          { id: 'command', kind: 'command', run: 'true' },
          { id: 'function', kind: 'function', fn: async () => ({ id: 'function', pass: true }) },
        ] },
      ] },
    ],
  }
  const snapshot = snapshotWorkflow(definition)
  expect(snapshot.nodes[0]).toMatchObject({ ask: '继续？', form: 'approve' })
  expect(snapshot.nodes[1]).toMatchObject({ ask: '原因？', form: 'answer' })
  expect(snapshot.nodes[2]!.body![0]).toMatchObject({ ask: '方向？', form: 'choice', choices: ['甲', '乙'] })
  expect(snapshot.nodes[2]!.body![1]!.checks).toEqual([
    { id: 'score', kind: 'rubric', title: '评分', threshold: 80, role: 'reviewer' },
    { id: 'zero', kind: 'rubric', threshold: 0, role: 'reviewer' },
    { id: 'command', kind: 'command' }, { id: 'function', kind: 'function' },
  ])
  snapshot.nodes[2]!.body![0]!.choices!.push('丙')
  const loop = definition.nodes[2]!
  if (loop.kind !== 'loop' || loop.body[0]!.kind !== 'human') throw new Error('fixture 类型错误')
  expect(loop.body[0]!.choices).toEqual(['甲', '乙'])
  expect(JSON.stringify(snapshot)).not.toContain('until')
})
