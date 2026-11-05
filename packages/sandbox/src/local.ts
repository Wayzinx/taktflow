import type { SandboxProvider } from '@taktflow/core'
import { launch, managedSandbox, sandboxEnv } from './runtime.js'

export function createLocalSandboxProvider(): SandboxProvider {
  return {
    id: 'local',
    async available() { return { ok: true } },
    async create(spec) {
      return managedSandbox('local', spec, (command, args, opts) => launch(command, args, {
        cwd: opts?.cwd ?? spec.workdir, env: sandboxEnv(spec.env, opts?.env), stdin: opts?.stdin,
      }), path => path)
    },
  }
}
