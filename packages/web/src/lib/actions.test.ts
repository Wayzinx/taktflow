import { describe, expect, it } from 'vitest'
import type { StewardToolCall } from '@taktflow/core'
import { actionKind, diffStat, groupActions, shortTarget, stewardAction, toolAction } from './actions'

describe('动作行：动词表', () => {
  it('不同 harness 的工具名归到同一个动词', () => {
    expect(['Read', 'read_file', 'view'].map(actionKind)).toEqual(['read', 'read', 'read'])
    expect(['Edit', 'MultiEdit', 'write_file', 'apply_patch', 'file_change', 'replace'].map(actionKind)).toEqual(Array(6).fill('edit'))
    expect(['Bash', 'shell', 'command_execution', 'run_shell_command'].map(actionKind)).toEqual(Array(4).fill('command'))
    expect(['Grep', 'Glob', 'list', 'search_file_content'].map(actionKind)).toEqual(Array(4).fill('search'))
    expect(['WebFetch', 'web_search', 'google_web_search'].map(actionKind)).toEqual(Array(3).fill('web'))
    expect(['kb_query', 'Task', 'github.create_issue'].map(actionKind)).toEqual(['knowledge', 'delegate', 'other'])
  })

  it('对象从 JSON 输入或纯文本里取，路径只留末两段', () => {
    expect(toolAction('read_file', '{"path":"src/export/csv.ts"}').target).toBe('…/export/csv.ts')
    expect(toolAction('Read', 'evidence/TC-1/result.json').full).toBe('evidence/TC-1/result.json')
    expect(toolAction('command_execution', 'npm test -- --run\nsecond line', undefined, true)).toMatchObject({ verb: '运行', target: 'npm test -- --run', result: '通过' })
    expect(toolAction('Bash', '{"command":"pnpm lint"}', 'error', false)).toMatchObject({ result: '失败' })
    expect(shortTarget('a'.repeat(60))).toHaveLength(48)
  })

  it('修改从补丁里数增删行，数不出不写', () => {
    const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n+more\n*** End Patch'
    expect(toolAction('apply_patch', patch)).toMatchObject({ verb: '修改', target: 'src/a.ts', add: 2, del: 1 })
    expect(diffStat('just text')).toBeUndefined()
    expect(toolAction('write_file', '{"path":"a.md","content":"x"}').add).toBeUndefined()
  })
})

describe('动作行：合并', () => {
  const calls = [
    { node: 'dev', tool: 'Read', input: 'a.ts' },
    { node: 'dev', tool: 'read_file', input: '{"path":"b.ts"}' },
    { node: 'dev', tool: 'Read', input: 'b.ts' },
    { node: 'dev', tool: 'Bash', input: 'npm test', ok: false },
    { node: 'dev', tool: 'Bash', input: 'npm test', ok: false },
    { node: 'test', tool: 'Read', input: 'c.ts' },
  ]
  const groups = groupActions(calls, (c) => toolAction(c.tool, c.input, undefined, c.ok), (c) => c.node)

  it('连续同动词同节点合并成 ×N，失败的不合并，跨节点不合并', () => {
    expect(groups.map((g) => [g.action.verb, g.action.target, g.items.length])).toEqual([
      ['读取', '2 个文件', 3],
      ['运行', 'npm test', 1],
      ['运行', 'npm test', 1],
      ['读取', 'c.ts', 1],
    ])
  })
})

describe('动作行：管家工具', () => {
  const call = (tool: string, input: Record<string, unknown>, output?: unknown, summary?: string): StewardToolCall => ({ id: tool, tool, input, ok: true, output, summary })

  it('动词 + 对象 + 条数', () => {
    expect(stewardAction(call('list_requirements', { spaceId: 's' }, [1, 2, 3]))).toMatchObject({ verb: '查看', target: '需求列表', result: '3 条' })
    const status = stewardAction(call('requirement_status', { requirementId: 'REQ-002' }, {}))
    expect([status.verb, status.target, status.result]).toEqual(['查看', 'REQ-002 的状态', undefined])
    expect(stewardAction(call('resolve_space', { name: '商城' }, { exact: false }))).toMatchObject({ verb: '核对', result: '没找到' })
    expect(stewardAction(call('show', {}, { shown: 2 }, '可视化：2 个块'))).toMatchObject({ verb: '绘制', result: '2 个块' })
    expect(stewardAction(call('knowledge_search', { text: '导出权限' }, { hits: [1, 2] }))).toMatchObject({ verb: '检索', target: '「导出权限」', result: '2 条命中' })
    expect(stewardAction(call('list_risks', {}, '[{"x":1}…', '风险：返回 40 条'))).toMatchObject({ result: '40 条' })
    expect(stewardAction({ id: 'x', tool: 'mystery', input: {}, ok: false })).toMatchObject({ verb: '调用', target: 'mystery', result: '失败' })
  })
})
