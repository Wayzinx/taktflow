import { explicitRoleHarness } from '../store/role-profile.js'
import type { AgentProfile, HarnessAdapter, HarnessCapabilities, HarnessRequest, HarnessSelector, ModelConfig, Pairing, ProviderBridge, NodeDef, ProviderConfig, ProviderProtocol, TaktConfig, WorkflowDefinition } from '../types.js'


export interface SelectionContext {
  bridge?: ProviderBridge
  config: TaktConfig
  profiles: Record<string, AgentProfile>
  harnesses: Record<string, HarnessAdapter>
}

/** provider 提供的全部协议：主协议在前，再是 endpoints 里的。 */
export function providerProtocols(provider: ProviderConfig): ProviderProtocol[] {
  return [...new Set([provider.protocol, ...Object.keys(provider.endpoints ?? {})])]
}

/** 直连按 harness 的协议偏好；桥接按 provider 的主协议优先。 */
export function providerFor(provider: ProviderConfig, accepts?: readonly ProviderProtocol[]): ProviderConfig | undefined {
  const protocol = (accepts ?? [provider.protocol]).find(p => p === provider.protocol || provider.endpoints?.[p])
  return protocol ? protocol === provider.protocol ? provider : { ...provider, protocol, baseURL: provider.endpoints![protocol] } : undefined
}

export function resolvePairing(capabilities: HarnessCapabilities, provider: ProviderConfig | undefined, bridge?: ProviderBridge): { pairing?: Pairing; target?: ProviderConfig; reason?: string } {
  if (!provider) return capabilities.requiresProvider ? { reason: '需要明确 provider 或模型别名' } : { pairing: { mode: 'builtin' } }
  if (!capabilities.customProvider) return { reason: '不支持 customProvider，该 harness 只能用自带模型' }
  const target = providerFor(provider, capabilities.providerProtocols)
  if (target) return { pairing: { mode: 'direct', protocol: target.protocol }, target }
  for (const upstream of providerProtocols(provider)) {
    for (const protocol of capabilities.providerProtocols ?? []) {
      if (bridge?.supports(protocol, upstream)) return { pairing: { mode: 'bridge', protocol, upstream }, target: providerFor(provider, [upstream]) }
    }
  }
  return { reason: `不支持 provider 协议 ${providerProtocols(provider).join(' / ')}；支持：${capabilities.providerProtocols?.join(' / ') || '无'}` }
}

export function harnessSelectors(selector: HarnessSelector): HarnessSelector[] {
  return [selector, ...(selector.fallback ?? []).flatMap(harnessSelectors)]
}

export function selectHarness(role: string, selector: HarnessSelector | undefined, context: SelectionContext, override?: string): HarnessSelector {
  const profile = context.profiles[role]
  if (!profile) throw new Error(`角色不存在：${role}`)
  const base = selector ?? explicitRoleHarness(profile) ?? context.config.roles?.[role] ?? { harness: 'mock' }
  return override ? { ...base, harness: override, fallback: undefined } : base
}

export function resolveHarnessSelector(selector: HarnessSelector, config: TaktConfig, harnesses: Record<string, HarnessAdapter>, bridge?: ProviderBridge): {
  harness: HarnessAdapter; model?: string; provider?: HarnessRequest['provider']; modelConfig?: ModelConfig; pairing?: Pairing
} {
  const harness = Object.hasOwn(harnesses, selector.harness) ? harnesses[selector.harness] : undefined
  if (!harness) throw new Error(`harness 不存在：${selector.harness}`)
  const alias = selector.model && config.models && Object.hasOwn(config.models, selector.model) ? config.models[selector.model] : undefined
  const model = alias?.id ?? selector.model
  const providerId = selector.provider ?? alias?.provider
  const configured = providerId !== undefined && config.providers && Object.hasOwn(config.providers, providerId) ? config.providers[providerId] : undefined
  if (providerId !== undefined && !configured) throw new Error(`provider 不存在：${providerId}`)
  const capabilities: HarnessCapabilities = harness.capabilities ?? {}
  const { pairing, target: provider, reason } = resolvePairing(capabilities, configured, bridge)
  if (reason) throw new Error(`harness ${selector.harness} ${providerId && reason.includes('；支持：') ? reason.replace('；支持：', `（${providerId}）；支持：`) : reason}`)
  if (capabilities.requiresProvider && !model?.trim()) throw new Error(`harness ${selector.harness} 需要非空模型`)
  let modelConfig = alias?.provider === providerId ? alias : undefined
  if (!modelConfig) {
    const matching = Object.values(config.models ?? {}).filter((entry) => entry.provider === providerId && entry.id === model)
    if (matching.length === 1) modelConfig = matching[0]
  }
  return { harness, model, pairing, provider: provider ? { ...provider, id: providerId! } : undefined, modelConfig }
}

export function validateHarnessSelector(selector: HarnessSelector, config: TaktConfig, harnesses: Record<string, HarnessAdapter>, bridge?: ProviderBridge): void {
  for (const candidate of harnessSelectors(selector)) resolveHarnessSelector(candidate, config, harnesses, bridge)
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
  forEachRoleSelector(workflow, (role, selector) => validateHarnessSelector(selectHarness(role, selector, context, override), context.config, context.harnesses, context.bridge))
}
