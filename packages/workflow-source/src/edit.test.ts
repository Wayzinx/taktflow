import { describe, expect, it } from 'vitest'
import { applyEdits, parseWorkflowSource, WorkflowSourceError } from './index.js'
import { serializeLiteral } from './serialize.js'

const literal = (value: unknown) => ({ kind: 'literal' as const, value })
const source = `// 文件注释\nexport default defineWorkflow({\n  id: 'test', title: '测试', version: '1',\n  stages: [],\n  nodes: [\n    // 保留节点注释\n    agent({ id: 'a', title: 'A', prompt: 'old' }), // 行尾\n\n    script({ id: 'b', title: 'B', run: 'true' }),\n  ],\n})\n`

describe('最小文本编辑', () => {
  it('修改属性只替换值，注释、空行和其他字节不变', () => {
    expect(applyEdits(source, [{ op: 'setProp', id: 'a', key: 'prompt', value: literal('new') }]).source).toBe(source.replace("prompt: 'old'", "prompt: 'new'"))
  })
  it('删除、追加属性及简写属性', () => {
    expect(applyEdits(source, [{ op: 'setProp', id: 'a', key: 'title', value: null }]).source).toBe(source.replace("title: 'A',", ''))
    expect(applyEdits(source, [{ op: 'setProp', id: 'a', key: 'role', value: literal('pm') }]).source).toBe(source.replace("prompt: 'old'", "prompt: 'old', role: 'pm'"))
    const shorthand = source.replace("prompt: 'old'", 'prompt')
    expect(applyEdits(shorthand, [{ op: 'setProp', id: 'a', key: 'prompt', value: literal('new') }]).source).toBe(source.replace("prompt: 'old'", "prompt: 'new'"))
  })
  it('多行对象末尾追加和删除不吞掉注释', () => {
    const multiline = source.replace("id: 'a', title: 'A', prompt: 'old'", "\n      id: 'a',\n      prompt: 'old' // keep\n    ")
    const added = applyEdits(multiline, [{ op: 'setProp', id: 'a', key: 'title', value: literal('A') }]).source
    expect(added).toBe(multiline.replace("prompt: 'old' // keep\n", "prompt: 'old', // keep\n      title: 'A',\n"))
    expect(applyEdits(added, [{ op: 'setProp', id: 'a', key: 'title', value: null }]).source).toBe(multiline.replace("prompt: 'old' // keep", "prompt: 'old', // keep"))
  })
  it('新增节点按顺序输出属性，在 after 行尾注释之后插入', () => {
    const result = applyEdits(source, [{ op: 'addNode', kind: 'agent', props: { id: literal('new'), title: literal('N'), prompt: { kind: 'code', code: 'hooks.prompt()' } }, after: 'a' }])
    expect(result.source).toBe(source.replace('// 行尾\n', "// 行尾\n    agent({ id: 'new', title: 'N', prompt: hooks.prompt() }),\n"))
    expect(result.summary).toBe('新增节点 new')
  })
  it('null 插到开头；省略 after 追加到末尾', () => {
    const edit = { op: 'addNode' as const, kind: 'script' as const, props: { id: literal('new') } }
    expect(applyEdits(source, [{ ...edit, after: null }]).source).toBe(source.replace('nodes: [\n', "nodes: [\n    script({ id: 'new' }),\n"))
    expect(applyEdits(source, [edit]).source).toBe(source.replace("run: 'true' }),\n", "run: 'true' }),\n    script({ id: 'new' }),\n"))
  })
  it('删除节点保留其他注释；清理 needs 并对代码依赖告警', () => {
    const input = source.replace("title: 'B',", "title: 'B', needs: ['a'],")
    const result = applyEdits(input, [{ op: 'removeNode', id: 'a' }])
    expect(result.source).toBe(input.replace("agent({ id: 'a', title: 'A', prompt: 'old' }),", '').replace("needs: ['a'],", ''))
    const code = input.replace("['a']", 'deps')
    const warning = applyEdits(code, [{ op: 'removeNode', id: 'a' }])
    expect(warning.diagnostics).toEqual([expect.objectContaining({ severity: 'warning', nodeId: 'b', line: expect.any(Number) })])
    expect(warning.source).toContain('needs: deps')
  })
  it('setNeeds 空数组删除，非空数组写入', () => {
    const withNeeds = applyEdits(source, [{ op: 'setNeeds', id: 'b', needs: ['a'] }]).source
    expect(withNeeds).toBe(source.replace("run: 'true'", "run: 'true', needs: ['a']"))
    expect(applyEdits(withNeeds, [{ op: 'setNeeds', id: 'b', needs: [] }]).source).toBe(source.replace("run: 'true'", "run: 'true' "))
  })
  it('setStages、setMeta 和连续操作每次重新定位', () => {
    const result = applyEdits(source, [
      { op: 'setStages', stages: [{ id: 'dev', title: '开发' }] },
      { op: 'setMeta', key: 'title', value: '新标题' },
      { op: 'setProp', id: 'a', key: 'prompt', value: literal('a\nb') },
      { op: 'setProp', id: 'b', key: 'run', value: { kind: 'code', code: 'async () => {}' } },
    ])
    expect(result.source).toBe(source.replace('stages: []', "stages: [{ id: 'dev', title: '开发' }]").replace("title: '测试'", "title: '新标题'").replace("prompt: 'old'", 'prompt: `a\nb`').replace("run: 'true'", 'run: async () => {}'))
    expect(result.summary).toBe('修改阶段；修改 title；修改 a.prompt；修改 b.run')
  })
  it('同数组移动保留元素内部原文', () => {
    const input = source.replace(' // 行尾', '')
    const result = applyEdits(input, [{ op: 'moveNode', id: 'b', after: null }])
    expect(result.source).toBe(input.replace("    script({ id: 'b', title: 'B', run: 'true' }),\n", '').replace('nodes: [\n', "nodes: [\n    script({ id: 'b', title: 'B', run: 'true' }),\n"))
  })
  it('loop body 插入、跨数组移动、删除 loop 清理子节点依赖', () => {
    const input = source.replace("    script({ id: 'b', title: 'B', run: 'true' }),", "    loop({ id: 'l', body: [\n      script({ id: 'b', run: 'true' }),\n    ] }),")
    const added = applyEdits(input, [{ op: 'addNode', kind: 'agent', props: { id: literal('c') }, parent: 'l', after: 'b' }]).source
    expect(added).toBe(input.replace("      script({ id: 'b', run: 'true' }),\n", "      script({ id: 'b', run: 'true' }),\n      agent({ id: 'c' }),\n"))
    const moved = applyEdits(added, [{ op: 'moveNode', id: 'b', after: 'l', parent: null }]).source
    expect(moved).toBe(added.replace("      script({ id: 'b', run: 'true' }),\n", '').replace('    ] }),\n', "    ] }),\n    script({ id: 'b', run: 'true' }),\n"))
    const dep = applyEdits(moved, [{ op: 'setNeeds', id: 'a', needs: ['c'] }, { op: 'removeNode', id: 'l' }])
    expect(parseWorkflowSource(dep.source).model.nodes[0]!.props.needs).toBeUndefined()
  })
  it('空数组、无尾逗号、CRLF 和 tab', () => {
    const empty = "export default defineWorkflow({ id: 'w', stages: [], nodes: [] })"
    const added = applyEdits(empty, [{ op: 'addNode', kind: 'agent', props: { id: literal('a') } }]).source
    expect(added).toBe("export default defineWorkflow({ id: 'w', stages: [], nodes: [\n  agent({ id: 'a' }),\n] })")
    const tab = source.replace(/    /g, '\t').replace(/\n/g, '\r\n')
    expect(applyEdits(tab, [{ op: 'addNode', kind: 'agent', props: { id: literal('c') } }]).source).toBe(tab.replace("run: 'true' }),\r\n", "run: 'true' }),\r\n\tagent({ id: 'c' }),\r\n"))
    const noComma = source.replace("run: 'true' }),", "run: 'true' })")
    expect(parseWorkflowSource(applyEdits(noComma, [{ op: 'addNode', kind: 'agent', props: { id: literal('c') } }]).source).model.editable).toBe(true)
  })
  it('拒绝只读源码、不存在节点、跨数组 after 和自包含移动', () => {
    expect(() => applyEdits('export default other', [])).toThrow(WorkflowSourceError)
    expect(() => applyEdits(source, [{ op: 'removeNode', id: 'missing' }])).toThrow('节点不存在')
    const loop = source.replace("script({ id: 'b', title: 'B', run: 'true' })", "loop({ id: 'b', body: [] })")
    expect(() => applyEdits(loop, [{ op: 'moveNode', id: 'b', parent: 'b', after: null }])).toThrow('自身')
    expect(() => applyEdits(loop, [{ op: 'addNode', kind: 'agent', props: { id: literal('x') }, parent: 'b', after: 'a' }])).toThrow('目标数组')
    expect(() => applyEdits(source, [{ op: 'setProp', id: 'a', key: 'prompt', value: { kind: 'code', code: '(' } }])).toThrow(WorkflowSourceError)
  })
  it('稳定序列化含引号、反斜杠、换行和插值符的值', () => {
    for (const value of ["don't\\escape", 'a\n`b${c}\\d\r', { plain: [1, true, null], 'not-valid': 'x' }, -0]) {
      const edited = applyEdits(source, [{ op: 'setProp', id: 'a', key: 'prompt', value: literal(value) }])
      expect(parseWorkflowSource(edited.source).model.nodes[0]!.props.prompt).toEqual(literal(value))
    }
    expect(() => serializeLiteral(undefined)).toThrow('不支持')
    expect(() => serializeLiteral(NaN)).toThrow('不支持')
  })
})
