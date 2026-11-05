import { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Sandbox } from '@taktflow/core'
import { createBwrapSandboxProvider, createDockerSandboxProvider, createLocalSandboxProvider, selectSandboxProvider } from './index.js'
import { collect } from './runtime.js'
import { runProcess } from '../../harness/src/process.js'

const providers = [createLocalSandboxProvider(), createBwrapSandboxProvider(), createDockerSandboxProvider({ image: process.env.TAKT_TEST_DOCKER_IMAGE ?? 'node:22-bookworm-slim' })]
const availability = await Promise.all(providers.map(provider => provider.available()))
it('CI requires bubblewrap availability', () => {
  if (process.env.TAKT_REQUIRE_BWRAP === '1') expect(availability[1]).toEqual({ ok: true })
})

for (const [index, provider] of providers.entries()) {
  describe.skipIf(!availability[index]!.ok)(`${provider.id} contract`, () => {
    let root: string
    let sandbox: Sandbox
    const executable = provider.id === 'docker' ? 'node' : process.execPath
    beforeEach(async () => {
      root = await realpath(await mkdtemp(join(tmpdir(), 'takt-sandbox-')))
      await mkdir(join(root, 'ro')); await mkdir(join(root, 'rw'))
      await writeFile(join(root, 'ro', 'keep'), 'original')
      sandbox = await provider.create({
        workdir: join(root, 'rw'), network: 'none',
        mounts: [{ source: join(root, 'ro'), target: join(root, 'ro'), mode: 'ro' }, { source: join(root, 'rw'), target: join(root, 'rw'), mode: 'rw' }],
        env: { TAKT_EXPLICIT: 'spec-value' },
      })
    }, 180_000)
    afterEach(async () => { vi.unstubAllEnvs(); await sandbox?.dispose(); await rm(root, { recursive: true, force: true }) })

    it('returns ChildProcess, streams stdin/stdout/stderr and exit status', async () => {
      const child = sandbox.spawn(executable, ['-e', 'process.stdin.pipe(process.stdout); console.error("err")'])
      expect(child).toBeInstanceOf(ChildProcess)
      expect(await collect(child, 'hello\u2028world')).toEqual({ code: 0, stdout: 'hello\u2028world', stderr: 'err\n' })
      expect(await sandbox.exec(executable, ['-e', 'process.exit(7)'])).toMatchObject({ code: 7 })
    })
    it('filters host environment and applies spec and spawn overrides', async () => {
      vi.stubEnv('TAKT_HOST_SECRET', 'dummy-do-not-inherit')
      vi.stubEnv('BASH_ENV', '/nonexistent/startup')
      const result = await sandbox.exec(executable, ['-e', 'console.log(JSON.stringify({secret:process.env.TAKT_HOST_SECRET,bash:process.env.BASH_ENV,path:!!process.env.PATH,explicit:process.env.TAKT_EXPLICIT,cwd:process.cwd()}))'], { env: { TAKT_EXPLICIT: 'override' } })
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ path: true, explicit: 'override', cwd: join(root, 'rw') })
    })
    it('writes rw mounts and uses cwd overrides', async () => {
      expect((await sandbox.exec(executable, ['-e', 'require("fs").writeFileSync("new", "written")'])).code).toBe(0)
      expect(await readFile(join(root, 'rw', 'new'), 'utf8')).toBe('written')
      expect((await sandbox.exec(executable, ['-p', 'process.cwd()'], { cwd: join(root, 'ro') })).stdout.trim()).toBe(join(root, 'ro'))
      expect(sandbox.hostPath(join(root, 'rw', 'new'))).toBe(join(root, 'rw', 'new'))
    })
    it.skipIf(provider.id === 'local')('denies writes to ro mounts', async () => {
      expect((await sandbox.exec(executable, ['-e', 'require("fs").writeFileSync(process.argv[1], "bad")', join(root, 'ro', 'keep')])).code).not.toBe(0)
      expect(await readFile(join(root, 'ro', 'keep'), 'utf8')).toBe('original')
    })
    it.skipIf(provider.id === 'local')('network none prevents an external TCP connection', async () => {
      const result = await sandbox.exec(executable, ['-e', 'const s=require("net").connect(53,"1.1.1.1"); s.on("connect",()=>{s.destroy();process.exit(9)});s.on("error",()=>process.exit(0));s.setTimeout(800,()=>{s.destroy();process.exit(0)})'], { timeoutMs: 3_000 })
      expect(result.code).toBe(0)
    })
    it('times out and disposes idempotently', async () => {
      await expect(sandbox.exec(executable, ['-e', 'setInterval(()=>{},100)'], { timeoutMs: 150 })).rejects.toThrow('timed out')
      await sandbox.dispose(); await sandbox.dispose()
      expect(() => sandbox.spawn(executable, [])).toThrow('disposed')
    })
  })
}

it('does not silently fall back from unavailable or unknown providers', async () => {
  expect((await selectSandboxProvider(undefined)).id).toBe('local')
  await expect(selectSandboxProvider({ provider: 'bwrap' }, 'darwin')).rejects.toThrow('requires Linux')
  await expect(selectSandboxProvider({ provider: 'docker' })).rejects.toThrow('image')
  await expect(selectSandboxProvider({ provider: 'typo' })).rejects.toThrow('Unknown')
})

it('local explicitly provides no mount or network isolation and hostPath is identity', async () => {
  const sandbox = await createLocalSandboxProvider().create({ workdir: tmpdir(), mounts: [], network: 'none' })
  expect(sandbox.hostPath('../relative')).toBe('../relative')
  await sandbox.dispose()
})

it('runProcess uses local sandbox spawn with stdin, transcript, redaction and cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'takt-process-sandbox-'))
  const sandbox = await createLocalSandboxProvider().create({ workdir: root, mounts: [], env: { TEST_API_KEY: 'dummy-private-value' } })
  const spawn = vi.spyOn(sandbox, 'spawn')
  try {
    const transcript = join(root, 'transcript.jsonl')
    const result = await runProcess(process.execPath, ['-e', 'process.stdin.pipe(process.stdout); console.log(process.env.TEST_API_KEY)'], { prompt: '', cwd: root, sandbox, env: { TAKT_TRANSCRIPT: transcript } }, { stdin: 'input\n' })
    expect(result.ok).toBe(true)
    expect(result.stdout).toContain('input')
    expect(result.stdout).toContain('[REDACTED]')
    expect(await readFile(transcript, 'utf8')).not.toContain('dummy-private-value')
    expect(spawn).toHaveBeenCalledTimes(1)
    const timed = await runProcess(process.execPath, ['-e', 'setInterval(()=>{},100)'], { prompt: '', cwd: root, sandbox, timeoutMs: 80 })
    expect(timed).toMatchObject({ ok: false, error: expect.stringContaining('timeout') })
    const controller = new AbortController()
    const pending = runProcess(process.execPath, ['-e', 'setInterval(()=>{},100)'], { prompt: '', cwd: root, sandbox, signal: controller.signal })
    setTimeout(() => controller.abort(), 80)
    expect(await pending).toMatchObject({ ok: false, error: expect.stringContaining('cancelled') })
  } finally { spawn.mockRestore(); await sandbox.dispose(); await rm(root, { recursive: true, force: true }) }
})
