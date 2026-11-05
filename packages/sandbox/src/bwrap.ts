import type { SandboxProvider } from '@taktflow/core'
import { launch, managedSandbox, mappedHostPath, probe, sandboxEnv } from './runtime.js'

export function createBwrapSandboxProvider(): SandboxProvider {
  return {
    id: 'bwrap',
    async available() {
      if (process.platform !== 'linux') return { ok: false, reason: 'bwrap requires Linux' }
      return probe('bwrap', ['--version'])
    },
    async create(spec) {
      return managedSandbox('bwrap', spec, (command, args, opts) => {
        const flags = ['--die-with-parent', '--new-session', '--unshare-pid', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp']
        for (const mount of spec.mounts) flags.push(mount.mode === 'rw' ? '--bind' : '--ro-bind', mount.source, mount.target)
        if (spec.network === 'none') flags.push('--unshare-net')
        flags.push('--clearenv')
        for (const [key, value] of Object.entries(sandboxEnv(spec.env, opts?.env))) flags.push('--setenv', key, value)
        flags.push('--chdir', opts?.cwd ?? spec.workdir, '--', command, ...args)
        return launch('bwrap', flags, { env: sandboxEnv(), stdin: opts?.stdin })
      }, path => mappedHostPath(path, spec.mounts, true))
    },
  }
}
