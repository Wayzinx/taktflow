import { PassThrough } from 'node:stream'
import { ChildProcess, spawn } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { createDockerSandboxProvider } from './docker.js'
import { createBwrapSandboxProvider } from './bwrap.js'
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn: vi.fn() }))
afterEach(() => vi.restoreAllMocks())
function mockCommands() {
  const calls: string[][] = []
  vi.mocked(spawn).mockImplementation(((command: string, args: string[]) => {
    calls.push([command, ...args])
    const child = new ChildProcess()
    child.kill = vi.fn(() => true)
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
    queueMicrotask(() => {
      if (args[0] === 'run') child.stdout!.emit('data', 'a'.repeat(64) + '\n')
      child.emit('close', 0, null)
    })
    return child
  }) as typeof spawn)
  return calls
}
it('docker translates limits, mount modes and env, resolves nested mounts and disposes once', async () => {
  const calls = mockCommands()
  const sandbox = await createDockerSandboxProvider({ image: 'default-image' }).create({
    workdir: '/work', image: 'override-image', network: 'none', limits: { cpus: 1.5, memoryMb: 256 },
    mounts: [{ source: '/host', target: '/work', mode: 'ro' }, { source: '/writable', target: '/work/out', mode: 'rw' }],
    env: { EXPLICIT: 'fixture' },
  })
  expect(calls[0]).toEqual(['docker', 'run', '-d', '--rm', '--init', '-v', '/host:/work:ro', '-v', '/writable:/work/out:rw', '--network', 'none', '--cpus', '1.5', '--memory', '256m', '--workdir', '/work', '--entrypoint', 'sleep', 'override-image', 'infinity'])
  expect(sandbox.hostPath('/work/out/file')).toBe('/writable/file')
  expect(sandbox.hostPath('/work/out/../file')).toBe('/host/file')
  expect(() => sandbox.hostPath('/work-other/file')).toThrow('no host mount')
  await sandbox.exec('echo', ['hi'], { cwd: '/work/out', env: { EXPLICIT: 'overridden' } })
  expect(calls[1]!.slice(0, 5)).toEqual(['docker', 'exec', '-i', '-w', '/work/out'])
  expect(calls[1]).toContain('EXPLICIT=overridden')
  expect(calls[1]!.slice(-2)).toEqual(['echo', 'hi'])
  expect(calls[1]).toContain('-i')
  await sandbox.dispose(); await sandbox.dispose()
  expect(calls.filter(call => call[1] === 'rm')).toEqual([['docker', 'rm', '-f', 'a'.repeat(64)]])
})
it('bwrap emits read-only root, writable overrides, clearenv and network namespace', async () => {
  const calls = mockCommands()
  const sandbox = await createBwrapSandboxProvider().create({ workdir: '/work', network: 'none', mounts: [{ source: '/host', target: '/work', mode: 'rw' }], env: { EXPLICIT: 'fixture' } })
  await sandbox.exec('/bin/echo', ['hi'])
  const flags = calls[0]!
  for (const required of ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-net', '--clearenv']) expect(flags).toContain(required)
  expect(flags.slice(flags.indexOf('--ro-bind'), flags.indexOf('--ro-bind') + 3)).toEqual(['--ro-bind', '/', '/'])
  expect(flags.slice(flags.indexOf('--bind'), flags.indexOf('--bind') + 3)).toEqual(['--bind', '/host', '/work'])
  expect(flags.slice(-5)).toEqual(['--chdir', '/work', '--', '/bin/echo', 'hi'])
  expect(sandbox.hostPath('/work/file')).toBe('/host/file')
  await sandbox.dispose()
})

it('killing docker exec also removes the task container', async () => {
  const calls = mockCommands()
  const sandbox = await createDockerSandboxProvider({ image: 'test-image' }).create({ workdir: '/work', mounts: [] })
  const child = sandbox.spawn('sleep', ['infinity'])
  child.kill('SIGTERM')
  await sandbox.dispose()
  expect(calls.filter(call => call[1] === 'rm')).toHaveLength(1)
})
