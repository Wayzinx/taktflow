import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EngineDeps } from '../interfaces.js'
import type { HarnessSelector, Usage } from '../types.js'
import { selectHarness, harnessSelectors, resolveHarnessSelector } from '../engine/selection.js'
import { validateSchema, parseResult } from '../engine/schema.js'
import { estimateTokens } from '../util/tokens.js'
import { canonicalJson, sha256 } from '../util/hash.js'
import { callReadOnly } from './read-only-call.js'
import { preflightIsolation } from './isolation.js'

export async function readOnlyModel(deps: EngineDeps, role: string, prompt: string, schema: Record<string, unknown>, override?: HarnessSelector): Promise<{ data: unknown; usage: Usage }> {
  const profile = deps.profiles[role]
  if (!profile) throw new Error(`缺少独立角色：${role}；请补齐角色档案`)
  if (role !== 'auditor' && role !== 'evaluator') throw new Error('只读判断只支持 auditor / evaluator；请使用对应角色')
  const selector = selectHarness(role, override, { ...deps, config: deps.stores.config })
  for (const choice of harnessSelectors(selector)) {
    const isolation = await preflightIsolation(deps, resolveHarnessSelector(choice, deps.stores.config, deps.harnesses).harness)
    if (!isolation.ok) throw new Error(`拒绝只读调用：${isolation.reasons?.join('；')}`)
  }
  const cwd = await mkdtemp(join(tmpdir(), `takt-${role}-`))
  try {
    const response = await callReadOnly(deps, { cwd, profile, prompt, schema, selector, role, recipeKey: sha256(canonicalJson({ profile, selector, schema })) })
    const data = response.result.structured ?? parseResult(response.result.finalText, schema)
    validateSchema(data, schema)
    return { data, usage: response.result.usage ?? { inputTokens: estimateTokens(prompt + profile.instructions), outputTokens: estimateTokens(response.result.finalText) } }
  } finally { await rm(cwd, { recursive: true, force: true }) }
}
