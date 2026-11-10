import { resolvePairing, type HarnessInfo, type PairingInfo, type ProviderBridge, type TaktConfig } from '@taktflow/core'
import { providerConfig } from '@taktflow/harness'

export function pairingMatrix(config: TaktConfig, harnesses: HarnessInfo[], bridge?: ProviderBridge): PairingInfo[] {
  const providers = Object.entries(config.providers ?? {}).filter(([id]) => {
    const models = Object.values(config.models ?? {}).filter(model => model.provider === id)
    return !models.length || models.some(model => model.kind !== 'embedding')
  }).map(([id, provider]) => ({ id, config: providerConfig(id, provider) }))
  return harnesses.flatMap(harness => [undefined, ...providers].map(provider => {
    const row = { harness: harness.id, provider: provider?.id ?? null }
    if (!harness.available) return { ...row, status: 'unavailable' as const, reason: harness.reason ?? 'Harness 不可用' }
    if (!provider && harness.ownReady === false) return { ...row, status: 'unavailable' as const, reason: harness.ownReason ?? '自带账号未就绪' }
    const { pairing, reason } = resolvePairing(harness.capabilities, provider?.config, bridge)
    return pairing ? { ...row, status: pairing.mode, protocol: pairing.protocol, upstream: pairing.upstream,
      ...(pairing.mode === 'bridge' ? { reason: '经协议桥转换；托管工具不可用' } : {}) } : { ...row, status: 'unavailable' as const, reason }
  }))
}
