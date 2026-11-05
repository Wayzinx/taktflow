import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { linuxBashArgs } from './linux-bash.js'
import { access, lstat, readdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { checkAbort } from './abort.js'
import type { ToolPaths } from './paths.js'

const sandbox = '/usr/bin/sandbox-exec'
const runtime = ['/bin', '/usr/bin', '/usr/lib', '/System/Library', '/Library/Apple/System/Library']
const maxOutput = 1_000_000

export async function sandboxAvailable(): Promise<boolean> {
  if (process.platform === 'linux') {
    try {
      await promisify(execFile)('bwrap', ['--die-with-parent', '--unshare-pid', '--unshare-net', '--ro-bind', '/', '/', '--', '/bin/true'], { timeout: 5_000 })
      return true
    } catch { return false }
  }
  if (process.platform !== 'darwin') return false
  try { await access(sandbox, constants.X_OK); return true } catch { return false }
}

// SBPL 不接受 JS RegExp；这里只编译沙箱过滤器，实际路径判定仍使用 core.matchGlob。
function sandboxGlob(pattern: string): string {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!
    if (char === '*' && pattern[i + 1] === '*' && (i === 0 || pattern[i - 1] === '/') && (i + 2 === pattern.length || pattern[i + 2] === '/')) {
      if (pattern[i + 2] === '/') { source += '([^/]+/)*'; i += 2 }
      else { source += '.*'; i++ }
    } else if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else source += char.replace(/[.\[\]{}()+^$|\\]/g, '\\$&')
  }
  return source
}

async function inspectTree(paths: ToolPaths, dir = paths.root): Promise<void> {
  checkAbort(paths.signal)
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    checkAbort(paths.signal)
    const path = join(dir, entry.name)
    const info = await lstat(path)
    // Shell 可自行选择别名路径；禁止整棵树中的符号链接，避免词法权限被别名绕开。
    if (info.isSymbolicLink()) throw new Error('bash requires a cwd tree without symlinks')
    if (info.isDirectory()) await inspectTree(paths, path)
    else if (!info.isFile()) throw new Error('bash requires regular files in cwd')
    else if (paths.allows(paths.relative(path)) && info.nlink !== 1) throw new Error('bash refuses writable hardlinks')
  }
}

function profile(paths: ToolPaths): string {
  const quote = JSON.stringify
  const ancestors: string[] = []
  for (let path = dirname(paths.root); ; path = dirname(path)) {
    ancestors.push(path)
    if (path === dirname(path)) break
  }
  const read = [...runtime, paths.root].map((path) => `(subpath ${quote(path)})`)
  read.push(...[...ancestors, '/dev/null', '/dev/urandom'].map((path) => `(literal ${quote(path)})`))
  const root = paths.root.replace(/[.\[\]{}()*+?^$|\\]/g, '\\$&')
  // SBPL 的 #"..." 保留正则反斜线，不采用 JSON 字符串的二次转义。
  const write = paths.scope.map((pattern) => `(regex #${quote(`^${root}/${sandboxGlob(pattern)}$`).replace(/\\\\/g, '\\')})`)
  return [
    '(version 1)', '(deny default)',
    `(allow file-read* ${read.join(' ')})`,
    `(allow process-exec ${runtime.map((path) => `(subpath ${quote(path)})`).join(' ')})`,
    '(allow process-fork)', '(allow signal (target self))', '(allow sysctl-read)',
    // 禁止脱离进程组；posix_spawn 的属性也能新建会话，必须一起封住。
    '(deny syscall-unix (syscall-number SYS_setsid SYS_setpgid SYS_posix_spawn))',
    '(deny file-link)',
    // 不授予目录数据、unlink 或 metadata 权限；父目录权限不能扩大到未授权文件。
    ...(write.length ? [`(allow file-write-data file-write-create (require-all (vnode-type REGULAR-FILE) (require-any ${write.join(' ')})))`] : []),
  ].join('\n')
}

export async function runBash(command: string, paths: ToolPaths): Promise<string> {
  if (!await sandboxAvailable()) throw new Error('bash requires macOS sandbox-exec or usable Linux bwrap; unsupported host, command was not executed')
  await inspectTree(paths)
  const linux = process.platform === 'linux'
  const args = linux ? await linuxBashArgs(paths) : ['-p', profile(paths)]
  checkAbort(paths.signal)
  return new Promise<string>((resolve, reject) => {
    const child = spawn(linux ? 'bwrap' : sandbox, [...args, ...(linux ? ['--'] : []), '/bin/bash', '--noprofile', '--norc', '-c', command], {
      cwd: paths.root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      // 不继承 API key、BASH_ENV、DYLD_* 或用户的启动脚本。
      env: { PATH: '/usr/bin:/bin', HOME: paths.root, TMPDIR: paths.root, LANG: 'C', LC_ALL: 'C' },
    })
    let output = ''
    let failure: Error | undefined
    const terminate = () => {
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL')
        }
      }
    }
    const abort = () => { failure = new Error('bash cancelled or timed out'); terminate() }
    const collect = (chunk: Buffer) => {
      output += chunk.toString('utf8')
      if (output.length > maxOutput) { output = output.slice(0, maxOutput); failure = new Error('bash output limit exceeded'); terminate() }
    }
    paths.signal.addEventListener('abort', abort, { once: true })
    if (paths.signal.aborted) abort()
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.once('error', (error) => { paths.signal.removeEventListener('abort', abort); reject(error) })
    // 即使 shell 正常退出，也清理继承进程组的后台任务，禁止请求结束后的写操作。
    child.once('exit', terminate)
    child.once('close', (code, signal) => {
      paths.signal.removeEventListener('abort', abort)
      if (failure) reject(failure)
      else if (code !== 0) reject(new Error(`bash exited ${code ?? signal}: ${output}`))
      else resolve(output)
    })
  })
}
