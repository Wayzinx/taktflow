/** Harness × 模型选择器的数据形状（docs/design/32 §6）；不依赖 React，转换逻辑和测试直接用。 */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface PickerModel {
  /** 组内唯一 */
  key: string
  /** 选中后写进去的值：模型别名或厂商模型 ID；空 = harness 自带的默认模型 */
  model?: string
  /** 也算这个模型的其他写法（配了别名的厂商 ID） */
  aliases?: string[]
  /** 只用来说明、不能选的行（如搭不上的 provider） */
  info?: boolean
  provider?: string
  label: string
  /** 名字下面的小字（同名模型写出 ID） */
  detail?: string
  tags?: string[]
  efforts?: Effort[]
  defaultEffort?: Effort
  /** 模型没声明支持哪些档，efforts 是 harness 的常用档：多给一个「默认」（不指定） */
  effortGuess?: boolean
  available: boolean
  reason?: string
}

export interface PickerGroup {
  key: string
  label: string
  icon?: string
  /** 组名旁的说明：自带 / 直连 / 经协议桥 */
  note?: string
  /** 组名下一行的补充：列取失败、缺密钥、协议怎么转 */
  hint?: string
  models: PickerModel[]
}

export interface PickerHarness {
  id: string
  name: string
  icon?: string
  /** 不选 provider 时用谁的额度，如「使用个人 Claude 订阅」 */
  own?: string
  available: boolean
  reason?: string
  /** 当前默认 / 推荐 */
  badge?: string
  groups: PickerGroup[]
}

export interface PickerValue {
  harness: string
  provider?: string
  model?: string
  effort?: Effort
}

/** 别名、厂商 ID 都认；provider 两边都写了才比。 */
export function sameModel(m: PickerModel, v: Pick<PickerValue, 'model' | 'provider'>): boolean {
  if (m.info) return false
  const model = v.model ?? ''
  if ((m.model ?? '') !== model && !m.aliases?.includes(model)) return false
  return !v.provider || !m.provider || v.provider === m.provider
}
