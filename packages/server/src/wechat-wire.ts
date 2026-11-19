import { randomBytes } from 'node:crypto'

/** Tencent iLink personal WeChat protocol. The official QR flow supplies these
 * fields in openclaw-weixin/accounts/<accountId>.json. */
export interface WeChatAccount { userId: string; token: string; baseUrl?: string }
export interface WeChatTurn { id: string; text: string; context: string }
export class WeChatTransportError extends Error {
  constructor(readonly retryable: boolean, message: string) { super(message) }
}

export function wechatClient(account: WeChatAccount, fetcher: typeof fetch, signal: AbortSignal) {
  const base = new URL(account.baseUrl || 'https://ilinkai.weixin.qq.com')
  if (base.protocol !== 'https:' || !/(^|\.)(weixin\.qq\.com|wechat\.com)$/.test(base.hostname) ||
      base.port || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('微信账号没有有效的腾讯 HTTPS 服务地址')
  }
  const post = async (path: string, body: object) => {
    let response: Response
    let raw: string
    try {
      response = await fetcher(new URL('/ilink/bot/' + path, base), {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
        headers: { 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token', Authorization: 'Bearer ' + account.token,
          'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '256',
          'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64') },
        body: JSON.stringify({ ...body, base_info: { channel_version: '0.1.0', bot_agent: 'Taktflow' } }),
      })
      raw = await response.text()
    } catch { throw new WeChatTransportError(true, '腾讯微信连接中断') }
    if (!response.ok) throw new WeChatTransportError(response.status >= 500 || [408, 429].includes(response.status), '腾讯微信 HTTP ' + response.status)
    // iLink message_id is uint64. Skip quoted strings while protecting large
    // integer tokens from precision loss on all supported Node versions.
    const result = JSON.parse(raw.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token =>
      /^\d{16,}$/.test(token) ? JSON.stringify(token) : token))
    if (!result || typeof result !== 'object') throw new Error('腾讯微信响应格式不正确')
    const code = result.errcode || result.ret
    if (code) throw new WeChatTransportError(false, '腾讯微信返回错误码 ' + Number(code))
    return result
  }
  return {
    async poll(cursor: string): Promise<{ cursor: string; turns: WeChatTurn[] }> {
      const result = await post('getupdates', { get_updates_buf: cursor })
      const turns: WeChatTurn[] = []
      for (const msg of result.msgs ?? []) {
        if (msg.message_type !== 1 || msg.group_id || msg.from_user_id !== account.userId ||
            typeof msg.context_token !== 'string' || !msg.context_token) continue
        const id = msg.message_id ?? msg.client_id
        if ((typeof id !== 'string' && !Number.isSafeInteger(id)) || !String(id).trim()) continue
        const text = (Array.isArray(msg.item_list) ? msg.item_list : [])
          .filter((item: { type?: number }) => item?.type === 1)
          .map((item: { text_item?: { text?: string } }) => typeof item.text_item?.text === 'string' ? item.text_item.text : '')
          .join('\n').trim()
        if (text && text.length <= 32000) turns.push({ id: String(id), text, context: msg.context_token })
      }
      return { cursor: result.get_updates_buf ?? cursor, turns }
    },
    reply(turn: WeChatTurn, clientId: string, text: string) {
      return post('sendmessage', { msg: { from_user_id: '', to_user_id: account.userId, client_id: clientId,
        message_type: 2, message_state: 2, context_token: turn.context, item_list: [{ type: 1, text_item: { text } }] } })
    },
  }
}
