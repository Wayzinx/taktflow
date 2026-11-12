/**
 * 认证 / 环境 / 模型配置类失败：原样重试同一个节点大概率还是失败，恢复条要先引导去检查 harness 设置。
 * 只做展示分类，不改运行状态。
 */
const ENV_FAILURE =
  /authenticate|authentication|oauth|login|log in|unauthorized|credential|api[-_ ]?key|session expired|token (?:expired|invalid)|command not found|not installed|ENOENT|ECONNREFUSED|ETIMEDOUT|quota|rate limit|harness|登录|认证|凭证|配额|限流|模型配置/i

export function isEnvFailure(error?: string): boolean {
  return !!error && ENV_FAILURE.test(error)
}
