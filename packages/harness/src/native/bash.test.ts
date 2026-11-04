import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm, access, link, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolPaths } from './paths.js'
import { runBash, sandboxAvailable } from './bash.js'

const dirs: string[] = []
async function temp() { const dir = await mkdtemp(join(tmpdir(), 'takt-bash-')); dirs.push(dir); return dir }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

const available = await sandboxAvailable()
describe.skipIf(!available)('real macOS bash sandbox', () => {
  it('actually creates and updates allowed files', async () => {
    const cwd = await temp(); await mkdir(join(cwd, 'allowed'))
    const paths = await ToolPaths.create(cwd, ['allowed/**'], new AbortController().signal)
    expect(await runBash('printf first > allowed/result.txt; printf second >> allowed/result.txt; cat allowed/result.txt', paths)).toBe('firstsecond')
    expect(await readFile(join(cwd, 'allowed', 'result.txt'), 'utf8')).toBe('firstsecond')
  })

  it('supports exact files and nested glob scopes', async () => {
    const cwd = await temp(); await mkdir(join(cwd, 'allowed', 'deep'), { recursive: true })
    const paths = await ToolPaths.create(cwd, ['allowed/**/*.txt', 'exact'], new AbortController().signal)
    await runBash('printf a > allowed/top.txt; printf b > allowed/deep/nested.txt; printf c > exact', paths)
    expect(await readFile(join(cwd, 'allowed/deep/nested.txt'), 'utf8')).toBe('b')
    expect(await readFile(join(cwd, 'exact'), 'utf8')).toBe('c')
    await expect(runBash('printf bad > allowed/deep/no.js', paths)).rejects.toThrow()
    await expect(access(join(cwd, 'allowed/deep/no.js'))).rejects.toThrow()
  })

  it('denies out-of-scope, outside cwd, and ancestor directory mutations before side effects', async () => {
    const cwd = await temp(); const outside = await temp()
    await mkdir(join(cwd, 'allowed')); await mkdir(join(cwd, 'denied'))
    await writeFile(join(cwd, 'denied', 'keep'), 'keep')
    await writeFile(join(outside, 'keep'), 'outside')
    const paths = await ToolPaths.create(cwd, ['allowed/**'], new AbortController().signal)
    const commands = [
      'printf bad > denied/new', `printf bad > '${join(outside, 'keep')}'`,
      'mv denied allowed/stolen', 'rm denied/keep', 'mv allowed gone', 'rmdir allowed',
      `cat '${join(outside, 'keep')}'`, 'ln denied/keep allowed/link', 'ln -s ../denied/keep allowed/link',
      'mkdir allowed/newdir',
    ]
    for (const command of commands) await expect(runBash(command, paths), command).rejects.toThrow()
    expect(await readFile(join(cwd, 'denied', 'keep'), 'utf8')).toBe('keep')
    expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('outside')
    await expect(access(join(cwd, 'denied', 'new'))).rejects.toThrow()
    await expect(access(join(cwd, 'allowed', 'link'))).rejects.toThrow()
    await expect(access(join(cwd, 'allowed', 'newdir'))).rejects.toThrow()
  })

  it('refuses writable hardlink aliases before launching any command', async () => {
    const cwd = await temp(); const outside = await temp()
    await mkdir(join(cwd, 'allowed')); await writeFile(join(outside, 'keep'), 'outside')
    await link(join(outside, 'keep'), join(cwd, 'allowed', 'alias'))
    const paths = await ToolPaths.create(cwd, ['allowed/**'], new AbortController().signal)
    await expect(runBash('printf changed > allowed/alias; printf marker > allowed/marker', paths)).rejects.toThrow('hardlinks')
    expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('outside')
    await expect(access(join(cwd, 'allowed', 'marker'))).rejects.toThrow()
  })

  it('documents and enforces the conservative symlink-tree restriction', async () => {
    const cwd = await temp(); await mkdir(join(cwd, 'allowed')); await mkdir(join(cwd, 'modules'))
    await symlink(join(cwd, 'allowed'), join(cwd, 'modules', 'workspace'))
    const paths = await ToolPaths.create(cwd, ['allowed/**'], new AbortController().signal)
    await expect(runBash('printf changed > allowed/new', paths)).rejects.toThrow('without symlinks')
  })

  it('terminates shell and its background descendants on cancellation', async () => {
    const cwd = await temp(); const controller = new AbortController()
    const paths = await ToolPaths.create(cwd, ['**'], controller.signal)
    const pending = runBash('(sleep 1; printf escaped > later) & wait', paths)
    setTimeout(() => controller.abort(), 80)
    await expect(pending).rejects.toThrow('cancelled')
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await expect(access(join(cwd, 'later'))).rejects.toThrow()
  })

  it('kills background children even after the shell exits normally', async () => {
    const cwd = await temp(); const paths = await ToolPaths.create(cwd, ['**'], new AbortController().signal)
    await runBash('(sleep 1; printf escaped > later) & printf done', paths)
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await expect(access(join(cwd, 'later'))).rejects.toThrow()
  })

  it('prevents descendants from escaping their process group with setsid', async () => {
    const cwd = await temp(); const paths = await ToolPaths.create(cwd, ['**'], new AbortController().signal)
    const output = await runBash("/usr/bin/perl -e 'use POSIX; die qq(session escape) if POSIX::setsid() != -1; print qq(blocked)'", paths)
    expect(output).toBe('blocked')
  })

  it('does not pass inherited credentials or BASH_ENV into the child', async () => {
    const cwd = await temp(); const paths = await ToolPaths.create(cwd, [], new AbortController().signal)
    const output = await runBash('printf "%s:%s" "${HOME}" "${NATIVE_TEST_API_KEY-unset}"', paths)
    expect(output).toBe(`${paths.root}:unset`)
  })
})

it('refuses unsupported platforms without executing a shell', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  const cwd = await temp(); const paths = await ToolPaths.create(cwd, ['**'], new AbortController().signal)
  await expect(runBash('printf unsafe > escaped', paths)).rejects.toThrow('unsupported host')
  await expect(access(join(cwd, 'escaped'))).rejects.toThrow()
})
