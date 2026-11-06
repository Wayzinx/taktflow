import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EngineDeps } from '../interfaces.js'
import type { HarnessSelector, Usage } from '../types.js'
import { resolveHarnessSelector, selectHarness } from '../engine/selection.js'
import { executionAdapters } from '../engine/execution.js'
import { validateSchema, parseResult } from '../engine/schema.js'
import { WriteGuard } from '../engine/guard.js'
import { estimateTokens } from '../util/tokens.js'

export async function readOnlyModel(deps: EngineDeps, role: string, prompt: string, schema: Record<string, unknown>, override?: HarnessSelector): Promise<{ data: unknown; usage: Usage }> {
  const profile = deps.profiles[role]
  if (!profile) throw new Error(`缺少独立角色：${role}`)
  const selector = selectHarness(role, override, { ...deps, config: deps.stores.config })
  const { harness, model, provider } = resolveHarnessSelector(selector, deps.stores.config, deps.harnesses)
  const cwd = await mkdtemp(join(tmpdir(), `takt-${role}-`))
  try {
    const adapter = deps.sandbox ?? await (await executionAdapters()).selectSandboxProvider(deps.stores.config.sandbox)
    const env: Record<string, string> = { TAKT_ROLE: role, TAKT_NODE: role }
    if (provider?.apiKeyEnv && process.env[provider.apiKeyEnv]) env[provider.apiKeyEnv] = process.env[provider.apiKeyEnv]!
    const sandbox = await adapter.create({ workdir: cwd, mounts: [{ source: cwd, target: cwd, mode: 'ro' }], env,
      network: deps.stores.config.sandbox?.network ?? 'egress', image: deps.stores.config.sandbox?.image, limits: { timeoutMs: 120000 } })
    try {
      const finish = await new WriteGuard(cwd).begin({ profile: [], node: [] })
      const result = await harness.run({ cwd, sandbox, prompt, model, provider, effort: selector.effort, systemAppend: profile.instructions,
        tools: { writeScope: [], allowBash: false }, env, resultSchema: harness.capabilities?.structuredOutput ? schema : undefined, signal: AbortSignal.timeout(120000), timeoutMs: 120000 }, () => {})
      const violation = await finish()
      if (violation.paths.length) throw new Error(`${role} 只读会话写入了文件：${violation.paths.join(', ')}`)
      if (!result.ok) throw new Error(`${role} 失败：${result.error ?? result.finalText}`)
      const data = result.structured ?? parseResult(result.finalText, schema)
      validateSchema(data, schema)
      return { data, usage: result.usage ?? { inputTokens: estimateTokens(prompt + profile.instructions), outputTokens: estimateTokens(result.finalText) } }
    } finally { await sandbox.dispose() }
  } finally { await rm(cwd, { recursive: true, force: true }) }
}
