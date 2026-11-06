import type { AssetRef } from '../quality.js'
import { canonicalJson } from '../util/hash.js'
import { parseFrontmatter } from '../util/frontmatter.js'

export const RENDERER_VERSION = 'taktflow-prompt/1'
export const REVIEWER_TEMPLATE = [
  '评审第 {{round}} 轮。只读产物，不修改文件。',
  '被评审对象：{{target}}；路径与版本：{{materials}}',
  '参考依据：{{references}}', 'focus：{{focus}}', 'checklist：{{checklist}}', 'rubric：{{rubric}}',
  '已有问题清单（key、描述、状态）：{{existing}}',
  'issues[].key 只能引用清单中已有 key，或留空表示新问题；新 key 由系统分配。previous 对已有 key 逐条给出 resolved / still_open / not_checked 与依据，未提及不表示解决。',
  '上一轮该评审者的问题与作者回应：{{prior}}',
].join('\n')
export const AUTHOR_TEMPLATE = '按第 {{round}} 轮意见修改产物，每个问题恰好一条 responses，保留 reviewer、issueId、round。\n{{records}}\n{{extra}}\n人工意见：{{feedback}}'
export const RUBRIC_TEMPLATE = '按以下 rubric 检查并输出 score、pass、message：\n{{rubric}}'

export function renderTemplate(template: string, params: Record<string, unknown>): string {
  return template.replace(/\{\{([\w]+)\}\}/g, (_, key: string) => {
    if (!Object.hasOwn(params, key)) throw new Error(`渲染参数缺失：${key}`)
    const value = params[key]
    return typeof value === 'string' ? value : canonicalJson(value)
  })
}
export interface PromptParams {
  task: Record<string, unknown>
  knowledge: string[]
  workspace: string
  inputs: string[]
  outputs: string[]
  profileScope: string[]
  nodeScope: string[]
  schema?: Record<string, unknown>
  retryNote: string
  history: string
  profile: string
  duty?: string
  suffix?: string
  skills: string[]
}
export interface RenderAsset extends AssetRef { content: string }

/** 回放先按 AssetRef 替换正文，再用同一函数渲染；不读取文件、环境变量或当前 workflow。 */
export function renderRequest(template: string, params: PromptParams, assets: RenderAsset[]): { prompt: string; systemAppend: string } {
  const asset = (id: string) => {
    const found = assets.find((item) => item.id === id)
    if (!found) throw new Error(`缺少渲染资产：${id}`)
    return found.content
  }
  const task = { ...params.task, ...(params.duty ? JSON.parse(asset(params.duty)) as Record<string, unknown> : {}) }
  const prompt = [renderTemplate(typeof task.template === 'string' ? task.template : template, task) + (params.suffix ? renderTemplate(params.suffix, task) : ''), ...params.knowledge,
    `公共存放区：${params.workspace}，需要读的文件：${params.inputs.join(', ')}，需要产出的文件：${params.outputs.join(', ')}，写权限：角色 ${canonicalJson(params.profileScope)} 与节点 ${canonicalJson(params.nodeScope)} 的交集。`,
    params.schema ? `最后输出一个 \`\`\`json 代码块，满足：${canonicalJson(params.schema)}` : '',
    params.retryNote, params.history,
  ].filter(Boolean).join('\n\n')
  const profileText = asset(params.profile)
  let instructions: string
  try { instructions = (JSON.parse(profileText) as { instructions: string }).instructions } catch { instructions = parseFrontmatter(profileText).body.trim() }
  const systemAppend = [instructions, ...params.skills.map((id) => `提供的 Skill 资产 ${id}：\n${asset(id)}`)].filter(Boolean).join('\n\n')
  return { prompt, systemAppend }
}
