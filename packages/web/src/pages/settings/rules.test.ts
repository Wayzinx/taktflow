import { describe, expect, it } from 'vitest'
import { assertRequirementId, type Viewer } from '@taktflow/core'
import { accessOf, baseUrlError, dutyError, memberIdError, newFileNameError } from './rules'

// 服务端成员 id 目前复用 SAFE_ID（packages/core/src/store/paths.ts）；前端字符规则必须和它一致
const serverAccepts = (id: string) => {
  try {
    assertRequirementId(id)
    return true
  } catch {
    return false
  }
}

describe('成员 id 即时校验（TF-023 / TF-024）', () => {
  it('中文、空格、HTML 片段当场给出原因，不等提交后被服务端整批拒绝', () => {
    expect(memberIdError('QA-admin-测试 成员', [])).toMatch(/不能包含 中文 空格；/)
    expect(memberIdError(`QA-admin-<b>x</b>&"'`, [])).toMatch(/不能包含 < > \/ & " 等；/)
    expect(memberIdError('QA-admin-测试', [])).toContain('显示名')
  })
  it('开头、长度、重复各有各的说法', () => {
    expect(memberIdError('-zhang', [])).toMatch(/以字母或数字开头/)
    expect(memberIdError('x'.repeat(65), [])).toMatch(/最多 64 个字符，现在 65 个/)
    expect(memberIdError('x'.repeat(64), [])).toBeUndefined()
    expect(memberIdError(' demo-owner ', ['demo-owner'])).toBe('demo-owner 已经是成员了。')
    expect(memberIdError('   ', [])).toBeUndefined()
  })
  it('字符规则与服务端一致：前端放行的服务端都收，前端拦的服务端也拒', () => {
    const samples = ['zhang', 'QA-admin-01', 'a.b_c-d', '9lives', '_x', '.x', 'a b', 'a/b', '张三', 'a　b', 'emoji😀', 'x'.repeat(64)]
    for (const s of samples) expect(memberIdError(s, []) === undefined, s).toBe(serverAccepts(s))
  })
})

describe('职责标签（TF-081）', () => {
  it('不合法时写出规则；大写转小写不算错', () => {
    expect(dutyError('中文职责', [])).toMatch(/小写字母开头.*最多 16 位/)
    expect(dutyError('QA', [])).toBeUndefined()
    expect(dutyError('rd', ['rd'])).toBe('已经有职责 rd 了')
    expect(dutyError('a'.repeat(17), [])).toBeDefined()
    expect(dutyError('', [])).toBeUndefined()
  })
})

describe('provider 地址（TF-082）', () => {
  it('同服务端 httpURL：只收 http(s)，不带凭据和 # 片段', () => {
    expect(baseUrlError('not a url')).toMatch(/http:\/\/ 或 https:\/\//)
    expect(baseUrlError('ftp://example.com')).toMatch(/不能用 ftp:\/\//)
    expect(baseUrlError('https://u:p@example.com/v1')).toMatch(/用户名或密码/)
    expect(baseUrlError('https://example.com/v1#x')).toMatch(/# 片段/)
    expect(baseUrlError('https://api.deepseek.com/v1')).toBeUndefined()
    expect(baseUrlError('http://localhost:11434/v1')).toBeUndefined()
    expect(baseUrlError('')).toBeUndefined()
  })
})

describe('新建技能 / 角色的名字（TF-051）', () => {
  it('技能名同 safeId，角色 id 同服务端 roleId', () => {
    expect(newFileNameError('skill', 'PR-review.v2', [])).toBeUndefined()
    expect(newFileNameError('skill', '评审', [])).toMatch(/技能名只能用/)
    expect(newFileNameError('agent', 'designer', [])).toBeUndefined()
    expect(newFileNameError('agent', 'Designer', [])).toMatch(/小写字母开头/)
    expect(newFileNameError('agent', 'dev', ['dev'])).toMatch(/已经有 dev/)
    expect(newFileNameError('skill', '', [])).toBe('先填技能名')
  })
})

describe('按当前身份只读（TF-050）', () => {
  const me = (role?: 'owner' | 'maintainer' | 'member' | 'viewer'): Viewer => ({ id: 'qa', name: 'QA-admin-01', ...(role ? { member: { id: 'qa', name: 'QA-admin-01', role } } : {}) })
  it('viewer 改成员：只读，并写出真正需要的角色', () => {
    const a = accessOf(me('viewer'), 'owner', '改成员')
    expect(a.ok).toBe(false)
    expect(a.why).toBe('你（QA-admin-01）在这个空间是 viewer，只能查看；改成员需要 owner，请找 owner 调整你的角色。')
  })
  it('门槛按角色高低比较；不是成员也只读', () => {
    expect(accessOf(me('owner'), 'owner', 'x').ok).toBe(true)
    expect(accessOf(me('maintainer'), 'maintainer', 'x').ok).toBe(true)
    expect(accessOf(me('member'), 'maintainer', '改技能').why).toContain('需要 maintainer 及以上')
    expect(accessOf(me(), 'owner', 'x').why).toContain('不是这个空间的成员')
  })
  it('身份未确认时保持只读，避免加载或请求失败时开放编辑', () => {
    expect(accessOf(undefined, 'owner', 'x')).toMatchObject({ ok: false, why: expect.stringContaining('尚未确认当前身份') })
  })
})
