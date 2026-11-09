/**
 * 外层 Claude Code 会话写给子进程的标记：会话 id、父子关系、消息通道和它的令牌、本会话的 effort。
 * taktflow 起的 agent 和脚本是独立的，继承这些会被当成外层会话的子会话，还能拿令牌连外层的消息通道。
 */
export const HOST_SESSION_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PID', 'CLAUDE_EFFORT'] as const

/** 本机直接起子进程时的环境：继承当前进程，去掉外层会话标记，再盖上调用方给的（显式给了就按给的）。 */
export function childEnv(env?: Record<string, string>): NodeJS.ProcessEnv {
  const inherited = { ...process.env }
  for (const key of HOST_SESSION_ENV) delete inherited[key]
  return { ...inherited, ...env }
}
