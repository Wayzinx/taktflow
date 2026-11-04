import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWikiSource } from './wiki.js'

let root: string
async function page(path: string, content: string) {
  await mkdir(join(root, path, '..'), { recursive: true })
  await writeFile(join(root, path), content)
}

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'takt-wiki-')) })
afterEach(async () => {
  vi.useRealTimers()
  await rm(root, { recursive: true, force: true })
})

describe('Wiki 两阶段检索', () => {
  it('中文问题通过 bigram 召回并提取最相关正文段落', async () => {
    await page('billing.md', '# 退款流程\n\n这里介绍背景。\n\n订单退款需要审核，到账时间为三个工作日。')
    await page('login.md', '# 登录规则\n\n用户使用密码登录。')
    const hits = await createWikiSource({ root }).query({ text: '订单退款多久到账' })
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ sourceId: 'wiki', ref: 'billing.md', title: '退款流程', evidenceLevel: 'derived' })
    expect(hits[0]!.snippet).toContain('三个工作日')
    expect(hits[0]!.fetchedAt).toBeDefined()
  })

  it.each([
    ['退款/说明.md', '# 无关标题\n\n办理说明。'],
    ['one.md', '# 退款规则\n\n办理说明。'],
    ['one.md', '---\naliases: [退费, "退款"]\n---\n# 通用规则\n\n办理说明。'],
    ['one.md', '---\naliases:\n  - 退费\n  - 退款\n---\n# 通用规则\n\n办理说明。'],
    ['one.md', '---\nsummary: 退款办理说明\n---\n# 通用规则\n\n办理说明。'],
    ['one.md', '---\nsummary: |\n  退款办理说明\n  第二行\n---\n# 通用规则\n\n办理说明。'],
    ['one.md', '---\nsummary: >-\n  退款办理说明\n  第二行\n---\n# 通用规则\n\n办理说明。'],
  ])('入口可单独召回 %s %s', async (path, content) => {
    await page(path, content)
    expect(await createWikiSource({ root }).query({ text: '退款' })).toHaveLength(1)
  })

  it('正文不能把入口未命中的页面带入候选', async () => {
    await page('one.md', '# 其他知识\n\n退款退款退款退款。')
    expect(await createWikiSource({ root }).query({ text: '退款' })).toEqual([])
  })

  it('正文只对前 N 个入口候选重排', async () => {
    for (let i = 0; i < 16; i++) await page(`${i}.md`, '# alpha beta\n\n背景。')
    await page('outside.md', '# alpha\n\nbeta gamma delta epsilon zeta eta theta。')
    const hits = await createWikiSource({ root }).query({ text: 'alpha beta gamma delta epsilon zeta eta theta', limit: 1 })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.ref).not.toBe('outside.md')
  })

  it('第二阶段正文匹配影响排序和 snippet', async () => {
    await page('a.md', '# Alpha\n\n无关背景。')
    await page('b.md', '# Alpha\n\n无关背景。\n\nAlpha beta describes the actual rule.')
    const hits = await createWikiSource({ root }).query({ text: 'alpha beta', limit: 1 })
    expect(hits[0]!.ref).toBe('b.md')
    expect(hits[0]!.snippet).toBe('Alpha beta describes the actual rule.')
  })

  it('英文不区分大小写且按完整单词匹配', async () => {
    await page('one.md', '# Scatter catalog concatenate\n\ncat。')
    await page('two.md', '# CAT rules\n\nThe cat is allowed.')
    expect((await createWikiSource({ root }).query({ text: 'cAt' })).map(hit => hit.ref)).toEqual(['two.md'])
  })

  it('支持带逗号、井号和转义引号的 aliases 与 CRLF frontmatter', async () => {
    await page('one.md', '\uFEFF---\r\naliases: ["refund, repayment", \'customer, # returns\', "say \\"hello\\""] # aliases\r\n---\r\n# General\r\n\r\nDetails.')
    for (const text of ['repayment', 'returns', 'hello']) {
      expect(await createWikiSource({ root }).query({ text })).toHaveLength(1)
    }
  })

  it('支持 Setext 一级标题且忽略代码块中的伪标题', async () => {
    await page('one.md', '```md\n# wrong\n```\n\nRefund rules\n============\n\nDetails.')
    expect((await createWikiSource({ root }).query({ text: 'refund' }))[0]!.title).toBe('Refund rules')
    expect(await createWikiSource({ root }).query({ text: 'wrong' })).toEqual([])
  })

  it('长段落截取真实英文单词命中处，不截取同前缀单词', async () => {
    await page('one.md', `# Cat\n\nScatter ${'background '.repeat(100)}the cat is allowed.`)
    const hits = await createWikiSource({ root }).query({ text: 'cat' })
    expect(hits[0]!.snippet).toContain('the cat is allowed')
    expect(hits[0]!.snippet.length).toBeLessThanOrEqual(600)
  })

  it('默认限制 8，支持路径 scope、空查询和零 limit', async () => {
    for (let i = 0; i < 10; i++) await page(`group/${i}.md`, '# Refund\n\nDetails.')
    await page('group-other/one.md', '# Refund\n\nDetails.')
    const source = createWikiSource({ root })
    expect(await source.query({ text: 'refund' })).toHaveLength(8)
    expect(await source.query({ text: 'refund', scope: ['group'], limit: 20 })).toHaveLength(10)
    expect(await source.query({ text: 'refund', limit: 0 })).toEqual([])
    expect(await source.query({ text: ' ? ' })).toEqual([])
  })
})

describe('Wiki 证据时效与文件边界', () => {
  it.each([
    ['2026-11-04T00:00:00Z', 'verified'],
    ['2026-10-05T00:00:00Z', 'verified'],
    ['2026-10-04T23:59:59.999Z', 'stale'],
    ['2026-10-20', 'verified'],
    ['2026-11-04T08:00:00+08:00', 'verified'],
    ['', 'derived'],
    ['nonsense', 'derived'],
    ['2026-02-30', 'derived'],
    ['2026-11-03T24:00:00Z', 'derived'],
    ['2026-11-04T00:00:00.001Z', 'derived'],
    ['2027-01-01', 'derived'],
  ])('%s 的证据等级为 %s', async (date, expected) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-04T00:00:00Z'))
    await page('one.md', `---\nverifiedAt: '${date}'\n---\n# Refund\n\nDetails.`)
    expect((await createWikiSource({ root }).query({ text: 'refund' }))[0]!.evidenceLevel).toBe(expected)
  })

  it('缺目录返回 []，不跟随目录、文件、根目录 symlink', async () => {
    await page('outside/one.md', '# Refund\n\nDetails.')
    await mkdir(join(root, 'wiki'))
    await symlink(join(root, 'outside'), join(root, 'wiki', 'linked'))
    await symlink(join(root, 'outside', 'one.md'), join(root, 'wiki', 'linked.md'))
    await symlink(join(root, 'wiki'), join(root, 'wiki', 'cycle'))
    await symlink(join(root, 'outside'), join(root, 'linked-root'))
    for (const name of ['missing', 'wiki', 'linked-root']) {
      expect(await createWikiSource({ root: join(root, name) }).query({ text: 'refund' })).toEqual([])
    }
  })

  it('只读取 Markdown，文件冒充目录时抛出带路径的错误', async () => {
    await page('one.txt', '# Refund')
    expect(await createWikiSource({ root }).query({ text: 'refund' })).toEqual([])
    await expect(createWikiSource({ root: join(root, 'one.txt') }).query({ text: 'refund' })).rejects.toThrow(join(root, 'one.txt'))
  })

  it.skipIf(process.getuid?.() === 0 || process.platform === 'win32')('Markdown 读取失败保留文件路径和原始错误', async () => {
    await page('unreadable.md', '# Refund\n\nDetails.')
    await chmod(join(root, 'unreadable.md'), 0o000)
    await expect(createWikiSource({ root }).query({ text: 'refund' })).rejects.toMatchObject({
      message: expect.stringContaining(join(root, 'unreadable.md')),
      cause: expect.objectContaining({ code: 'EACCES' }),
    })
  })
})
