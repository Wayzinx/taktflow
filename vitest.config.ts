import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    // 很多用例会拉起子进程（CLI / harness 适配器），机器负载高时 5s 默认值会偶发超时。
    testTimeout: 20_000,
  },
})
