import { randomBytes } from 'node:crypto'

export function newRunId(now: Date = new Date()): string {
  if (Number.isNaN(now.getTime())) throw new Error('无法为无效日期生成运行 ID')
  const pad = (value: number) => String(value).padStart(2, '0')
  const date = `${String(now.getFullYear()).padStart(4, '0')}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `run-${date}-${time}-${randomBytes(2).toString('hex')}`
}

export function nextRequirementId(existing: string[]): string {
  let max = 0n
  for (const id of existing) {
    const match = /^REQ-(\d+)$/.exec(id)
    if (match) {
      const value = BigInt(match[1]!)
      if (value > max) max = value
    }
  }
  return `REQ-${String(max + 1n).padStart(3, '0')}`
}
