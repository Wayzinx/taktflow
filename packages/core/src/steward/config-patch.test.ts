import { describe, expect, it } from 'vitest'
import { configPatchPreview, patchedConfig } from './config-patch.js'

describe('config.patch 基线与预览', () => {
  const config = { project: { name: '商店', color: 'blue' }, members: [{ id: 'a', name: 'a', role: 'owner' }, { id: 'b', name: '小 B', role: 'member' }], budget: { tokens: 10 } }

  it('基线只取补丁碰到的键：改别的键不影响', () => {
    const patch = { project: { name: '新名字' }, members: [] }
    expect(patchedConfig(config, patch)).toEqual({ project: { name: '商店' }, members: config.members })
    expect(patchedConfig({ ...config, budget: { tokens: 99 }, project: { ...config.project, color: 'red' } }, patch)).toEqual(patchedConfig(config, patch))
  })

  it('成员按 id 对齐：改角色列成一删一增，删除的成员单列，标量写成前后两行，null 是删除', () => {
    const body = configPatchPreview(config, { project: { name: '新名字', color: null }, members: [{ id: 'b', name: '小 B', role: 'maintainer' }] })
    expect(body.split('\n')).toEqual([
      '- project.name：商店',
      '+ project.name：新名字',
      '- project.color：blue',
      '@@ 成员（members） @@',
      '- b · 小 B · member',
      '+ b · 小 B · maintainer',
      '- a · owner',
    ])
  })

  it('密钥改了也要显示有变化，但值脱敏；没变化返回空串', () => {
    const body = configPatchPreview({ providers: { x: { apiKey: 'old' } } }, { providers: { x: { apiKey: 'new' } } })
    expect(body.split('\n')).toEqual(['- providers.x.apiKey：***', '+ providers.x.apiKey：***'])
    expect(configPatchPreview(config, { budget: { tokens: 10 } })).toBe('')
  })
})
