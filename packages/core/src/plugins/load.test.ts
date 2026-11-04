import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { loadPlugins } from './load.js'
import type { TaktConfig, TaktPlugin } from '../types.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })
async function root() { const dir = await mkdtemp(join(tmpdir(), 'takt-plugin-')); roots.push(dir); return dir }
const config = (...plugins: string[]): TaktConfig => ({ project: { name: 'test' }, workflows: [], plugins })

it('从项目 node_modules 按 import 条件解析 ESM 包，不要求 require 出口', async () => {
  const dir = await root()
  const pkg = join(dir, 'node_modules', '@test', 'esm-plugin')
  await mkdir(pkg, { recursive: true })
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@test/esm-plugin', type: 'module', exports: { '.': { import: './plugin.js' } } }))
  await writeFile(join(pkg, 'plugin.js'), `export default { name: 'esm-only', apiVersion: 1, roles: { custom: 'role markdown' } }`)
  const result = await loadPlugins(config('@test/esm-plugin'), dir)
  expect(result.names).toEqual(['esm-only'])
  expect(result.roles.custom).toBe('role markdown')
})

it('TS 必须使用注入 importer，core 不依赖 tsx；工厂得到项目与配置', async () => {
  const dir = await root()
  const input = config('./plugin.ts')
  await expect(loadPlugins(input, dir)).rejects.toThrow('importer')
  const result = await loadPlugins(input, dir, async (url) => {
    expect(url).toBe(new URL(`file://${join(dir, 'plugin.ts')}`).href)
    return { default: { name: 'local', apiVersion: 1, harnesses: [({ config, projectDir }) => {
      expect(config).toBe(input)
      expect(projectDir).toBe(dir)
      return { id: 'custom', displayName: 'Custom', available: async () => ({ ok: true }), run: async () => ({ ok: true, finalText: 'done' }) }
    }] } satisfies TaktPlugin }
  })
  expect(result.harnesses.custom?.id).toBe('custom')
})

it('拒绝错误 apiVersion 和缺失 default', async () => {
  const dir = await root()
  await expect(loadPlugins(config('./p.js'), dir, async () => ({ default: { name: 'bad', apiVersion: 2 } }))).rejects.toThrow('apiVersion')
  await expect(loadPlugins(config('./p.js'), dir, async () => ({}))).rejects.toThrow('default')
})

it.each(['plugin', 'harness', 'provider', 'knowledge', 'workflow', 'role'])('拒绝 %s 重名', async (kind) => {
  const dir = await root()
  let count = 0
  await expect(loadPlugins(config('./a.js', './b.js'), dir, async () => {
    const plugin: TaktPlugin = { name: kind === 'plugin' ? 'same' : `p${count++}`, apiVersion: 1 }
    if (kind === 'harness') plugin.harnesses = [{ id: 'same', displayName: 'Same', available: async () => ({ ok: true }), run: async () => ({ ok: true, finalText: '' }) }]
    if (kind === 'provider') plugin.providers = { same: () => ({ id: 'same', protocol: 'custom', available: async () => ({ ok: true }), chat: async () => ({ message: { role: 'assistant', content: '' }, stopReason: 'end' }) }) }
    if (kind === 'knowledge') plugin.knowledge = [() => ({ id: 'same', kind: 'custom', intents: [], describe: () => '', query: async () => [] })]
    if (kind === 'workflow') plugin.workflows = [{ id: 'same', title: 'Same', version: '1', stages: [], nodes: [] }]
    if (kind === 'role') plugin.roles = { same: '' }
    return { default: plugin }
  })).rejects.toThrow('名称冲突')
})
