import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseWorkflowSource, lintWorkflowSource } from './index.js'

const wrap = (nodes: string, stages = '[]') => `export default defineWorkflow({ id: 'test', title: 'Test', version: '1', stages: ${stages}, nodes: ${nodes} })`

describe('源码解析', () => {
  it('递归分类字面量和代码，保留代码原文与区间', () => {
    const source = wrap("[agent({ id: 'a', title: `无插值`, prompt: hooks.prompt('a'), data: { a: [1, -2, +3, true, false, null] }, dynamic: `hi ${name}`, spread: [1, ...rest], fn: (ctx) => ctx.value, ref, object: { a: unknown } })]")
    const parsed = parseWorkflowSource(source, 'demo.ts')
    expect(parsed.diagnostics).toEqual([])
    const props = parsed.model.nodes[0]!.props
    expect(props.title).toEqual({ kind: 'literal', value: '无插值' })
    expect(props.data).toEqual({ kind: 'literal', value: { a: [1, -2, 3, true, false, null] } })
    for (const key of ['prompt', 'dynamic', 'spread', 'fn', 'ref', 'object']) expect(props[key]?.kind).toBe('code')
    expect(props.prompt).toEqual({ kind: 'code', code: "hooks.prompt('a')" })
    const span = parsed.spans.byId.get('a')!.object.properties.get('prompt')!.value
    expect(source.slice(span.start, span.end)).toBe("hooks.prompt('a')")
  })
  it('支持全部构造函数和嵌套 loop', () => {
    const kinds = ['agent', 'script', 'gate', 'human', 'judge', 'planner', 'review', 'subflow']
    const source = wrap(`[${kinds.map((kind) => `${kind}({ id: '${kind}' })`).join(',')}, loop({ id: 'outer', body: [loop({ id: 'inner', body: [agent({ id: 'leaf' })] })] })]`)
    const parsed = parseWorkflowSource(source)
    expect(parsed.model.editable).toBe(true)
    expect(parsed.model.nodes.at(-1)?.body?.[0]?.body?.[0]?.id).toBe('leaf')
    expect(parsed.spans.byId.get('leaf')?.parent).toBe('inner')
    expect(parsed.spans.bodies.size).toBe(2)
  })
  it.each([
    ['export default workflow', '默认导出'],
    [wrap('nodes'), 'nodes 不是数组字面量'],
    [wrap('[]', 'stages'), 'stages 不是数组字面量'],
    [wrap('[agent({ id: \'a\' }), ...rest]'), '第 2 个节点'],
    [wrap('[agent(args)]'), '对象字面量'],
    [wrap('[agent({ id: \'a\', ...rest })]'), '展开运算符'],
    [wrap('[loop({ id: \'a\', body: children })]'), 'body 不是数组字面量'],
    [wrap('[agent({ id: dynamic })]'), 'id 必须'],
    [wrap('[agent({ id: \'a\', [key]: 1 })]'), '计算属性名'],
    [wrap('[agent({ id: \'a\', id: \'b\' })]'), '重复'],
    [wrap('[agent({ id: \'a\' }), script({ id: \'a\' })]'), '重复'],
  ])('对子集以外的结构只读并定位：%s', (source, message) => {
    const parsed = parseWorkflowSource(source)
    expect(parsed.model.editable).toBe(false)
    expect(parsed.diagnostics.some((d) => d.message.includes(message) && d.line === 1 && d.column! > 0)).toBe(true)
    expect(lintWorkflowSource(source)).toEqual(parsed.diagnostics)
  })
  it('语法错误包含准确行号', () => {
    const result = parseWorkflowSource("export default defineWorkflow({\n nodes: [agent({ id: 'a', prompt: })], stages: [] })")
    expect(result.model.editable).toBe(false)
    expect(result.diagnostics.some((d) => d.line === 2)).toBe(true)
  })
  it('当前 sdlc 模板按实际结构解析，不把函数属性误判为只读', async () => {
    const source = await readFile(new URL('../../../templates/workflows/sdlc.workflow.ts', import.meta.url), 'utf8')
    const parsed = parseWorkflowSource(source)
    expect(parsed.diagnostics).toEqual([])
    expect(parsed.model.meta.id).toBe('sdlc')
    expect(parsed.spans.byId.get('fix-case')).toBeDefined()
    expect(parsed.model.nodes.find((node) => node.id === 'implement')!.props.expand?.kind).toBe('code')
  })
  const standard = new URL('../../../templates/workflows/taktflow-standard.workflow.ts', import.meta.url)
  it.skipIf(!existsSync(standard))('作者版标准模板：review 配置、hooks 和 loop 都能定位', async () => {
    const parsed = parseWorkflowSource(await readFile(standard, 'utf8'))
    expect(parsed.diagnostics).toEqual([])
    expect(parsed.model.meta.id).toBe('taktflow-standard')
    expect(parsed.model.nodes.find((node) => node.id === 'review-prd')).toMatchObject({ kind: 'review' })
    expect(parsed.model.nodes.find((node) => node.id === 'implement')!.props.expand).toEqual({ kind: 'code', code: 'expandTask' })
    expect(parsed.spans.byId.get('review-fix')?.parent).toBe('dev-test-loop')
  })

})
