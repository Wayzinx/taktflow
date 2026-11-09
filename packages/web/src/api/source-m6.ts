import type { PairingInfo, RuntimeConfig, RuntimeConfigPatch, RuntimeTestRequest, RuntimeTestResult, SecretStatus } from '@taktflow/core'

/** 运行配置 PATCH 时 baseRevision 不一致（409）：别人刚改过，需要重新载入。 */
export class RuntimeConflictError extends Error {
  constructor(message = '运行配置刚被别人改过') {
    super(message)
  }
}

/** M6 接口：设置页「模型与 Harness」可编辑（docs/design/27 §4）。路由见 packages/core/src/api.ts 顶部的接口表。 */
export interface M6Source {
  runtimeConfig(): Promise<RuntimeConfig>
  /** 409 时抛 RuntimeConflictError；校验失败（400）的消息里指出字段与下一步。 */
  patchRuntime(patch: RuntimeConfigPatch): Promise<RuntimeConfig>
  /** 搭配矩阵：每个 harness × [自带, 各 provider] 能不能用、走直连还是协议桥（docs/design/31 §2）。 */
  pairings(): Promise<PairingInfo[]>
  /** provider 只列模型不计费；model / pairing 要 allowBilled；harness 跑可用性探测 / ACP 握手。 */
  testRuntime(body: RuntimeTestRequest): Promise<RuntimeTestResult>
  /** 存到本机密钥库；任何接口都不回传值。 */
  putSecret(name: string, value: string, reason: string): Promise<SecretStatus>
  deleteSecret(name: string, reason: string): Promise<SecretStatus>
}
