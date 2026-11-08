import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { initProject } from '@taktflow/core'
import { createHarnesses } from '@taktflow/harness'
import { runtimeHarnesses } from '../../../cli/src/catalog.js'
import type { ProjectContext } from '../../../cli/src/project.js'

it('目录输出 ACP 来源、实际命令、覆盖与 custom；无密钥值且保留停用项', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'takt-acp-catalog-'))
  try {
    const stores = await initProject(dir)
    stores.config.harnesses = [
      { id: 'my-acp', kind: 'acp', preset: 'gemini', command: ['./my-acp', '--stdio'], env: { API_KEY: 'synthetic-secret-acp' } },
      { id: 'my-cli', kind: 'cli', command: ['my-cli'], output: { format: 'text' } },
    ]
    stores.config.harnessOverrides = { codex: { command: './tools/codex', env: { API_KEY: 'synthetic-secret-codex', OTHER: 'value' } }, dsh: { disabled: true } }
    stores.config.roles = { dev: { harness: 'my-acp' } }
    const harnesses = createHarnesses({ config: stores.config, projectDir: dir })
    for (const harness of Object.values(harnesses)) harness.available = async () => ({ ok: true })
    harnesses['my-acp']!.available = async () => ({ ok: false, reason: 'failed synthetic-secret-acp' })
    const context: ProjectContext = { stores, harnesses, profiles: {}, workflows: [], providers: {}, knowledge: [],
      plugins: { names: [], harnesses: {}, providers: {}, workflows: [], roles: {}, knowledge: [] } }
    const rows = await runtimeHarnesses(context)
    expect(rows.find(row => row.id === 'my-acp')).toMatchObject({ source: 'acp', custom: true, command: [join(dir, 'my-acp'), '--stdio'], roles: ['dev'], reason: 'failed [REDACTED]' })
    expect(rows.find(row => row.id === 'my-cli')).toMatchObject({ source: 'cli', custom: true, command: ['my-cli'] })
    expect(rows.find(row => row.id === 'codex')).toMatchObject({ source: 'builtin', custom: false, command: [join(dir, 'tools/codex')], override: { command: './tools/codex', env: { API_KEY: '[REDACTED]', OTHER: '[REDACTED]' } } })
    expect(rows.find(row => row.id === 'native')?.command).toBeUndefined()
    expect(rows.find(row => row.id === 'dsh')).toMatchObject({ available: false, reason: '本空间已停用', override: { disabled: true } })
    expect(harnesses.dsh).toBeUndefined()
    expect(JSON.stringify(rows)).not.toContain('synthetic-secret')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
