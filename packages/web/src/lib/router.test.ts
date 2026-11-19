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
  vi.stubGlobal('window', { addEventListener() {}, scrollTo() {} })
  vi.stubGlobal('document', { querySelector: () => null })
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

it('从团队前往设备页时保留空间及演示、主题，不携带其它查询参数', async () => {
  const { router, url } = await openAt('/s/beta%20lab/team?mock=1&theme=dark&thread=old')
  expect(router.href('/devices')).toBe('/s/beta%20lab/devices?mock=1&theme=dark')
  router.navigate('/devices')
  expect(url.pathname + url.search).toBe('/s/beta%20lab/devices?mock=1&theme=dark')
})

it('旧团队房间打开同一空间内的管家讨论，个人管家独立于空间路径', async () => {
  const { url, router } = await openAt('/s/shop/team?theme=dark')
  expect(url.pathname).toBe('/s/shop/solo')
  expect(url.searchParams.get('room')).toBe('team')
  expect(router.href('/personal')).toBe('/personal?theme=dark')
  expect(router.href('/steward?room=team')).toBe('/s/shop/solo?room=team&theme=dark')
})
it('默认空间的面板和整页使用空间管家，直接访问旧 Solo 仍可看个人记录', async () => {
  const { router } = await openAt('/req/REQ-1')
  expect(router.href('/solo?thread=t')).toBe('/steward?thread=t')
  const { url } = await openAt('/solo?thread=private')
  expect(url.pathname).toBe('/solo')
})

it('带空间前缀的个人链接清理空间操作和草稿', async () => {
  const { url } = await openAt('/s/shop/personal?open=steward&ask=space-draft&theme=dark')
  expect(url.pathname + url.search).toBe('/personal?theme=dark')
})
