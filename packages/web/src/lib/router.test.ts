/**
 * 旧地址在跳转前和打开页面时换成现在的地址（管家整页并入 Solo 等）。
 * vitest 跑在 node 环境：路由模块加载时就读 location / history / window，先放一个假地址栏再动态导入。
 */
import { afterEach, expect, it, vi } from 'vitest'

async function openAt(path: string) {
  const url = new URL(path, 'http://app.test')
  const move = (_: unknown, __: string, to: string) => {
    url.href = new URL(to, url.origin).href
  }
  vi.stubGlobal('location', url)
  vi.stubGlobal('history', { state: null, replaceState: move, pushState: move })
  vi.stubGlobal('window', { addEventListener() {} })
  vi.resetModules()
  return { url, router: await import('./router') }
}

afterEach(() => vi.unstubAllGlobals())

it('打开旧的管家地址：原地换成 Solo，查询参数不丢', async () => {
  const { url } = await openAt('/s/shop/steward?thread=t1&proposal=p1')
  expect(url.pathname + url.search).toBe('/s/shop/solo?thread=t1&proposal=p1')
})

it('站内链接指向旧地址时直接给现在的地址：管家页、管家设置、/settings/:tab', async () => {
  const { router } = await openAt('/s/shop/req/REQ-1')
  expect(router.href('/steward?thread=t1')).toBe('/s/shop/solo?thread=t1')
  expect(router.href('/settings?tab=steward')).toBe('/s/shop/solo?drawer=settings')
  expect(router.href('/s/other/settings/repos')).toBe('/s/other/settings?tab=repos')
  expect(router.href('/settings?tab=repos')).toBe('/s/shop/settings?tab=repos')
})
