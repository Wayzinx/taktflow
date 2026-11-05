import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function readOptional(file: string): Promise<string | undefined> {
  try { return await readFile(file, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

// core 的文件原子写入未从公共入口导出，包间不能依赖其内部路径。
export async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    let mode: number | undefined
    try { mode = (await stat(file)).mode } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await writeFile(temp, text, { flag: 'wx', mode })
    await rename(temp, file)
  } finally { await rm(temp, { force: true }) }
}

export function assertId(id: string): void {
  if (!id || id === '.' || id === '..' || /[\\/\0]/.test(id)) throw new Error(`非法 workflow id：${id}`)
}
