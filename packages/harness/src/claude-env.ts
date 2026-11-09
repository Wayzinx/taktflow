import type { HarnessRequest } from '@taktflow/core'

/**
 * Claude Code（CLI 与 ACP 适配）接另一家 anthropic-messages 协议的 API：地址、令牌、各档模型都指过去，不再用本机登录。
 * 本机登录、另一把 Anthropic key 会盖过 ANTHROPIC_AUTH_TOKEN，所以一并清空；后台小任务（起标题等）也走同一个模型。
 * 别家长输出比 Anthropic 慢，单次请求超时放到 10 分钟（DeepSeek 接入说明的建议值），调用方已设的不覆盖。
 */
export function claudeProviderEnv(req: HarnessRequest, token: string | undefined): Record<string, string> {
  const model = req.model
  return {
    ...(req.provider?.baseURL === undefined ? {} : { ANTHROPIC_BASE_URL: req.provider.baseURL }),
    ...(token === undefined ? {} : { ANTHROPIC_AUTH_TOKEN: token }),
    ANTHROPIC_API_KEY: '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    ...(model === undefined ? {} : {
      ANTHROPIC_MODEL: model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      ANTHROPIC_SMALL_FAST_MODEL: model,
    }),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ...(req.env?.API_TIMEOUT_MS ? {} : { API_TIMEOUT_MS: '600000' }),
  }
}
