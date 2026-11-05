import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunState, TaktConfig } from '../types.js'
import { fileExists } from './fs-utils.js'
import { initProject, loadProfiles, openProject } from './project.js'

const templatesDir = fileURLToPath(new URL('../../../../templates/', import.meta.url))

const agentDoc = (frontmatter: string, body: string): string => `---\n${frontmatter}---\n${body}`

describe('project / profiles', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'takt-store-proj-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('initProject 创建配置和目录，重复调用不覆盖已有配置', async () => {
    const projectDir = path.join(root, 'demo')
    const stores = await initProject(projectDir, { name: '演示项目' })
    expect(stores.projectDir).toBe(path.resolve(projectDir))
    expect(stores.taktDir).toBe(path.join(path.resolve(projectDir), '.takt'))
    expect(stores.config.project.name).toBe('演示项目')
    expect(stores.config.workflows).toEqual(['workflows/sdlc.workflow.ts'])
    for (const dir of ['agents', 'workflows', 'skills', 'knowledge', 'requirements', '.takt']) {
      expect(await fileExists(path.join(stores.projectDir, dir))).toBe(true)
    }

    const configFile = path.join(projectDir, 'takt.config.json')
    const config = JSON.parse(await readFile(configFile, 'utf8')) as TaktConfig
    config.workflows = ['custom.workflow.ts']
    await writeFile(configFile, JSON.stringify(config))

    const reopened = await initProject(projectDir, { name: '另一个名字' })
    expect(reopened.config.workflows).toEqual(['custom.workflow.ts'])
    expect(reopened.config.project.name).toBe('演示项目')
  })

  it('openProject 向上查找配置，找不到时报错', async () => {
    const projectDir = path.join(root, 'demo')
    await initProject(projectDir)
    const nested = path.join(projectDir, 'src', 'deep')
    const stores = await openProject(nested)
    expect(stores.projectDir).toBe(path.resolve(projectDir))
    expect(stores.workspaces).toBeDefined()
    expect(stores.events).toBeDefined()
    expect(stores.runs).toBeDefined()
    expect(stores.attention).toBeDefined()

    await expect(openProject(path.join(root, 'nowhere'))).rejects.toThrow('takt.config.json')
  })

  it('并发初始化只保留首次配置，所有调用读回同一结果', async () => {
    const projectDir = path.join(root, 'concurrent')
    const projects = await Promise.all(Array.from({ length: 16 }, (_, i) =>
      initProject(i % 2 ? projectDir : path.relative(process.cwd(), projectDir), { name: `name-${i}` })))
    const persisted = JSON.parse(await readFile(path.join(projectDir, 'takt.config.json'), 'utf8'))
    expect(projects.every((p) => p.config.project.name === persisted.project.name)).toBe(true)
    expect((await openProject(projectDir)).config).toEqual(persisted)
  })

  it('不同进程同时初始化也不会覆盖获胜配置', async () => {
    const projectDir = path.join(root, 'cross-process')
    const moduleUrl = new URL('./project.ts', import.meta.url).href
    const script = `import { initProject } from ${JSON.stringify(moduleUrl)};
      const stores = await initProject(process.argv[1], { name: process.argv[2] });
      process.stdout.write(JSON.stringify(stores.config));`
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => promisify(execFile)(
      process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, projectDir, `process-${i}`],
    )))
    const persisted = JSON.parse(await readFile(path.join(projectDir, 'takt.config.json'), 'utf8'))
    expect(results.map((result) => JSON.parse(result.stdout))).toEqual(Array(4).fill(persisted))
  })

  it('loadProfiles 解析 frontmatter 和正文，缺 harness 报错', async () => {
    const taktDir = path.join(root, '.takt')
    await mkdir(path.join(taktDir, 'agents'), { recursive: true })
    await writeFile(
      path.join(taktDir, 'agents', 'dev.md'),
      agentDoc(
        'role: dev\ntitle: 开发\ndescription: 实现功能\nharness: { harness: codex, effort: high }\nskills: [git]\nwriteScope: ["src/**"]\nreadScope: ["docs/**"]\n',
        '\n你是开发。\n',
      ),
    )
    await writeFile(path.join(taktDir, 'agents', 'qa.md'), agentDoc('harness: claude-code\n', '你是测试。'))
    await writeFile(path.join(taktDir, 'agents', 'notes.txt'), '不是 md，忽略')

    const profiles = await loadProfiles(taktDir)
    expect(Object.keys(profiles).sort()).toEqual(['dev', 'qa'])
    expect(profiles.dev).toEqual({
      role: 'dev',
      title: '开发',
      description: '实现功能',
      harness: { harness: 'codex', effort: 'high' },
      skills: ['git'],
      writeScope: ['src/**'],
      readScope: ['docs/**'],
      instructions: '你是开发。',
    })
    // 缺 role / title / skills 时用文件名和空默认值兜底
    expect(profiles.qa?.role).toBe('qa')
    expect(profiles.qa?.harness).toEqual({ harness: 'claude-code' })
    expect(profiles.qa?.writeScope).toEqual([])

    await writeFile(path.join(taktDir, 'agents', 'broken.md'), agentDoc('role: broken\n', '缺 harness'))
    await expect(loadProfiles(taktDir)).rejects.toThrow('harness')
    expect(await loadProfiles(path.join(root, 'no-agents'))).toEqual({})
  })

  it('能解析仓库里的全部角色模板（只读）', async () => {
    const profiles = await loadProfiles(templatesDir)
    expect(Object.keys(profiles).sort()).toEqual([
      'architect',
      'automation',
      'dev',
      'judge',
      'lead',
      'pm',
      'reviewer',
      'test-designer',
    ])
    expect(profiles.dev?.harness).toEqual({ harness: 'codex', effort: 'high', fallback: [{ harness: 'claude-code' }] })
    expect(profiles.dev?.writeScope).toContain('src/**')
    expect(profiles.dev?.instructions).toContain('你是开发')
  })

  it('initProject 返回的 stores 能直接读写（端到端冒烟）', async () => {
    const stores = await initProject(path.join(root, 'demo'), { name: 'demo' })
    const system = { type: 'system', id: 'test' } as const

    const requirement = await stores.workspaces.createRequirement({ title: '冒烟需求' })
    const artifact = await stores.workspaces.writeArtifact({
      ref: { workspace: requirement.id, path: 'spec/spec.md' },
      content: 'REQ-001 的 spec',
      kind: 'spec',
      author: system,
    })
    expect(artifact.version).toBe(1)

    const event = await stores.events.append('run-20261104-000001', {
      type: 'run.started',
      actor: system,
      data: { workflowId: 'sdlc', workflowVersion: '1', args: {} },
    })
    expect(event.seq).toBe(1)
    expect((await stores.events.verify('run-20261104-000001')).ok).toBe(true)

    const state: RunState = {
      runId: 'run-20261104-000001',
      workflowId: 'sdlc',
      workflowVersion: '1',
      requirementId: requirement.id,
      status: 'running',
      startedAt: event.ts,
      args: {},
      nodes: {},
      expansions: [],
    }
    const snapshot = { id: 'sdlc', title: 'SDLC', version: '1', stages: [], nodes: [] }
    await stores.runs.create(state, snapshot)
    expect((await stores.runs.getWorkflow(state.runId))?.id).toBe('sdlc')

    await stores.attention.create({
      requestId: 'run-20261104-000001/ask',
      runId: state.runId,
      nodeId: 'ask',
      requirementId: requirement.id,
      ask: '继续？',
      form: 'approve',
    })
    expect(await stores.attention.list({ pending: true })).toHaveLength(1)
  })
})
