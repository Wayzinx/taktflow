import type { SandboxProvider, TaktConfig } from '@taktflow/core'
import { createLocalSandboxProvider } from './local.js'
import { createBwrapSandboxProvider } from './bwrap.js'
import { createDockerSandboxProvider } from './docker.js'

export async function selectSandboxProvider(config: TaktConfig['sandbox'], platform: NodeJS.Platform = process.platform): Promise<SandboxProvider> {
  const kind = config?.provider ?? 'local'
  let provider: SandboxProvider
  if (kind === 'local') provider = createLocalSandboxProvider()
  else if (kind === 'bwrap') {
    if (platform !== 'linux') throw new Error(`Sandbox bwrap requires Linux; current platform: ${platform}`)
    provider = createBwrapSandboxProvider()
  } else if (kind === 'docker') {
    if (!config?.image) throw new Error('Sandbox docker requires an image in sandbox.image')
    provider = createDockerSandboxProvider({ image: config.image })
  } else throw new Error(`Unknown sandbox provider: ${kind}`)
  const available = await provider.available()
  if (!available.ok) throw new Error(`Sandbox ${kind} unavailable: ${available.reason ?? 'probe failed'}`)
  return {
    ...provider,
    create: spec => provider.create({ ...spec, network: spec.network ?? config?.network, image: spec.image ?? config?.image }),
  }
}
