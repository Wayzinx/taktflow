import type { SpaceMember } from '@taktflow/core'
import { describe, expect, it } from 'vitest'
import { bindingUpdate, feishuDraft } from './feishu-draft.js'

const members: SpaceMember[] = [
  { id: 'me', name: '空间负责人', role: 'owner' },
  { id: 'qa', name: '测试同事', role: 'member' },
]
const saved = { chatId: 'oc_project', members: [{ openId: 'ou_me', memberId: 'me' }], revision: 'rev-1' }

describe('飞书绑定草稿', () => {
  it('新增和删除映射只发送当前草稿，保留基线版本', () => {
    const draft = feishuDraft(saved)
    draft.members.push({ key: 1, openId: ' ou_qa ', memberId: 'qa' })
    expect(bindingUpdate({ chatId: ' oc_project ', members: draft.members }, saved, members)).toEqual({
      update: { chatId: 'oc_project', baseRevision: 'rev-1', members: [...saved.members, { openId: 'ou_qa', memberId: 'qa' }] },
    })
    draft.members.shift()
    expect(bindingUpdate(draft, saved, members)).toEqual({
      update: { chatId: 'oc_project', baseRevision: 'rev-1', members: [{ openId: 'ou_qa', memberId: 'qa' }] },
    })
    expect(saved.members).toEqual([{ openId: 'ou_me', memberId: 'me' }])
  })

  it('首次绑定使用 null 作为基线', () => {
    expect(bindingUpdate({ ...feishuDraft(null), chatId: 'oc_project' }, null, members)).toEqual({
      update: { chatId: 'oc_project', baseRevision: null, members: [] },
    })
  })

  it('拒绝群链接、无效或重复的 Open ID、无效成员', () => {
    const draft = feishuDraft(saved)
    expect(bindingUpdate({ ...draft, chatId: 'https://example.test/group' }, saved, members)).toHaveProperty('error', expect.stringContaining('群 ID'))
    expect(bindingUpdate({ ...draft, members: [{ key: 0, openId: 'user_id', memberId: 'me' }] }, saved, members)).toHaveProperty('error', expect.stringContaining('Open ID'))
    expect(bindingUpdate(draft, saved, [])).toHaveProperty('error', expect.stringContaining('当前空间成员'))
    draft.members.push({ key: 1, openId: ' ou_me ', memberId: 'qa' })
    expect(bindingUpdate(draft, saved, members)).toHaveProperty('error', expect.stringContaining('已有映射'))
  })
})
