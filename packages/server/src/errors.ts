/** 传输无关的业务错误：node:http 和 dsh 适配层都把它映射成对应的响应。 */
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly detail?: unknown) {
    super(message)
    this.name = 'ApiError'
  }
}
