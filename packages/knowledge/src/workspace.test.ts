import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWorkspaceSource } from './workspace.js'

let taktDir: string
async function page(path: string, content = '# 退款规则\n\n订单退款在三个工作日到账。') {
  await mkdir(join(taktDir, path, '..'), { recursive: true })
  await writeFile(join(taktDir, path), content)
}

beforeEach(async () => { taktDir = await mkdtemp(join(tmpdir(), 'takt-workspace-')) })
afterEach(async () => { await rm(taktDir, { recursive: true, force: true }) })

describe('Workspace 检索', () => {
  it('仅检索每个需求的 spec、decisions、reports Markdown，ref 为 REQ/path', async () => {
    const included = ['REQ-001/spec/rules.md', 'REQ-001/decisions/nested/adr.md', 'REQ-002/reports/result.MD']
    for (const ref of included) await page(`workspaces/${ref}`)
    for (const path of [
      'spec/outside.md', 'workspaces/root.md', 'workspaces/REQ-001/root.md',
      'workspaces/REQ-001/tests/test.md', 'workspaces/REQ-001/design/spec/hidden.md',
      'workspaces/REQ-001/reports-other/result.md', 'workspaces/REQ-001/spec/data.json',
      'workspaces/REQ-001/.versions/spec/old.md',
    ]) await page(path)
    const source = createWorkspaceSource({ taktDir })
    expect(source.intents).toEqual(['business', 'history'])
    const hits = await source.query({ text: '订单退款到账' })
    expect(hits.map(hit => hit.ref).sort()).toEqual(included.sort())
    for (const hit of hits) {
      expect(hit.sourceId).toBe('workspace')
      expect(hit.snippet).toContain('三个工作日')
      expect(hit.evidenceLevel).toBe('derived')
    }
  })

  it('复用入口、英文边界、正文评分与证据等级', async () => {
    await page('workspaces/REQ-001/spec/one.md', '---\naliases: [refund]\nverifiedAt: 2020-01-01\n---\n# General\n\nRefund handling rules.')
    await page('workspaces/REQ-001/spec/two.md', '# General\n\nRefund only in body.')
    await page('workspaces/REQ-001/spec/three.md', '# Refunding\n\nDetails.')
    const hits = await createWorkspaceSource({ taktDir }).query({ text: 'refund' })
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ ref: 'REQ-001/spec/one.md', evidenceLevel: 'stale', snippet: 'Refund handling rules.' })
  })

  it('scope 按需求或目录边界过滤，limit 生效', async () => {
    for (const ref of ['REQ-001/spec/a.md', 'REQ-001/reports/b.md', 'REQ-0010/spec/c.md']) await page(`workspaces/${ref}`)
    const source = createWorkspaceSource({ taktDir })
    expect(await source.query({ text: '退款', scope: ['REQ-001'] })).toHaveLength(2)
    expect((await source.query({ text: '退款', scope: ['REQ-001/spec'] })).map(hit => hit.ref)).toEqual(['REQ-001/spec/a.md'])
    expect(await source.query({ text: '退款', limit: 1 })).toHaveLength(1)
  })

  it('缺 taktDir、workspaces、分类目录均返回 []', async () => {
    expect(await createWorkspaceSource({ taktDir: join(taktDir, 'missing') }).query({ text: '退款' })).toEqual([])
    expect(await createWorkspaceSource({ taktDir }).query({ text: '退款' })).toEqual([])
    await mkdir(join(taktDir, 'workspaces', 'REQ-001'), { recursive: true })
    expect(await createWorkspaceSource({ taktDir }).query({ text: '退款' })).toEqual([])
  })

  it('不跟随需求目录、分类目录、Markdown 文件或分类内目录 symlink', async () => {
    await page('outside/spec/one.md')
    await mkdir(join(taktDir, 'workspaces', 'REQ-001', 'reports'), { recursive: true })
    await symlink(join(taktDir, 'outside'), join(taktDir, 'workspaces', 'REQ-linked'))
    await symlink(join(taktDir, 'outside', 'spec'), join(taktDir, 'workspaces', 'REQ-001', 'spec'))
    await symlink(join(taktDir, 'outside', 'spec'), join(taktDir, 'workspaces', 'REQ-001', 'reports', 'linked'))
    await symlink(join(taktDir, 'outside', 'spec', 'one.md'), join(taktDir, 'workspaces', 'REQ-001', 'reports', 'linked.md'))
    expect(await createWorkspaceSource({ taktDir }).query({ text: '退款' })).toEqual([])
  })

  it('不跟随 taktDir 或 workspaces 根目录 symlink', async () => {
    await page('outside/REQ-001/spec/one.md')
    await symlink(join(taktDir, 'outside'), join(taktDir, 'workspaces'))
    expect(await createWorkspaceSource({ taktDir }).query({ text: '退款' })).toEqual([])
    await symlink(taktDir, join(taktDir, 'linked'))
    expect(await createWorkspaceSource({ taktDir: join(taktDir, 'linked') }).query({ text: '退款' })).toEqual([])
  })

  it.each(['workspaces', 'workspaces/REQ-001/spec'])('目录 %s 被普通文件占用时抛出带上下文的错误', async path => {
    await page(path, 'not a directory')
    await expect(createWorkspaceSource({ taktDir }).query({ text: '退款' })).rejects.toThrow(join(taktDir, path))
  })
})
