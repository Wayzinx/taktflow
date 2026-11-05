import { createHttpSource, probeApi } from './client'
import { createMockSource } from './mock'
import type { DataSource } from './source'

/** 独立页面：?mock=1 或 VITE_MOCK=1 强制演示数据；否则探测真实 API，不可达时回退到演示数据。 */
export async function pickSource(): Promise<DataSource> {
  const forced = new URLSearchParams(location.search).get('mock') === '1' || import.meta.env.VITE_MOCK === '1'
  if (!forced && (await probeApi())) return createHttpSource()
  return createMockSource()
}
