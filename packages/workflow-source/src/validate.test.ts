import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { validateWorkflowSource } from './index.js'
import { workflowFixture } from './test-fixtures.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'takt-workflow-validate-')); await writeFile(join(dir, 'package.json'), '{"type":"module"}') })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
async function validate(source: string) {
  const file = join(dir, 'demo.workflow.ts')
  await writeFile(file, source)
  return validateWorkflowSource(file)
}

describe('子进程加载校验', () => {
  it('合法文件返回 core 快照，反复修改不受模块缓存影响', async () => {
    const first = await validate(workflowFixture)
    expect(first.diagnostics).toEqual([])
    expect(first.snapshot?.nodes[0]?.prompt).toBe('first')
    const second = await validate(workflowFixture.replace("prompt: 'first'", "prompt: 'changed'"))
    expect(second.snapshot?.nodes[0]?.prompt).toBe('changed')
  })
  it('保留相对导入，stdout 日志不干扰结果', async () => {
    await writeFile(join(dir, 'hooks.ts'), "export const prompt = 'from hooks'\n")
    const result = await validate("import { prompt } from './hooks.js'\nconsole.log('not JSON')\n" + workflowFixture.replace("prompt: 'first'", 'prompt'))
    expect(result.diagnostics).toEqual([])
    expect(result.snapshot?.nodes[0]?.prompt).toBe('from hooks')
  })
  it.each([
    [workflowFixture.replace("prompt: 'first',", "prompt: 'first', needs: ['missing'],"), 'dependency'],
    [workflowFixture.replace("prompt: 'first',", "prompt: 'first', needs: ['b'],").replace("prompt: 'second',", "prompt: 'second', needs: ['a'],"), 'cycle'],
  ])('依赖错误转成带源码位置的诊断', async (source, message) => {
    const result = await validate(source)
    expect(result.snapshot).toBeUndefined()
    expect(result.diagnostics[0]).toMatchObject({ severity: 'error', message: expect.stringContaining(message), line: 2 })
  })
  it('语法错误准确定位，不执行坏代码', async () => {
    const result = await validate(workflowFixture.replace("prompt: 'first'", 'prompt: =>'))
    expect(result.snapshot).toBeUndefined()
    expect(result.diagnostics.some((d) => d.line === 12 && d.severity === 'error')).toBe(true)
  })
  it('合法的子集以外文件仍可返回运行快照', async () => {
    const result = await validate(workflowFixture.replace('export default defineWorkflow', 'const definition = defineWorkflow') + '\nexport default definition\n')
    expect(result.diagnostics).toEqual([])
    expect(result.snapshot?.id).toBe('demo')
  })
  it('坏文件退出子进程也不会结束测试服务进程', async () => {
    const result = await validate('process.exit(0)\n' + workflowFixture)
    expect(result.diagnostics[0]?.message).toContain('未返回快照')
  })
  it('15 秒后终止无法完成的加载', async () => {
    const result = await validate('while (true) {}\n' + workflowFixture)
    expect(result.diagnostics).toEqual([{ severity: 'error', message: 'workflow 加载超时（15 秒）' }])
  }, 20_000)
})
