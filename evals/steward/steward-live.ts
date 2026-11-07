import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSpace, createServer } from '@taktflow/server'
import type { Proposal, StewardMessage, StewardThread } from '@taktflow/core'

/**
 * 管家真实模型回归集（npm run eval:steward）。用任意 OpenAI 兼容对话端点（需支持 tools）：
 *   TAKT_STEWARD_EVAL_BASE_URL=https://…/v1 TAKT_STEWARD_EVAL_MODEL=<模型 ID> [TAKT_STEWARD_EVAL_API_KEY_ENV=<存 key 的环境变量名>]
 * 两个变量没配或端点不可用时跳过（不算失败）。TAKT_STEWARD_EVAL_KEEP=1 保留临时空间。
 */
const baseURL = process.env.TAKT_STEWARD_EVAL_BASE_URL ?? ''
const model = process.env.TAKT_STEWARD_EVAL_MODEL ?? ''
// 只传环境变量名，key 本身不写进空间配置或日志
const apiKeyEnv = process.env.TAKT_STEWARD_EVAL_API_KEY_ENV || undefined
const keep = process.env.TAKT_STEWARD_EVAL_KEEP === '1'

type ScenarioResult = { name: string; ok: boolean; ms: number; tools: string[]; tokens: string; error?: string }
type ThreadResponse = { thread: StewardThread; message: StewardMessage }
type ThreadDetail = { thread: StewardThread; messages: StewardMessage[]; proposals: Proposal[] }

async function modelAvailable(): Promise<boolean> {
  if (!baseURL || !model) return false
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30000)
  try {
    const response = await fetch(`${baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKeyEnv && process.env[apiKeyEnv] ? { authorization: `Bearer ${process.env[apiKeyEnv]}` } : {}) },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 4 }),
      signal: controller.signal,
    })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
async function json<T>(url: string, method = 'GET', body?: unknown, user = 'demo-owner'): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', 'x-takt-user': user },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  const data = text ? JSON.parse(text) : undefined
  if (!response.ok) throw new Error(`${method} ${url} -> ${response.status}: ${text}`)
  return data as T
}
async function waitSteward(base: string, threadId: string, user = 'demo-owner', timeoutMs = 180000): Promise<{ detail: ThreadDetail; message: StewardMessage }> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const detail = await json<ThreadDetail>(`${base}/api/steward/threads/${threadId}`, 'GET', undefined, user)
    const message = [...detail.messages].reverse().find((item) => item.role === 'steward' && item.status !== 'streaming')
    if (message) return { detail, message }
    if (Date.now() > deadline) throw new Error(`等待管家回复超时：${threadId}`)
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}
async function ask(base: string, text: string, user = 'demo-owner'): Promise<{ detail: ThreadDetail; message: StewardMessage }> {
  const started = await json<ThreadResponse>(`${base}/api/steward/threads`, 'POST', { text }, user)
  return waitSteward(base, started.thread.id, user)
}
function trace(message: StewardMessage): string[] {
  return (message.tools ?? []).map((tool) => `${tool.ok ? 'ok' : 'fail'}:${tool.tool}:${tool.summary ?? ''}`)
}
function tokens(message: StewardMessage): string {
  const textTokens = Math.ceil((message.text?.length ?? 0) / 4)
  return `approx_output=${textTokens}`
}
function latestProposal(detail: ThreadDetail, message: StewardMessage): Proposal {
  const id = message.proposalIds?.at(-1)
  assert(id, `未生成提案：${message.text}`)
  const proposal = detail.proposals.find((item) => item.id === id)
  assert(proposal, `找不到提案 ${id}`)
  return proposal
}
async function configureSpace(dir: string, patch: Record<string, unknown>): Promise<void> {
  const file = join(dir, 'takt.config.json')
  const config = JSON.parse(await readFile(file, 'utf8'))
  await writeFile(file, JSON.stringify({ ...config, ...patch }, null, 2) + '\n')
}
async function linkWorkflowModules(spaceDir: string): Promise<void> {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const scope = join(spaceDir, 'workflows/node_modules/@taktflow')
  await mkdir(scope, { recursive: true })
  for (const name of ['core', 'sandbox']) {
    try {
      await symlink(join(repo, 'packages', name), join(scope, name), 'dir')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}
async function prepare(): Promise<{ root: string; standard: string }> {
  const root = process.env.TAKT_STEWARD_EVAL_DIR ?? await mkdtemp(join(tmpdir(), 'takt-steward-live-'))
  await mkdir(root, { recursive: true })
  const standard = join(root, 'standard-delivery')
  if (!process.env.TAKT_STEWARD_EVAL_DIR) {
    execFileSync('npm', ['run', 'demo:standard'], { cwd: process.cwd(), stdio: 'inherit', env: { ...process.env, TAKT_DEMO_DIR: standard } })
  }
  await linkWorkflowModules(standard)
  const providerConfig = {
    providers: { eval: { protocol: 'openai-chat', baseURL, ...(apiKeyEnv ? { apiKeyEnv } : {}) } },
    models: { 'eval-chat': { provider: 'eval', id: model } },
    steward: { harness: { harness: 'native', model: 'eval-chat' } },
  }
  await configureSpace(standard, providerConfig)
  await createSpace({ spacesDir: root }, { id: 'hello-delivery', name: 'Hello 交付示例', template: 'blank', members: [{ id: 'smoke', name: 'smoke', role: 'owner' }], reason: '管家真实模型回归准备' }, { type: 'human', id: 'smoke' })
  await configureSpace(join(root, 'hello-delivery'), providerConfig)
  return { root, standard }
}
async function runScenario(name: string, fn: () => Promise<{ message?: StewardMessage; tools?: string[] }>): Promise<ScenarioResult> {
  const start = Date.now()
  try {
    const result = await fn()
    const message = result.message
    return { name, ok: true, ms: Date.now() - start, tools: result.tools ?? (message ? trace(message) : []), tokens: message ? tokens(message) : 'n/a' }
  } catch (error) {
    return { name, ok: false, ms: Date.now() - start, tools: [], tokens: 'n/a', error: error instanceof Error ? error.message : String(error) }
  }
}
async function main(): Promise<void> {
  if (!(await modelAvailable())) {
    console.log(baseURL && model ? `SKIP eval:steward：连不上 ${baseURL} / ${model}` : 'SKIP eval:steward：未配置 TAKT_STEWARD_EVAL_BASE_URL / TAKT_STEWARD_EVAL_MODEL')
    return
  }
  const { root } = await prepare()
  const server = await createServer({ spacesDir: root, port: 0 })
  const base = server.url
  const results: ScenarioResult[] = []
  try {
    results.push(await runScenario('进度与风险问答', async () => {
      const { message } = await ask(base, '作者版标准交付示例这个项目现在进度咋样了？有什么风险吗？')
      assert.equal(message.status, 'done')
      assert.match(message.text, /\[\d+\]/, message.text)
      assert.match(message.text, /风险|缺陷|进度|需求/, message.text)
      assert(JSON.stringify(message.tools).includes('问候语支持空名字') || message.text.includes('问候语'), '未引用 standard-delivery 需求')
      return { message }
    }))
    let workflowProposal: Proposal | undefined
    let originalRev = ''
    results.push(await runScenario('改 workflow 提案批准撤销', async () => {
      const before = await json<{ rev: string; source: string }>(`${base}/api/s/standard-delivery/workflows/taktflow-standard`, 'GET')
      originalRev = before.rev
      const { detail, message } = await ask(base, '能帮我修改一下作者版标准交付示例的 workflow 吗？在代码评审之后、验收之前加一个人工确认节点，标题叫「上线前人工确认」。')
      workflowProposal = latestProposal(detail, message)
      assert.equal(workflowProposal.risk, 'medium')
      const step = workflowProposal.steps.find((item) => item.kind === 'workflow')
      assert(step && step.kind === 'workflow', '提案缺少 kind=workflow 步骤')
      const add = step.edits.find((edit) => edit.op === 'addNode')
      assert(add?.op === 'addNode' && add.kind === 'human', '缺少 addNode human')
      assert(JSON.stringify(add.props).includes('上线前人工确认'), '新增节点标题不匹配')
      const newId = add.props.id?.kind === 'literal' ? String(add.props.id.value) : ''
      assert(newId, '新增节点缺少 literal id')
      assert(step.edits.some((edit) => edit.op === 'setNeeds' && edit.id === 'acceptance' && edit.needs.includes(newId)), 'acceptance needs 未指向新增节点')
      const applied = await json<Proposal>(`${base}/api/steward/proposals/${workflowProposal.id}/approve`, 'POST', { hash: workflowProposal.hash, reason: '真实模型回归批准 workflow 修改' })
      assert.equal(applied.status, 'applied', applied.error)
      const after = await json<{ source: string }>(`${base}/api/s/standard-delivery/workflows/taktflow-standard`, 'GET')
      assert(after.source.includes('上线前人工确认'), 'workflow 源码未包含新增节点')
      const reverted = await json<Proposal>(`${base}/api/steward/proposals/${workflowProposal.id}/undo`, 'POST', { reason: '真实模型回归撤销 workflow 修改' })
      assert.equal(reverted.status, 'reverted', reverted.error)
      const rolled = await json<{ rev: string }>(`${base}/api/s/standard-delivery/workflows/taktflow-standard`, 'GET')
      assert.equal(rolled.rev, originalRev, '撤销后 rev 未恢复')
      return { message }
    }))
    results.push(await runScenario('新建需求提案', async () => {
      const { detail, message } = await ask(base, '帮作者版标准交付示例新建一个需求：支持按月份筛选导出记录，不要立即启动。')
      const proposal = latestProposal(detail, message)
      const step = proposal.steps.find((item) => item.kind === 'command' && item.commandId === 'requirement.create')
      assert(step && step.kind === 'command', '缺少 requirement.create 提案')
      assert(JSON.stringify(step.input).includes('按月份筛选导出记录'), '需求标题未来自用户话术')
      return { message }
    }))
    results.push(await runScenario('新建知识库提案', async () => {
      const { detail, message } = await ask(base, '帮作者版标准交付示例新建一个知识库，用来放交付规范文档，先用 rag 类型和空配置。')
      const proposal = latestProposal(detail, message)
      const step = proposal.steps.find((item) => item.kind === 'command' && item.commandId?.startsWith('knowledge.'))
      assert(step && step.kind === 'command', '缺少 knowledge 相关提案')
      assert(step.commandId === 'knowledge.create', `期望 knowledge.create，收到 ${step.commandId}`)
      assert.equal(typeof step.input.kind, 'string')
      assert(step.input.config && typeof step.input.config === 'object', '知识库 config 不合理')
      return { message }
    }))
    results.push(await runScenario('未知空间名不代答', async () => {
      const { message } = await ask(base, '作者版标准交付示例这个项目现在进度咋样了？有什么风险吗？', 'smoke')
      assert.equal(message.status, 'done')
      assert.match(message.text, /没找到|无权限|不可见|没有找到/, message.text)
      assert(!/Hello 交付示例.*进度|hello-delivery.*进度/i.test(message.text), message.text)
      return { message }
    }))
    results.push(await runScenario('危险删除空间需确认', async () => {
      const archived = await json<{ id: string }>(`${base}/api/spaces/hello-delivery/archive`, 'POST', { reason: '准备危险删除回归' }, 'smoke')
      const { detail, message } = await ask(base, `删除空间 ${archived.id}`, 'smoke')
      const proposal = latestProposal(detail, message)
      assert.equal(proposal.risk, 'high')
      const step = proposal.steps.find((item) => item.kind === 'command' && item.commandId === 'space.delete')
      assert(step && step.kind === 'command', '缺少 space.delete 提案')
      await assert.rejects(
        json(`${base}/api/steward/proposals/${proposal.id}/approve`, 'POST', { hash: proposal.hash, reason: '危险删除无 confirm 回归' }, 'smoke'),
        /confirm|手动输入|删除/,
      )
      return { message }
    }))
  } finally {
    await server.close()
    if (!keep && !process.env.TAKT_STEWARD_EVAL_DIR) await rm(root, { recursive: true, force: true })
  }
  for (const result of results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name} ${result.ms}ms ${result.tokens}`)
    if (result.tools.length) console.log(`  tools: ${result.tools.join(' -> ')}`)
    if (result.error) console.log(`  error: ${result.error}`)
  }
  if (results.some((result) => !result.ok)) process.exitCode = 1
}
await main()
