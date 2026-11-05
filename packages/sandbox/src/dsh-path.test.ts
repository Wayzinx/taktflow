import { afterEach, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { runProcess } from '../../harness/src/process.js'
vi.mock('../../harness/src/process.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../harness/src/process.js')>(), runProcess: vi.fn(),
}))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules() })
it('Linux only tries DSH_BIN then PATH, without a macOS installation fallback', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  vi.stubEnv('DSH_BIN', '/configured/dsh')
  vi.mocked(runProcess).mockResolvedValue({ ok: false, stdout: '', stderr: '', spawnErrorCode: 'ENOENT', error: 'missing' })
  const { createDshHarness } = await import('../../harness/src/dsh.js')
  expect((await createDshHarness().run({ prompt: 'test', cwd: tmpdir() }, () => {})).ok).toBe(false)
  expect(vi.mocked(runProcess).mock.calls.map(call => call[0])).toEqual(['/configured/dsh', 'dsh'])
})
