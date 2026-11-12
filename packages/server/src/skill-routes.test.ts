import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { deflateRawSync } from 'node:zlib'
import { afterEach, expect, it } from 'vitest'
import { createServer, type RunningServer } from './index.js'
import { parseGitSource } from './skill-import.js'

const roots: string[] = [], servers: RunningServer[] = []
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'takt-skill-http-')); roots.push(root)
  const server = await createServer({ spacesDir: root, port: 0 }); servers.push(server)
  const request = async (path: string, method = 'GET', data?: unknown, user = 'alice') => {
    const response = await fetch(server.url + '/api' + path, { method, headers: { 'content-type': 'application/json', 'x-takt-user': user }, body: data === undefined ? undefined : JSON.stringify(data) })
    return { status: response.status, data: response.status === 204 ? undefined : await response.json() as any }
  }
  expect((await request('/spaces', 'POST', { id: 'fresh', name: '新空间', template: 'blank' })).status).toBe(200)
  expect((await request('/spaces', 'POST', { id: 'other', name: '另一个', template: 'blank' })).status).toBe(200)
  return { root, request, space: join(root, 'fresh') }
}
const audit = async (space: string) => (await readFile(join(space, '.takt/space-events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(JSON.parse(line).data.message))

/** 测试用的最小 zip：deflate / stored，可以塞一个符号链接条目。 */
function zip(entries: Array<{ name: string; data?: string; link?: string }>): Buffer {
  const parts: Buffer[] = [], central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const raw = Buffer.from(entry.link ?? entry.data ?? '')
    const method = entry.link ? 0 : 8
    const data = method ? deflateRawSync(raw) : raw
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(method, 8)
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26)
    const head = Buffer.alloc(46)
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(0x031e, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(0x800, 8); head.writeUInt16LE(method, 10)
    head.writeUInt32LE(data.length, 20); head.writeUInt32LE(raw.length, 24); head.writeUInt16LE(name.length, 28)
    head.writeUInt32LE(((entry.link ? 0o120777 : 0o100644) << 16) >>> 0, 38); head.writeUInt32LE(offset, 42)
    parts.push(local, name, data); central.push(head, name)
    offset += 30 + name.length + data.length
  }
  const dir = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, dir, end])
}

it('技能是文件夹：SKILL.md 之外能加 references / scripts / 二进制资源，删文件顺手清空目录，越界路径拒绝', async () => {
  const { request, space } = await setup()
  const base = '/s/fresh/space/skills/pdf-tools'
  expect((await request(`${base}/file?path=references/a.md`, 'PUT', { content: 'x', reason: '先写参考' })).status).toBe(404)
  const created = await request(`${base}/file?path=SKILL.md`, 'PUT', { content: '---\nname: pdf-tools\ndescription: 处理 PDF\n---\n\n见 references/forms.md', reason: '新建技能' })
  expect(created.status, JSON.stringify(created.data)).toBe(200)
  expect((await request(`${base}/file?path=references/forms.md`, 'PUT', { content: '# 表单', reason: '加参考' })).status).toBe(200)
  expect((await request(`${base}/file?path=scripts/fill.py`, 'PUT', { content: 'print(1)\n', reason: '加脚本' })).status).toBe(200)
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d])
  expect((await request(`${base}/file?path=assets/logo.png`, 'PUT', { base64: png.toString('base64'), reason: '加图' })).status).toBe(200)

  const tree = await request(`${base}/files`)
  expect(tree.data.dir).toBe('skills/pdf-tools')
  expect(tree.data.files.map((f: any) => [f.path, f.text])).toEqual([['SKILL.md', true], ['assets/logo.png', false], ['references/forms.md', true], ['scripts/fill.py', true]])
  expect((await request(`${base}/file?path=assets/logo.png`)).data).toMatchObject({ text: false, size: 8, content: '' })
  expect((await request(`${base}/file?path=references/forms.md`)).data.content).toBe('# 表单')

  for (const bad of ['../escape.md', 'a//b', '.git/config', '/abs', 'a\\b']) expect((await request(`${base}/file?path=${encodeURIComponent(bad)}`, 'PUT', { content: 'x', reason: '越界' })).status, bad).toBe(400)
  expect((await request(`${base}/file?path=SKILL.md`, 'DELETE', { reason: '删' })).status).toBe(400)
  expect((await request(`${base}/file?path=assets/logo.png`, 'DELETE', { reason: '不要图' })).status).toBe(204)
  expect(await readdir(join(space, 'skills/pdf-tools'))).toEqual(['SKILL.md', 'references', 'scripts'])
  expect((await request(`${base}/file?path=scripts/fill.py`, 'PUT', { content: 'x', reason: '无权' }, 'mallory')).status).toBe(403)

  const detail = await request('/s/fresh/space')
  expect(detail.data.skills).toEqual([expect.objectContaining({ name: 'pdf-tools', dir: 'pdf-tools', description: '处理 PDF' })])
  expect((await audit(space)).map((e) => JSON.stringify(e)).join('\n')).toContain('skills/pdf-tools/assets/logo.png')

  expect((await request(base, 'DELETE', { reason: '整个删掉' })).status).toBe(204)
  expect((await request(`${base}/files`)).status).toBe(404)
})

it('上传 zip：找出包里所有技能，跳过符号链接；改名会同步 frontmatter，同名要显式覆盖；预览令牌不跨空间', async () => {
  const { request, space } = await setup()
  const pack = zip([
    { name: 'pack/alpha/SKILL.md', data: '---\nname: alpha\ndescription: 第一个\n---\nbody' },
    { name: 'pack/alpha/scripts/a.py', data: 'print("a")' },
    { name: 'pack/alpha/link', link: '/etc/passwd' },
    { name: 'pack/beta/SKILL.md', data: '---\nname: Beta Skill!\ndescription: 名字不合法\n---\n' },
    { name: '__MACOSX/pack/._alpha', data: 'junk' },
  ])
  const preview = await request('/s/fresh/space/skills/import/preview', 'POST', { source: { kind: 'upload', files: [{ path: 'pack.zip', base64: pack.toString('base64') }] } })
  expect(preview.status, JSON.stringify(preview.data)).toBe(200)
  expect(preview.data.candidates).toEqual([
    expect.objectContaining({ dir: 'pack/pack/alpha', name: 'alpha', description: '第一个', files: 2, exists: false }),
    expect.objectContaining({ dir: 'pack/pack/beta', name: 'beta', files: 1 }),
  ])
  expect(preview.data.skipped).toEqual(['pack/alpha/link（符号链接）'])

  expect((await request('/s/other/space/skills/import', 'POST', { token: preview.data.token, picks: [{ dir: 'pack/pack/alpha', name: 'alpha' }], reason: '串空间' })).status).toBe(404)
  const done = await request('/s/fresh/space/skills/import', 'POST', { token: preview.data.token, picks: [{ dir: 'pack/pack/alpha', name: 'alpha' }, { dir: 'pack/pack/beta', name: 'beta-renamed' }], reason: '导入包' })
  expect(done.status, JSON.stringify(done.data)).toBe(200)
  expect(done.data.imported).toEqual([{ name: 'alpha', files: 2, replaced: false }, { name: 'beta-renamed', files: 1, replaced: false }])
  expect(await readFile(join(space, 'skills/alpha/scripts/a.py'), 'utf8')).toBe('print("a")')
  expect(await readFile(join(space, 'skills/beta-renamed/SKILL.md'), 'utf8')).toBe('---\nname: beta-renamed\ndescription: 名字不合法\n---\n')
  expect(await readdir(join(space, '.takt/skill-import'))).toEqual([])
  expect((await request('/s/fresh/space/skills/import', 'POST', { token: preview.data.token, picks: [{ dir: 'pack/pack/alpha', name: 'alpha' }], reason: '再来' })).status).toBe(404)

  // 文件夹上传 + 同名冲突
  const folder = [
    { path: 'alpha/SKILL.md', base64: Buffer.from('---\nname: alpha\ndescription: 第二版\n---\n').toString('base64') },
    { path: 'alpha/references/notes.md', base64: Buffer.from('notes').toString('base64') },
  ]
  const again = await request('/s/fresh/space/skills/import/preview', 'POST', { source: { kind: 'upload', files: folder } })
  expect(again.data.candidates).toEqual([expect.objectContaining({ dir: 'alpha', name: 'alpha', exists: true, files: 2 })])
  expect((await request('/s/fresh/space/skills/import', 'POST', { token: again.data.token, picks: [{ dir: 'alpha', name: 'alpha' }], reason: '覆盖' })).status).toBe(409)
  const replaced = await request('/s/fresh/space/skills/import', 'POST', { token: again.data.token, picks: [{ dir: 'alpha', name: 'alpha' }], overwrite: true, reason: '覆盖' })
  expect(replaced.data.imported).toEqual([{ name: 'alpha', files: 2, replaced: true }])
  expect((await readdir(join(space, 'skills/alpha'))).sort()).toEqual(['SKILL.md', 'references'])
  const log = (await audit(space)).map((e) => JSON.stringify(e)).join('\n')
  expect(log).toContain('导入技能 alpha、beta-renamed（来源 pack.zip）')
  expect(log).toContain('覆盖 alpha')

  const empty = await request('/s/fresh/space/skills/import/preview', 'POST', { source: { kind: 'upload', files: [{ path: 'readme.md', base64: Buffer.from('hi').toString('base64') }] } })
  expect(empty.data).toMatchObject({ token: '', candidates: [] })
  expect((await request('/s/fresh/space/skills/import/preview', 'POST', { source: { kind: 'upload', files: [{ path: 'bad.zip', base64: 'bm90IGEgemlw' }] } })).status).toBe(400)
  expect((await request('/s/fresh/space/skills/import/preview', 'POST', { source: { kind: 'git', url: 'file:///etc' } })).status).toBe(400)
})

it('导入目标路径上有符号链接时拒绝写入', async () => {
  const { request, space } = await setup()
  const outside = await mkdtemp(join(tmpdir(), 'takt-skill-out-')); roots.push(outside)
  await symlink(outside, join(space, 'skills/evil'))
  expect((await request('/s/fresh/space/skills/evil/file?path=SKILL.md', 'PUT', { content: 'x', reason: '逃逸' })).status).toBe(400)
  expect(await readdir(outside)).toEqual([])
})

it('Git 来源：认 GitHub 网页地址、owner/repo 简写，拒绝本地路径和带空格的地址，标签里不留凭据', () => {
  expect(parseGitSource({ url: 'anthropics/skills' })).toMatchObject({ url: 'https://github.com/anthropics/skills.git', label: 'github.com/anthropics/skills' })
  expect(parseGitSource({ url: 'https://github.com/anthropics/skills/tree/main/document-skills/pdf' }))
    .toMatchObject({ url: 'https://github.com/anthropics/skills.git', ref: 'main', path: 'document-skills/pdf', label: 'github.com/anthropics/skills@main · document-skills/pdf' })
  expect(parseGitSource({ url: 'https://github.com/o/r/blob/v1/skills/x/SKILL.md' })).toMatchObject({ ref: 'v1', path: 'skills/x' })
  expect(parseGitSource({ url: 'https://github.com/o/r/tree/main/a', ref: 'dev', path: 'b' })).toMatchObject({ ref: 'dev', path: 'b' })
  expect(parseGitSource({ url: 'git@gitlab.example.com:team/skills.git' })).toMatchObject({ url: 'git@gitlab.example.com:team/skills.git' })
  expect(parseGitSource({ url: 'https://user:secret@git.example.com/x.git' }).label).toBe('git.example.com/x')
  for (const url of ['file:///etc', '/tmp/repo', 'https://a b', '--upload-pack=x']) expect(() => parseGitSource({ url }), url).toThrow()
  expect(() => parseGitSource({ url: 'o/r', ref: '--evil' })).toThrow()
  expect(() => parseGitSource({ url: 'o/r', path: '../x' })).toThrow()
})
