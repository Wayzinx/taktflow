import type { SpaceMember, Viewer } from '@taktflow/core'

/** 设置页的前端规则：表单即时校验（与服务端一致，不合法时返回一句给人看的原因，undefined 表示没问题）和按角色只读。 */

const RANK: Record<SpaceMember['role'], number> = { viewer: 0, member: 1, maintainer: 2, owner: 3 }

/**
 * 当前身份（GET /me）能不能做需要 min 角色的修改；不能时给出原因。
 * 身份未确认时保持只读，不能在加载或请求失败时临时开放编辑。
 */
export function accessOf(me: Viewer | undefined, min: SpaceMember['role'], what: string): { ok: boolean; why?: string } {
  if (!me) return { ok: false, why: '尚未确认当前身份，暂时只能查看；身份加载失败时请重新载入页面。' }
  const role = me.member?.role
  if (role && RANK[role] >= RANK[min]) return { ok: true }
  const need = min === 'owner' ? 'owner' : `${min} 及以上`
  const who = role === 'viewer' ? '你是 viewer' : role ? `你（${me.name}）在这个空间是 ${role}` : `你（${me.name}）不是这个空间的成员`
  return { ok: false, why: `${who}，只能查看；${what}需要 ${need}，请找 owner 调整你的角色。` }
}

// 字符规则同 packages/core/src/store/paths.ts 的 SAFE_ID（服务端用它校验成员 id）；再限 64 个字符，免得长 id 撑破成员行
export const MEMBER_ID_MAX = 64
export const MEMBER_ID_RULE = `只能用字母、数字和 . _ -，以字母或数字开头，最多 ${MEMBER_ID_MAX} 个字符`

/** 列出 id 里不允许的字符（空白写成"空格"、汉字写成"中文"），多于 5 个时后面写"等"。 */
function badChars(s: string, allowed: RegExp): string {
  const bad = [...new Set([...s.replace(allowed, '')].map((c) => (/\s/.test(c) ? '空格' : /\p{Script=Han}/u.test(c) ? '中文' : c)))]
  return bad.slice(0, 5).join(' ') + (bad.length > 5 ? ' 等' : '')
}

export function memberIdError(raw: string, taken: string[]): string | undefined {
  const id = raw.trim()
  if (!id) return
  if (taken.includes(id)) return `${id} 已经是成员了。`
  const bad = badChars(id, /[A-Za-z0-9._-]/g)
  if (bad) return `成员 id 不能包含 ${bad}；${MEMBER_ID_RULE}。中文名请填在“显示名”里。`
  if (!/^[A-Za-z0-9]/.test(id)) return `成员 id 要以字母或数字开头；${MEMBER_ID_RULE}。`
  if (id.length > MEMBER_ID_MAX) return `成员 id 最多 ${MEMBER_ID_MAX} 个字符，现在 ${id.length} 个。`
}

// 职责标签只在前端约束（服务端接受任意非空字符串），这里是唯一的规则
export const DUTY_RE = /^[a-z][a-z0-9-]{0,15}$/
export const DUTY_RULE = '职责用小写字母开头，只能含小写字母、数字和 -，最多 16 位'

export function dutyError(raw: string, existing: string[]): string | undefined {
  const t = raw.trim().toLowerCase()
  if (!t) return
  if (existing.includes(t)) return `已经有职责 ${t} 了`
  if (!DUTY_RE.test(t)) return `${DUTY_RULE}（例如 rd、qa、front-end）`
}

/** 同服务端 runtime-config 的 httpURL：http / https，不能带用户名密码或 # 片段。 */
export function baseUrlError(raw: string): string | undefined {
  const s = raw.trim()
  if (!s) return
  let url: URL
  try {
    url = new URL(s)
  } catch {
    return '需要以 http:// 或 https:// 开头的完整地址，例如 https://api.deepseek.com/v1'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return `只支持 http:// 或 https:// 地址，不能用 ${url.protocol}//`
  if (url.username || url.password) return '地址里不能带用户名或密码；密钥填在下面的环境变量里'
  if (url.hash) return '地址不能带 # 片段'
}

// 同服务端 agent-routes 的 roleId
export const ROLE_ID = /^[a-z][a-z0-9-]{0,39}$/
export const ROLE_ID_RULE = '用小写字母开头，只能含小写字母、数字和 -，最多 40 位'
// 技能名同服务端 spaceFile 的 safeId
export const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
export const SKILL_NAME_RULE = '只能用字母、数字和 . _ -，以字母或数字开头'

export function newFileNameError(kind: 'skill' | 'agent', raw: string, taken: string[]): string | undefined {
  const name = raw.trim()
  if (!name) return kind === 'skill' ? '先填技能名' : '先填角色 id'
  if (taken.includes(name)) return `已经有 ${name} 了，直接在列表里选它编辑`
  if (kind === 'skill' ? !SKILL_NAME.test(name) : !ROLE_ID.test(name)) return `${kind === 'skill' ? '技能名' : '角色 id'}${kind === 'skill' ? SKILL_NAME_RULE : ROLE_ID_RULE}`
}
