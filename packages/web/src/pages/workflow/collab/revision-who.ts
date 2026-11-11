import type { Actor, WorkflowRevision } from '@taktflow/core'

/**
 * 修订是谁改的（docs/design/16 §修订）。存下来的 author 是落盘那一刻的操作者：
 * 管家提案由批准的人落盘，author 是批准人；绕过平台直接改文件的，平台只知道「外部」。
 * 这里把它还原成人能读懂的身份：管家起草、谁批准；外部修改说明为什么不知道是谁。
 */
export interface RevisionAuthor {
  kind: 'steward' | 'human' | 'agent' | 'external' | 'system'
  name: string
  /** 名字后面的补充：谁批准的提案、外部修改是什么 */
  note?: string
  /** 去掉提案编号和会话链接后的原因 */
  reason?: string
  /** 起草这条修订的管家会话 */
  thread?: string
  actor: Actor
}

// 格式由 core/src/steward/proposals.ts 写入：「管家提案 <id>：<标题> /solo?thread=<会话>」「撤销管家提案 <id>：<原因>」
const PROPOSAL = /^(撤销)?管家提案 [\w-]+：([\s\S]*?)(?: \/solo\?thread=([\w-]+))?$/

export function revisionAuthor(r: Pick<WorkflowRevision, 'author' | 'reason'>, person: (id: string) => string): RevisionAuthor {
  const a = r.author
  const proposal = r.reason?.match(PROPOSAL)
  if (a.type === 'human' && proposal && !proposal[1]) return { kind: 'steward', name: '管家', note: `${person(a.id)}批准`, reason: proposal[2], thread: proposal[3], actor: a }
  if (a.type === 'human') return { kind: 'human', name: person(a.id), reason: proposal ? `撤销管家提案：${proposal[2]}` : r.reason, actor: a }
  if (a.type === 'agent' && a.harness === 'external') return { kind: 'external', name: '外部修改', note: '直接改了文件，不经平台', reason: '有人或工具绕过平台直接改了这个文件（编辑器、git、脚本），平台记不到是谁。', actor: a }
  if (a.type === 'agent') return { kind: 'agent', name: a.role === 'lead' ? 'Lead' : `Agent ${a.role}`, reason: r.reason, actor: a }
  return { kind: 'system', name: a.id, note: '系统', reason: r.reason, actor: a }
}
