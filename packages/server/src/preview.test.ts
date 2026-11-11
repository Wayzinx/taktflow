import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createPreviewServer } from './preview.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

it('只服务登记的目录：网页和相对资源能取到，目录给 index.html；. 开头、越界、未登记的令牌都是 404', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-preview-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const outside = await mkdtemp(join(tmpdir(), 'takt-preview-out-'))
  cleanups.push(() => rm(outside, { recursive: true, force: true }))
  await mkdir(join(root, 'games/tank'), { recursive: true })
  await mkdir(join(root, '.git'))
  await writeFile(join(root, 'games/tank/index.html'), '<script type="module" src="./logic.js"></script>')
  await writeFile(join(root, 'games/tank/logic.js'), 'export {}')
  await writeFile(join(root, '.git/config'), 'secret')
  await writeFile(join(outside, 'secret.txt'), 'secret')
  await symlink(join(outside, 'secret.txt'), join(root, 'games/link.txt'))
  const preview = createPreviewServer()
  cleanups.push(() => preview.close())

  const url = await preview.url(root, 'games/tank/index.html', '127.0.0.1:4870')
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{24}\/games\/tank\/index\.html$/)
  const page = await fetch(url)
  expect(page.status).toBe(200)
  expect(page.headers.get('content-type')).toContain('text/html')
  const script = await fetch(new URL('./logic.js', url))
  expect(script.headers.get('content-type')).toContain('text/javascript')
  expect((await fetch(new URL('./', url))).status).toBe(200)
  const base = url.replace(/games\/tank\/index\.html$/, '')
  for (const bad of ['.git/config', 'games/link.txt', '%2e%2e/secret.txt', 'games/tank/missing.js']) expect((await fetch(base + bad)).status).toBe(404)
  expect((await fetch(url.replace(/\/[0-9a-f]{24}\//, '/000000000000000000000000/'))).status).toBe(404)
  // 同一目录再登记用同一个令牌
  expect(await preview.url(root, 'games/tank/logic.js', 'localhost:4870')).toBe(`${base.replace('127.0.0.1', 'localhost')}games/tank/logic.js`)
})
