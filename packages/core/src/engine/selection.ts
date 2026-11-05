import type { AgentProfile, HarnessAdapter, HarnessCapabilities, HarnessRequest, HarnessSelector, ModelConfig, NodeDef, ProviderProtocol, TaktConfig, WorkflowDefinition } from '../types.js'


export interface SelectionContext {
  config: TaktConfig
  profiles: Record<string, AgentProfile>
  harnesses: Record<string, HarnessAdapter>
}

export function harnessSelectors(selector: HarnessSelector): HarnessSelector[] {
  return [selector, ...(selector.fallback ?? []).flatMap(harnessSelectors)]
}

export function selectHarness(role: string, selector: HarnessSelector | undefined, context: SelectionContext, override?: string): HarnessSelector {
  const profile = context.profiles[role]
  if (!profile) throw new Error(`角色不存在：${role}`)
  const base = selector ?? profile.harness ?? context.config.roles?.[role] ?? { harness: 'mock' }
  return override ? { ...base, harness: override, fallback: undefined } : base
}

export function resolveHarnessSelector(selector: HarnessSelector, config: TaktConfig, harnesses: Record<string, HarnessAdapter>): {
  harness: HarnessAdapter; model?: string; provider?: HarnessRequest['provider']; modelConfig?: ModelConfig
} {
  const harness = Object.hasOwn(harnesses, selector.harness) ? harnesses[selector.harness] : undefined
  if (!harness) throw new Error(`harness 不存在：${selector.harness}`)
  const alias = selector.model && config.models && Object.hasOwn(config.models, selector.model) ? config.models[selector.model] : undefined
  const model = alias?.id ?? selector.model
  const providerId = selector.provider ?? alias?.provider
  const provider = providerId !== undefined && config.providers && Object.hasOwn(config.providers, providerId) ? config.providers[providerId] : undefined
  if (providerId !== undefined && !provider) throw new Error(`provider 不存在：${providerId}`)
  const capabilities: HarnessCapabilities = harness.capabilities ?? {}
  if (provider && !capabilities.customProvider) throw new Error(`harness ${selector.harness} 不支持 customProvider`)
  if (provider && capabilities.providerProtocols && !capabilities.providerProtocols.includes(provider.protocol)) {
    throw new Error(`harness ${selector.harness} 不支持 provider 协议 ${provider.protocol}；支持：${capabilities.providerProtocols.join(' / ')}`)
  }
  if (capabilities.requiresProvider && !model?.trim()) throw new Error(`harness ${selector.harness} 需要非空模型`)
  if (capabilities.requiresProvider && !provider) throw new Error(`harness ${selector.harness} 需要明确 provider 或模型别名`)
  let modelConfig = alias?.provider === providerId ? alias : undefined
  if (!modelConfig) {
    const matching = Object.values(config.models ?? {}).filter((entry) => entry.provider === providerId && entry.id === model)
    if (matching.length === 1) modelConfig = matching[0]
  }
  return { harness, model, provider: provider ? { ...provider, id: providerId! } : undefined, modelConfig }
}

export function validateHarnessSelector(selector: HarnessSelector, config: TaktConfig, harnesses: Record<string, HarnessAdapter>): void {
  for (const candidate of harnessSelectors(selector)) resolveHarnessSelector(candidate, config, harnesses)
}

export function forEachRoleSelector(workflow: WorkflowDefinition, check: (role: string, selector?: HarnessSelector) => void): void {
  const visit = (nodes: NodeDef[]): void => {
    for (const node of nodes) {
      if (node.kind === 'agent' || node.kind === 'judge' || node.kind === 'planner') check(node.role, node.harness)
      else if (node.kind === 'review') { check(node.author.role, node.author.harness); for (const reviewer of node.reviewers) check(reviewer.role, reviewer.harness) }
      else if (node.kind === 'gate') { for (const item of node.checks) { if (item.kind === 'rubric') check(item.role) } }
      else if (node.kind === 'loop') visit(node.body)
      else if (node.kind === 'subflow') visit(node.workflow.nodes)
    }
  }
  visit(workflow.nodes)
}

export function validateWorkflowHarnesses(workflow: WorkflowDefinition, context: SelectionContext, override?: string): void {
  forEachRoleSelector(workflow, (role, selector) => validateHarnessSelector(selectHarness(role, selector, context, override), context.config, context.harnesses))
}
