import { expect, it } from 'vitest'
import { defineWorkflow, judge, loop, planner, script, WorkflowDefinitionError } from './dsl.js'
import type { NodeDef } from './types.js'
import { expandPlanner, validateDag } from './engine/graph.js'

const task = (id: string, needs?: string[]) => script({ id, title: id, needs, run: async () => undefined })
const validate = (nodes: NodeDef[]) => defineWorkflow({ id: 'test', title: 'test', version: '1', stages: [], nodes })

it.each([0, -1, 1.5, NaN, Infinity])('DSL 与引擎同时拒绝非法容器上限 %s', (limit) => {
  for (const node of [loop({ id: 'loop', title: '', maxIterations: limit, until: () => true, body: [] }),
    planner({ id: 'plan', title: '', role: 'dev', prompt: '', maxItems: limit, expand: () => [] })]) {
    expect(() => validate([node])).toThrow(WorkflowDefinitionError)
    expect(() => validateDag([node])).toThrow('正整数')
  }
})

it('静态校验 judge 同作用域目标和路由依赖，允许间接依赖目标', () => {
  const adjudicate = judge({ id: 'judge', title: '', role: 'dev', target: 'source', needs: ['source'], routes: { product_bug: 'fix' } })
  expect(() => validate([task('source'), adjudicate, task('fix', ['judge'])])).not.toThrow()
  expect(() => validate([task('source'), task('gate', ['source']), { ...adjudicate, needs: ['gate'] }, task('fix', ['judge'])])).not.toThrow()
  expect(() => validate([task('source'), adjudicate, task('fix')])).toThrow('路由')
  expect(() => validate([task('source'), loop({ id: 'loop', title: '', maxIterations: 1, until: () => true, body: [{ ...adjudicate, needs: [], routes: {} }] })])).toThrow('同一作用域')
})

it('planner 在加前缀前校验局部 judge，展开后保留条目之间的依赖', () => {
  const definition = planner({ id: 'plan', title: '', role: 'dev', prompt: '', maxItems: 2, expand: () => [
    task('source'), judge({ id: 'judge', title: '', role: 'dev', target: 'source', needs: ['source'], routes: { product_bug: 'fix' } }), task('fix', ['judge']),
  ] })
  const groups = expandPlanner(definition, [{ key: 'a', title: 'A' }, { key: 'b', title: 'B', dependsOn: ['a'] }])
  expect(groups[1]?.nodes[0]?.needs).toEqual(['plan/a/fix'])
  expect(() => expandPlanner({ ...definition, expand: () => [task('x', ['missing'])] }, [{ key: 'a', title: '' }])).toThrow('unknown dependency')
  expect(() => validate([task('a', ['b']), task('b', ['a'])])).toThrow('cycle')
})
