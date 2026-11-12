/**
 * harness 调用期的环境类失败：登录 / 密钥、额度与限流、服务过载、进程起不来、超时。
 * 换一个 harness 可能就能继续，所以按角色的 fallback 链切换；产物、完成标准、判决这类失败不在此列。
 */
const SETTINGS = '「空间设置 › 模型与 Harness」'
const KINDS: Array<[RegExp, string, string]> = [
  [/failed to authenticate|authentication[_\s-]?(?:error|failed|required)|\boauth|unauthori[sz]ed|\b401\b|\bsign[\s-]?in\b|not logged in|log[\s-]?in required|invalid (?:api[\s_-]?key|x-api-key|credentials?)|missing api[\s_-]?key|api[\s_-]?key (?:is )?(?:missing|invalid|not set)|登录已?过期|未登录|请先?登录|认证失败|鉴权失败/i,
    '登录或认证失败', `在本机重新登录该 harness，或到${SETTINGS}检查密钥；也可以给角色配置 fallback 换一个 harness`],
  [/\b429\b|rate[\s_-]?limit|quota|usage limit|额度|限流/i, '额度用完或被限流', `稍后重试，或到${SETTINGS}给角色换一个 harness / 模型`],
  [/\b5(?:02|03|29)\b|overloaded|service unavailable|bad gateway/i, '服务暂不可用', `稍后重试，或到${SETTINGS}给角色换一个 harness / 模型`],
  [/Process error:|Process setup failed|\bspawn\b.*\b(?:ENOENT|EACCES)\b|command not found/i, '进程启动失败', `检查该 harness 是否已安装、可执行，${SETTINGS}会标出不可用的 harness`],
  [/timeout|timed out/i, '调用超时', '稍后重试，或调大节点的 timeoutMs'],
]
const HINT = '\n处理建议：'

/** 环境类失败的类别；不是环境问题（含业务失败）时返回 undefined。 */
export function harnessEnvFailure(message: string): string | undefined {
  if (/(?:^|\n)(?:用例|测试|断言|AssertionError\b|test (?:case|failed)\b)/i.test(message)) return undefined
  return KINDS.find(([pattern]) => pattern.test(message))?.[1]
}

const hintFor = (kind: string) => KINDS.find(([, label]) => label === kind)?.[2] ?? `到${SETTINGS}检查 harness`

/** 整条 fallback 链都没接住时，在报错后面接上给人的下一步。 */
export function withEnvHint(message: string, kind: string): string {
  return `${message}${HINT}${hintFor(kind)}`
}

/** 拆开报错原文和处理建议：群聊这类只放一句话的地方分开排版。 */
export function envFailureOf(message: string): { cause: string; kind?: string; hint?: string } {
  const at = message.indexOf(HINT)
  const cause = at < 0 ? message : message.slice(0, at)
  const kind = harnessEnvFailure(cause)
  return { cause, kind, hint: kind && hintFor(kind) }
}
