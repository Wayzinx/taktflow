import { dirname } from 'node:path'
import type { KnowledgeKindContext, SandboxProvider } from '@taktflow/core'
export async function readSource(file: string, ctx: KnowledgeKindContext): Promise<string> {
  ctx.signal?.throwIfAborted()
  const moduleName = '@taktflow/sandbox'
  const adapters = await import(moduleName) as { selectSandboxProvider(config: typeof ctx.stores.config.sandbox): Promise<SandboxProvider> }
  const provider = await adapters.selectSandboxProvider(ctx.stores.config.sandbox)
  const root = dirname(file)
  const sandbox = await provider.create({ workdir: root, mounts: [{ source: root, target: root, mode: 'ro' }], network: 'none', image: ctx.stores.config.sandbox?.image, limits: { timeoutMs: 10000 } })
  const abort = () => { void sandbox.dispose() }
  ctx.signal?.addEventListener('abort', abort, { once: true })
  try {
    const result = await sandbox.exec('node', ['-e', "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))", file], { timeoutMs: 10000 })
    ctx.signal?.throwIfAborted()
    if (result.code !== 0) throw Object.assign(new Error('沙箱读取文档失败，请检查文件权限、Node 环境和沙箱设置'), { ref: file })
    return result.stdout
  } finally { ctx.signal?.removeEventListener('abort', abort); await sandbox.dispose() }
}
