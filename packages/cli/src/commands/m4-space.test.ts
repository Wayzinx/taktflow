import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createServer, projectCommands } from '@taktflow/server'
import { loadRuntime, engineDependencies, createRunEngine } from '../project.js'
import { validateRuntime } from '../runtime-validation.js'

it('M4-26/45：仓库外在线新建标准空间、加载命令、启动需求和独立归档恢复', async () => {
  const spacesDir = await mkdtemp(join(tmpdir(), 'takt-m4-runtime-'))
  const server = await createServer({ spacesDir, port: 0, getCommands: async stores => {
    const context = await loadRuntime(stores.projectDir)
    return projectCommands(context.stores, {
      startRun: async input => {
        const workflow = context.workflows.find(item => item.id === input.workflowId)!
        const run = await createRunEngine(context, { harness: 'mock' }).start({
          requirementId: input.requirementId as string, workflow,
        })
        return run
      },
    }, engineDependencies(context))
  } })
  async function request(path: string, data?: unknown) {
    const response = await fetch(server.url + path, {
      method: data ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-takt-user': 'alice' },
      ...(data ? { body: JSON.stringify(data) } : {}),
    })
    const body = await response.json()
    expect(response.status, JSON.stringify(body)).toBe(200)
    return body
  }
  try {
    await request('/api/spaces', { id: 'std', name: '标准', template: 'standard' })
    await writeFile(join(spacesDir, 'std/agents/broken.md'), '---\nrole: broken\nharness: { harness: native }\n---\n')
    const warnings: string[] = []
    const context = await loadRuntime(join(spacesDir, 'std'), { warn: message => warnings.push(message) })
    validateRuntime(context, message => warnings.push(message))
    expect(context.profiles.broken).toBeUndefined()
    expect(warnings.some(message => message.includes('broken'))).toBe(true)
    await request('/api/steward/risks')
    await request('/api/steward/digest')
    await request('/api/s/std/commands')
    const draft = await request('/api/s/std/requirements', { title: '草稿', start: false })
    await request(`/api/s/std/requirements/${draft.requirement.id}/archive`, { reason: '检查' })
    await request(`/api/s/std/requirements/${draft.requirement.id}/restore`, { reason: '检查' })
    const started = await request('/api/s/std/requirements', { title: '验证启动', description: '交付最小功能', start: true })
    expect(started.startError).toBeUndefined()
    expect(started.runId).toBeTruthy()
  } finally {
    await server.close()
    await rm(spacesDir, { recursive: true, force: true })
  }
}, 30000)
