import { describe, expect, it } from 'vitest'
import { expectPositionals, parseAnswerOptions, parseCliArgs, parsePositiveInt, parseRunArgs } from './args.js'
import { validateAnswer } from './commands/answer.js'
import type { AttentionItem } from '@taktflow/core'

describe('CLI 参数', () => {
  it('全局选项、重复 arg、空值和包含等号的值', () => {
    const cli = parseCliArgs(['--project', '/tmp/project', 'run', 'flow', '--req', 'REQ-001', '--arg', 'x=1', '--arg', 'x=2', '--arg', 'empty=', '--arg', 'expr=a=b', '--json'])
    expect(cli.command).toBe('run')
    expect(cli.positionals).toEqual(['flow'])
    expect(cli.options.project).toBe('/tmp/project')
    expect(cli.options.json).toBe(true)
    expect(parseRunArgs(cli.options.arg)).toEqual({ x: '2', empty: '', expr: 'a=b' })
  })
  it.each([['--unknown'], ['run', '--req'], ['serve', '--json=yes']])('拒绝未知选项或错误值 %j', (...argv) => {
    expect(() => parseCliArgs(argv)).toThrow()
  })
  it.each(['missing', '=value'])('拒绝非法 arg %s', (arg) => {
    expect(() => parseRunArgs([arg])).toThrow('k=v')
  })
  it('位置参数不能多也不能少', () => {
    expect(() => expectPositionals('run', [], 1)).toThrow('缺少')
    expect(() => expectPositionals('run', ['a', 'b'], 1)).toThrow('过多')
    expect(expectPositionals('init', [], 0, 1)).toEqual([])
  })
  it.each(['0', '-1', '1.1', 'NaN', '9007199254740992'])('拒绝非法正整数 %s', (value) => {
    expect(() => parsePositiveInt(value, 'port')).toThrow('正整数')
  })
  it('answer 必须且只能选择一种回答', () => {
    const options = parseCliArgs([]).options
    expect(() => parseAnswerOptions(options)).toThrow('需要')
    expect(() => parseAnswerOptions({ ...options, approve: true, reject: true })).toThrow('互斥')
    expect(() => parseAnswerOptions({ ...options, answer: '', choice: 'x' })).toThrow('互斥')
    expect(parseAnswerOptions({ ...options, approve: true })).toEqual({ decision: 'approve' })
    expect(parseAnswerOptions({ ...options, reject: true })).toEqual({ decision: 'reject' })
    expect(parseAnswerOptions({ ...options, answer: 'text' })).toEqual({ answer: 'text' })
    expect(parseAnswerOptions({ ...options, choice: 'x' })).toEqual({ decision: 'choice', answer: 'x' })
  })
  it('按实际待办表单校验，拒绝非法 choice 和跨表单回答', () => {
    const item: AttentionItem = { requestId: 'q', runId: 'r', nodeId: 'n', requirementId: 'REQ-001', ask: '?', form: 'choice', choices: ['a', 'b'], createdAt: '' }
    expect(() => validateAnswer(item, { decision: 'choice', answer: 'a' })).not.toThrow()
    expect(() => validateAnswer(item, { decision: 'choice', answer: 'c' })).toThrow('必须')
    expect(() => validateAnswer(item, { decision: 'approve' })).toThrow('不接受')
    expect(() => validateAnswer(item, { answer: 'a' })).toThrow('不接受')
    expect(() => validateAnswer({ ...item, form: 'approve' }, { decision: 'choice', answer: 'a' })).toThrow('不接受')
    expect(() => validateAnswer({ ...item, form: 'answer' }, { answer: ' ' })).toThrow('不能为空')
  })
})
