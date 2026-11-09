import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveHarnessSelector, resolveSecret, type HarnessAdapter, type ProviderBridge, type RuntimeTestRequest, type RuntimeTestResult, type TaktConfig, type BridgeRoute, type Pairing } from '@taktflow/core'
import { collectSecrets, createRedactor, withProviderPresets } from '@taktflow/harness'
import { HttpError } from './http.js'

export async function testPairing(config: TaktConfig, request: RuntimeTestRequest, harnesses: () => Promise<Record<string, HarnessAdapter>>, bridge?: ProviderBridge): Promise<RuntimeTestResult> {
  if (request.allowBilled !== true) throw new HttpError(400, '搭配测试会计费；请显式设置 allowBilled: true')
  const target = request.target
  if (target.kind !== 'pairing' || typeof target.harness !== 'string' || !target.harness.trim()) throw new HttpError(400, '请填写 harness')
  if ([target.model, target.provider].some(v => v !== undefined && (typeof v !== 'string' || !v.trim()))) throw new HttpError(400, 'model/provider 必须是非空字符串')
  const started = Date.now(), controller = new AbortController()
  let directory: string | undefined, route: BridgeRoute | undefined, billed = false, timer: ReturnType<typeof setTimeout> | undefined
  let pairing: Pairing | undefined
  let redact = createRedactor(collectSecrets(undefined, config.providers))
  const result = (ok: boolean, message: string, detail?: string) => ({ ok, message: redact(message), detail: detail ? redact(detail) : pairing ? JSON.stringify({ pairing, usage: null }) : undefined, billed, latencyMs: Date.now() - started })
  try {
    if (config.harnessOverrides?.[target.harness]?.disabled) return result(false, '本空间已停用')
    const normalized = withProviderPresets(config)
    const selected = resolveHarnessSelector(target, normalized, await harnesses(), bridge)
    pairing = selected.pairing
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('搭配测试超过 120 秒')) }, 120_000)
    })
    const available = await Promise.race([selected.harness.available(), deadline])
    if (!available.ok) return result(false, available.reason ?? 'Harness 不可用')
    directory = await mkdtemp(join(tmpdir(), 'takt-pairing-'))
    let provider = selected.provider
    const env: Record<string, string> = {}
    if (selected.pairing?.mode === 'bridge') {
      route = await bridge!.open(provider!, selected.pairing.protocol!, { model: selected.model, signal: controller.signal })
      provider = route.provider; Object.assign(env, route.env)
    } else if (provider?.apiKeyEnv) {
      const key = resolveSecret(provider.apiKeyEnv)
      if (!key) return result(false, `缺少密钥 ${provider.apiKeyEnv}`)
      env[provider.apiKeyEnv] = key
    }
    const req = { prompt: '只回复 OK', cwd: directory, readOnly: true, tools: { writeScope: [], allowBash: false }, model: selected.model, modelConfig: selected.modelConfig, provider, env, signal: controller.signal, timeoutMs: 120_000 }
    redact = createRedactor(collectSecrets(req, config.providers))
    billed = true
    const output = await Promise.race([selected.harness.run(req, () => {}), deadline])
    const ok = output.ok && output.finalText.trim() === 'OK'
    // 公共 RuntimeTestResult 暂无 pairing/usage 字段，使用 detail 承载摘要，不扩展协议。
    return result(ok, ok ? '搭配最小任务成功' : output.error ?? '搭配未返回 OK', JSON.stringify({ pairing: selected.pairing, usage: output.usage ?? null }))
  } catch (error) { return result(false, error instanceof Error ? error.message : '搭配测试失败') }
  finally { clearTimeout(timer); controller.abort(); await route?.close(); if (directory) await rm(directory, { recursive: true, force: true }) }
}
