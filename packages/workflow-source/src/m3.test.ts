import { expect, it } from 'vitest'
import { applyEdits } from './edit.js'
import { lintWorkflowSource, parseWorkflowSource } from './parse.js'

const source = `// 保留这个注释
export default defineWorkflow({
  id: 'm3', title: 'M3', version: '1',
  useWhen: '小改动', tiers: ['T0', 'T1'],
  leadInstructions: '主动推进', dynamicRules: getRules(), budget: { tokens: 100, minutes: 5 },
  stages: [],
  nodes: [agent({ id: 'dev', title: '实现', role: 'dev', prompt: '实现功能' })],
})
`
it('五个元数据同时保留字面量和代码值', () => {
  expect(parseWorkflowSource(source).model.meta).toMatchObject({
    useWhen: { kind: 'literal', value: '小改动' }, tiers: { kind: 'literal', value: ['T0', 'T1'] },
    leadInstructions: { kind: 'literal', value: '主动推进' }, dynamicRules: { kind: 'code', code: 'getRules()' },
    budget: { kind: 'literal', value: { tokens: 100, minutes: 5 } },
  })
})
it('setMetaValue 最小替换，支持新增、删除和代码值；重复删除不改源码', () => {
  const changed = applyEdits(source, [{ op: 'setMetaValue', key: 'tiers', value: { kind: 'literal', value: ['T2', 'T3'] } }]).source
  expect(changed).toBe(source.replace("['T0', 'T1']", "['T2', 'T3']"))
  const deleted = applyEdits(source, [{ op: 'setMetaValue', key: 'useWhen', value: null }]).source
  expect(parseWorkflowSource(deleted).model.meta.useWhen).toBeUndefined()
  expect(applyEdits(deleted, [{ op: 'setMetaValue', key: 'useWhen', value: null }]).source).toBe(deleted)
  const added = applyEdits(deleted, [{ op: 'setMetaValue', key: 'useWhen', value: { kind: 'code', code: 'pickScenario()' } }]).source
  expect(parseWorkflowSource(added).model.meta.useWhen).toEqual({ kind: 'code', code: 'pickScenario()' })
  expect(added).toContain('// 保留这个注释')
  expect(added).toContain("nodes: [agent({ id: 'dev', title: '实现', role: 'dev', prompt: '实现功能' })]")
})
it.each(["['T4']", "'T1'", '[1]'])('非法 tiers 产生 error：%s', (tiers) => {
  expect(lintWorkflowSource(source.replace("['T0', 'T1']", tiers))).toContainEqual(expect.objectContaining({ severity: 'error', message: expect.stringContaining('tiers') }))
})
it('代码值未知时不猜测 tiers；合法档位不报错', () => {
  expect(lintWorkflowSource(source)).toEqual([])
  expect(lintWorkflowSource(source.replace("['T0', 'T1']", 'computeTiers()'))).toEqual([])
})
it.each(["reviewers: [{ role: 'dev' }]", "reviewers: [{ role: 'qa' }], arbiter: { role: 'dev' }"])('评审者或裁决者为作者时报错：%s', (roles) => {
  const text = `export default defineWorkflow({ id: 'x', title: 'x', version: '1', stages: [], nodes: [review({ id: 'r', author: { role: 'dev' }, ${roles} })] })`
  expect(lintWorkflowSource(text)).toContainEqual(expect.objectContaining({ nodeId: 'r', severity: 'error', message: expect.stringContaining('评审者不能') }))
})
it('rubric 只对上游作者同角色警告；完成标准按 Unicode 字符计数', () => {
  const text = `export default defineWorkflow({ id: 'x', title: 'x', version: '1', stages: [], nodes: [
    agent({ id: 'dev', role: 'dev', completion: ['测试通过', '所有验收标准通过'] }),
    script({ id: 'middle', needs: ['dev'], run: 'true' }),
    gate({ id: 'g', needs: ['middle'], checks: [{ id: 'same', kind: 'rubric', role: 'dev' }, { id: 'independent', kind: 'rubric', role: 'qa' }] }),
    gate({ id: 'unrelated', checks: [{ id: 'unrelated', kind: 'rubric', role: 'dev' }] }),
  ] })`
  expect(lintWorkflowSource(text)).toEqual([
    expect.objectContaining({ severity: 'warning', nodeId: 'dev', message: expect.stringContaining('6') }),
    expect.objectContaining({ severity: 'warning', nodeId: 'g', message: expect.stringContaining('same') }),
  ])
})
it('嵌套 loop 的节点也检查，循环依赖不会无限递归', () => {
  const text = `export default defineWorkflow({ id: 'x', title: 'x', version: '1', stages: [], nodes: [loop({ id: 'loop', body: [
    agent({ id: 'a', role: 'dev', needs: ['g'], completion: ['短'] }),
    gate({ id: 'g', needs: ['a'], checks: [{ id: 'same', kind: 'rubric', role: 'dev' }] })
  ] })] })`
  expect(lintWorkflowSource(text)).toHaveLength(2)
})
it('acceptance 交付校验没有任何节点产出用例 / 执行结果时报错；能产出或看不清时不报', () => {
  const flow = (nodes: string) => `export default defineWorkflow({ id: 'x', title: 'x', version: '1', stages: [], nodes: [${nodes}] })`
  const gateNode = "gate({ id: 'delivery-check', needs: ['implement'], checks: [{ id: 'acceptance', kind: 'acceptance', role: 'verifier' }] })"
  const implement = "agent({ id: 'implement', role: 'dev', outputs: [{ path: 'tasks/change.md', kind: 'task' }] })"
  // 真实事故：裁掉测分与跑用例，只留实现 + 交付校验
  expect(lintWorkflowSource(flow(`${implement}, ${gateNode}`))).toContainEqual(expect.objectContaining({
    nodeId: 'delivery-check', severity: 'error', message: expect.stringContaining('用例 cases/*.json、执行结果 evidence/summary.json'),
  }))
  const cases = "agent({ id: 'test-design', role: 'test-designer', outputs: [{ path: 'cases/*.json', kind: 'case' }] })"
  const runCases = "script({ id: 'run-cases', run: runCases, outputs: [{ path: 'evidence/summary.json', kind: 'evidence' }] })"
  expect(lintWorkflowSource(flow(`${cases}, ${implement}, ${gateNode}`))).toContainEqual(expect.objectContaining({ message: expect.stringContaining('执行结果 evidence/summary.json') }))
  expect(lintWorkflowSource(flow(`${cases}, ${implement}, ${runCases}, ${gateNode}`))).toEqual([])
  // 产出写在变量里、或有动态展开时不猜
  expect(lintWorkflowSource(flow(`agent({ id: 'implement', role: 'dev', outputs: caseOutputs }), ${gateNode}`))).toEqual([])
  // 没有 acceptance 检查的门禁不受影响
  expect(lintWorkflowSource(flow(`${implement}, gate({ id: 'g', checks: [{ id: 't', kind: 'function', fn: run }] })`))).toEqual([])
})
