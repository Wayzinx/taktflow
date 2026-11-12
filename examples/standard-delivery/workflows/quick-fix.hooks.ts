import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { openProject, type NodeContext } from '@taktflow/core'

const execute = promisify(execFile)
async function given(ctx: NodeContext, directory: string, pattern: RegExp): Promise<boolean> {
  try { return (await readdir(join(ctx.workspaceDir, directory), { withFileTypes: true })).some((entry) => entry.isFile() && pattern.test(entry.name)) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
// T0 跳过简短需求说明的前提是 spec 与用例已经给定；没给就照常写，否则实现和交付校验必然缺少必需输入。
export async function needsSpec(ctx: NodeContext) {
  return ctx.args.tier !== 'T0' || !(await given(ctx, 'spec', /\.md$/) && await given(ctx, 'cases', /\.json$/))
}
export async function runQuickTests(ctx: NodeContext) {
  const stores = await openProject(ctx.projectDir)
  const state = await stores.runs.get(ctx.runId)
  const tree = state?.nodes.implement?.worktree
  if (!tree) return { id: 'tests', pass: false, message: '缺少实现工作树，不能验证未修改的主检出' }
  // 清理执行目录中的旧证据，避免失败的测试命令复用上次结果；版本历史仍保留。
  await rm(join(ctx.workspaceDir, 'evidence'), { recursive: true, force: true })
  let pass = true; let message = ''
  try {
    const result = await execute('/bin/sh', ['-c', 'npm test'], {
      cwd: tree.path, signal: ctx.signal, env: { ...process.env, TAKT_WORKSPACE: ctx.workspaceDir }, maxBuffer: 16 * 1024 * 1024,
    })
    message = result.stdout + result.stderr
  } catch (error) { ctx.signal.throwIfAborted(); pass = false; message = (error as Error).message }
  const written = new Set<string>()
  async function register(directory: string): Promise<void> {
    let entries
    try { entries = await readdir(join(ctx.workspaceDir, directory), { withFileTypes: true }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    for (const entry of entries) {
      const path = `${directory}/${entry.name}`
      if (entry.isDirectory()) await register(path)
      else if (entry.isFile()) {
        written.add(path)
        await stores.workspaces.writeArtifact({ ref: { workspace: ctx.requirementId, path },
        content: await readFile(join(ctx.workspaceDir, path)), kind: 'evidence', author: { type: 'system', id: 'quick-tests' },
        producedBy: { runId: ctx.runId, nodeId: ctx.nodeId }, reason: '本轮测试命令的执行证据' })
      }
    }
  }
  await register('evidence')
  if (!written.has('evidence/summary.json')) return { id: 'tests', pass: false, message: '测试未生成本轮汇总' }
  const summary = JSON.parse(await readFile(join(ctx.workspaceDir, 'evidence/summary.json'), 'utf8')) as { cases?: Array<{ id: string }> }
  if (!summary.cases?.length || summary.cases.some((test) => ![...written].some((path) => path.startsWith(`evidence/${test.id}/`)))) {
    return { id: 'tests', pass: false, message: '测试未生成本轮逐条证据' }
  }
  return { id: 'tests', pass, message }
}
