/** 技能上传：浏览器里的文件 / 拖进来的文件夹 → { path, base64 }，和服务端 skill-import 的上限一致。 */

export interface PickedFile {
  path: string
  file: File
}

export const UPLOAD_LIMIT = 30 * 1024 * 1024
export const FILE_LIMIT = 5 * 1024 * 1024
const JUNK = new Set(['.git', '.DS_Store', '__MACOSX', 'Thumbs.db'])

export const isJunk = (path: string) => path.split('/').some((seg) => JUNK.has(seg))

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

export async function toBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** <input type=file> 选的：文件夹带 webkitRelativePath，单个文件只有名字。 */
export function fromInput(list: FileList | null): PickedFile[] {
  return [...(list ?? [])].map((file) => ({ path: file.webkitRelativePath || file.name, file })).filter((f) => !isJunk(f.path))
}

async function entryFiles(entry: FileSystemEntry, prefix: string): Promise<PickedFile[]> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject))
    return [{ path: prefix + entry.name, file }]
  }
  if (!entry.isDirectory) return []
  const reader = (entry as FileSystemDirectoryEntry).createReader()
  const all: FileSystemEntry[] = []
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
    if (!batch.length) break
    all.push(...batch)
  }
  return (await Promise.all(all.map((e) => entryFiles(e, `${prefix}${entry.name}/`)))).flat()
}

/** 拖进来的东西：文件夹要逐层读（dataTransfer.files 里只有顶层）。 */
export async function fromDrop(data: DataTransfer): Promise<PickedFile[]> {
  const entries = [...data.items].map((item) => item.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e)
  const picked = entries.length ? (await Promise.all(entries.map((e) => entryFiles(e, '')))).flat() : fromInput(data.files)
  return picked.filter((f) => !isJunk(f.path))
}
