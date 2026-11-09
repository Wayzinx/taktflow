import { createHmac } from 'node:crypto'
import { resolveSecret, type AutomationConfig, type AutomationDelivery, type AutomationRunRecord, type ChannelConfig } from '@taktflow/core'
import { createRedactor } from '@taktflow/harness'

export interface ChannelMessage { automation: Pick<AutomationConfig, 'id' | 'title'>; event?: AutomationRunRecord['event']; text: string; links: string[] }
export interface DeliveryOptions { now?: () => Date; wait?: (ms: number) => Promise<void> }
export async function sendToChannel(channel: ChannelConfig, message: ChannelMessage, fetcher: typeof fetch = fetch, options: DeliveryOptions = {}): Promise<AutomationDelivery> {
  const now = options.now ?? (() => new Date()), result: AutomationDelivery = { channel: channel.id, ok: false, at: now().toISOString() }
  const url = resolveSecret(channel.urlEnv), secret = channel.secretEnv ? resolveSecret(channel.secretEnv) : undefined
  if (!url || channel.secretEnv && !secret) return { ...result, error: '渠道地址或签名密钥缺失，请配置环境变量或本机密钥库' }
  const redact = createRedactor([url, ...(secret ? [secret] : [])])
  const safeError = (value: string) => redact(value).replace(/https?:\/\/[^\s"'<>]+/g, '[REDACTED]')
  try { if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error() }
  catch { return { ...result, error: '渠道地址格式不合法，请在密钥库填写 HTTP(S) 地址' } }
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    let payload: object
    if (channel.kind === 'feishu') {
      const timestamp = String(Math.floor(now().getTime() / 1000))
      payload = { msg_type: 'text', content: { text: message.text }, ...(secret ? { timestamp, sign: createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64') } : {}) }
    } else if (channel.kind === 'slack') payload = { text: message.text }
    else payload = { automation: message.automation, event: message.event ?? null, text: message.text, links: message.links }
    const body = JSON.stringify(payload)
    if (channel.kind === 'webhook' && secret) headers['X-Takt-Signature'] = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const operation = async () => {
        const response = await fetcher(url, { method: 'POST', headers, body, signal: controller.signal, redirect: 'error' })
        result.status = response.status
        if (!response.ok) throw new Error(`渠道返回 HTTP ${response.status}，请检查渠道配置后重试`)
        if (channel.kind === 'feishu') {
          const data = await response.json() as { code?: number; msg?: string }
          if (data.code !== 0) throw new Error(`飞书返回失败：${data.msg ?? '响应 code 不是 0'}，请检查机器人配置`)
        }
      }
      await Promise.race([operation(), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('渠道发送超过 10 秒，请检查网络后重试')) }, 10_000) })])
      return { ...result, ok: true, at: now().toISOString() }
    } catch (error) { result.error = safeError(error instanceof Error ? error.message : String(error)) }
    finally { clearTimeout(timer) }
    if (attempt === 0) await (options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(2000)
  }
  return { ...result, at: now().toISOString() }
}
