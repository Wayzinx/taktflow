import { createProviderBridge } from '@taktflow/harness'

// 所有空间与引擎共用一个惰性监听，CLI 退出和 serve 收尾统一关闭。
export const processBridge = createProviderBridge()
process.once('beforeExit', () => { void processBridge.close() })
