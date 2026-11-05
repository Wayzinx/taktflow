import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { runInit } from './commands/init.js'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
it.each(['docker-compose.yml', 'compose.yaml'])('init 检测 %s，输出建议但不启用 environment', async (file) => {
  const root = await mkdtemp(join(tmpdir(), 'takt-compose-init-')); roots.push(root)
  await writeFile(join(root, file), 'services: {}')
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  await runInit(root, { json: true })
  const output = JSON.parse(stdout.mock.calls.map(([text]) => String(text)).join(''))
  expect(output.environmentSuggestion).toEqual({ deploy: 'docker compose up -d --build', teardown: 'docker compose down' })
  expect(JSON.parse(await readFile(join(root, 'takt.config.json'), 'utf8')).environment).toBeUndefined()
  stdout.mockClear()
  await runInit(root, { json: false })
  const text = stdout.mock.calls.map(([value]) => String(value)).join('')
  expect(text).toContain(file)
  expect(text).toContain('尚未启用')
})
