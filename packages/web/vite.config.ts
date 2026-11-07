import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 开发代理：默认指向 takt serve 的 4870；联调别的端口时用 TAKT_API=http://127.0.0.1:4883 npm run dev -w @taktflow/web
const api = process.env.TAKT_API ?? 'http://127.0.0.1:4870'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: api,
        changeOrigin: true,
        // 服务端写请求校验 Origin（只放行同源与 localhost:5173）：经代理转发的请求在服务端看来就是同源的，
        // 把 Origin 改成目标地址，dev server 换端口（--port 5175）时写操作也不会被 403
        configure: (proxy) => proxy.on('proxyReq', (req) => req.getHeader('origin') && req.setHeader('origin', api)),
      },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 900 },
})
