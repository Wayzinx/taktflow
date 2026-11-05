import type { SandboxProvider } from '@taktflow/core'
import { collect, launch, managedSandbox, mappedHostPath, probe, sandboxEnv } from './runtime.js'

export function createDockerSandboxProvider(options: { image: string }): SandboxProvider {
  return {
    id: 'docker',
    available: () => probe('docker', ['info']),
    async create(spec) {
      const args = ['run', '-d', '--rm', '--init']
      for (const mount of spec.mounts) args.push('-v', `${mount.source}:${mount.target}:${mount.mode}`)
      if (spec.network === 'none') args.push('--network', 'none')
      if (spec.limits?.cpus !== undefined) args.push('--cpus', String(spec.limits.cpus))
      if (spec.limits?.memoryMb !== undefined) args.push('--memory', `${spec.limits.memoryMb}m`)
      args.push('--workdir', spec.workdir, '--entrypoint', 'sleep', spec.image ?? options.image, 'infinity')
      const created = await collect(launch('docker', args), undefined, 120_000)
      if (created.code !== 0) throw new Error(`docker run failed (exit ${created.code})`)
      const id = created.stdout.trim()
      if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error('docker run returned an invalid container ID')
      let removal: Promise<void> | undefined
      const remove = () => removal ??= (async () => {
        const result = await collect(launch('docker', ['rm', '-f', id]), undefined, 30_000)
        if (result.code !== 0 && !result.stderr.includes('No such container')) throw new Error(`docker rm failed (exit ${result.code})`)
      })()
      return managedSandbox('docker', spec, (command, commandArgs, opts) => {
        const env = sandboxEnv(spec.env, opts?.env)
        const execArgs = ['exec', '-i', '-w', opts?.cwd ?? spec.workdir]
        for (const [key, value] of Object.entries(env)) execArgs.push('-e', `${key}=${value}`)
        // 镜像自带的 ENV 也不能隐式成为 agent 的凭据来源。
        execArgs.push(id, 'env', '-i', ...Object.entries(env).map(([key, value]) => `${key}=${value}`), command, ...commandArgs)
        const child = launch('docker', execArgs, { stdin: opts?.stdin })
        const kill = child.kill.bind(child)
        child.kill = signal => {
          // 只杀 docker exec 客户端不会终止容器中的任务；取消时回收整个任务容器。
          void remove().then(() => { kill(signal) }, error => {
            child.emit('error', error)
            kill('SIGKILL')
          })
          return true
        }
        return child
      }, path => mappedHostPath(path, spec.mounts, false), remove, id)
    },
  }
}
