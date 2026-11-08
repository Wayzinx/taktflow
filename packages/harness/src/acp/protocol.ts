export type ObjectValue = Record<string, unknown>

export function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ACP 协议对象无效，请检查 agent 的协议版本')
  return value as ObjectValue
}

export function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('ACP 协议字符串无效，请检查 agent 输出')
  return value
}

export function optionalObject(value: unknown): ObjectValue {
  return value == null ? {} : object(value)
}

export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('ACP 协议数组无效，请检查 agent 输出')
  return value
}

export class RpcError extends Error {
  constructor(readonly code: number, message: string) { super(message) }
}
