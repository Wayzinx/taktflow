import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const entry = fileURLToPath(new URL('../../cli/src/standalone-link.ts', import.meta.url))
const name = 'downloads/taktflow-link.mjs'

// Build from the same client as the CLI. The downloaded file uses only Node built-ins.
async function bundle() {
  const result = await build({
    configFile: false, publicDir: false, logLevel: 'error',
    build: {
      ssr: entry, write: false, target: 'node20', minify: false,
      rollupOptions: { output: { format: 'es', inlineDynamicImports: true } },
    },
  })
  const chunk = result.output.find(item => item.type === 'chunk' && item.isEntry)
  if (!chunk || chunk.imports.some(id => !id.startsWith('node:'))) throw new Error('Link 下载包依赖不完整')
  return chunk.code
}

export function linkDownload() {
  return {
    name: 'taktflow-link-download',
    async generateBundle() {
      this.emitFile({ type: 'asset', fileName: name, source: await bundle() })
    },
    configureServer(server) {
      server.middlewares.use('/' + name, async (request, response, next) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') return next()
        try {
          const data = await bundle()
          response.setHeader('Content-Type', 'text/javascript; charset=utf-8')
          response.setHeader('Cache-Control', 'no-cache')
          response.end(request.method === 'HEAD' ? undefined : data)
        } catch (error) { next(error) }
      })
    },
  }
}
