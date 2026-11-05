import { randomUUID } from 'node:crypto'
import { mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { ChatStore, WorkspaceStore } from '../interfaces.js'
import type { ArtifactComment, ArtifactRecord, ArtifactRef, ArtifactVersion, Requirement } from '../types.js'
import { sha256 } from '../util/hash.js'
import { listFiles } from '../util/glob.js'
import { nextRequirementId } from '../util/ids.js'
import { extractTraceIds } from '../util/trace-ids.js'
import { appendLine, assertNoSymlinks, fileExists, isEnoent, readFileIfExists, readJsonFile, readJsonLines, toJsonText, writeFileAtomic } from './fs-utils.js'
import { FsChatStore } from './fs-chat.js'
import { withLock } from './locks.js'
import {
  assertArtifactPath,
  assertRequirementId,
  objectsDir,
  workspacesDir,
} from './paths.js'

type WriteArtifactInput = Parameters<WorkspaceStore['writeArtifact']>[0]
type AddCommentInput = Parameters<WorkspaceStore['addComment']>[1]
type CreateRequirementInput = Parameters<WorkspaceStore['createRequirement']>[0]

/** 存放区根目录下的元数据文件：不参与产物扫描，也不允许写成产物。 */
const META_FILES = new Set(['requirement.json', 'manifest.json', 'comments.jsonl'])

interface Manifest {
  artifacts: ArtifactRecord[]
}

const MEDIA_TYPES: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
}

function mediaTypeFor(artifactPath: string): string {
  return MEDIA_TYPES[path.extname(artifactPath).toLowerCase()] ?? 'application/octet-stream'
}

/** 含 NUL 字节的按二进制处理，不做追溯 ID 抽取。 */
function traceIdsOf(content: Buffer): string[] {
  if (content.includes(0)) return []
  return extractTraceIds(content.toString('utf8'))
}

export class FsWorkspaceStore implements WorkspaceStore {
  constructor(private readonly taktDir: string, private readonly root = workspacesDir(taktDir), private readonly chat: ChatStore = new FsChatStore(taktDir)) {}

  private metadata(id: string, name: string): string { return path.join(this.dir(id), name) }

  async listRequirements(): Promise<Requirement[]> {
    const root = this.root
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch (err) {
      if (isEnoent(err)) return []
      throw err
    }
    const requirements: Requirement[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const requirement = await this.readRequirement(path.join(root, entry.name, 'requirement.json'))
      if (requirement) requirements.push(requirement)
    }
    return requirements.sort((a, b) => a.id.localeCompare(b.id))
  }

  async getRequirement(id: string): Promise<Requirement | undefined> {
    return this.readRequirement(this.metadata(id, 'requirement.json'))
  }

  async createRequirement(input: CreateRequirementInput): Promise<Requirement> {
    const root = this.root
    return withLock(root, async () => {
      const existing = await this.listRequirements()
      const id = input.id !== undefined ? assertRequirementId(input.id) : nextRequirementId(existing.map((r) => r.id))
      const file = this.metadata(id, 'requirement.json')
      if (await fileExists(file)) throw new Error(`需求已存在：${id}`)
      const now = new Date().toISOString()
      const requirement: Requirement = {
        id,
        title: input.title,
        status: 'draft',
        links: input.links ?? [],
        createdAt: now,
        updatedAt: now,
      }
      if (input.owner !== undefined) requirement.owner = input.owner
      await mkdir(this.dir(id), { recursive: true })
      await writeFileAtomic(file, toJsonText(requirement))
      if (!(await fileExists(this.metadata(id, 'manifest.json')))) {
        await writeFileAtomic(this.metadata(id, 'manifest.json'), toJsonText({ artifacts: [] }))
      }
      await this.chat.ensureRoom(id, { title: input.title, members: [
        ...(input.owner ? [{ id: input.owner, kind: 'human' as const, name: input.owner }] : []),
        { id: 'lead', kind: 'lead', name: 'Lead' },
      ] })
      await this.chat.post(id, { author: { type: 'system', id: 'engine' }, kind: 'system', text: '需求已创建' })
      return requirement
    })
  }

  async updateRequirement(
    id: string,
    patch: Partial<Omit<Requirement, 'id' | 'createdAt'>>,
  ): Promise<Requirement> {
    const rid = assertRequirementId(id)
    const file = this.metadata(rid, 'requirement.json')
    return withLock(file, async () => {
      const current = await this.readRequirement(file)
      if (!current) throw new Error(`需求不存在：${rid}`)
      const next: Requirement = {
        ...current,
        ...patch,
        id: current.id,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
      }
      await writeFileAtomic(file, toJsonText(next))
      return next
    })
  }

  dir(id: string): string {
    return path.resolve(this.root, assertRequirementId(id))
  }

  async listArtifacts(id: string): Promise<ArtifactRecord[]> {
    const manifest = await this.readManifest(id)
    return manifest.artifacts.sort((a, b) => a.path.localeCompare(b.path))
  }

  async readArtifact(ref: ArtifactRef): Promise<Buffer | undefined> {
    const id = assertRequirementId(ref.workspace)
    const artifactPath = assertArtifactPath(ref.path)
    await assertNoSymlinks(this.root, path.join(this.dir(id), artifactPath))
    const manifest = await this.readManifest(id)
    const record = manifest.artifacts.find((r) => r.path === artifactPath)
    if (record) {
      const version =
        ref.version === undefined ? record.versions.at(-1) : record.versions.find((v) => v.version === ref.version)
      if (!version) return undefined
      const objectFile = path.join(objectsDir(this.taktDir), version.sha256)
      await assertNoSymlinks(this.taktDir, objectFile)
      const object = await readFileIfExists(objectFile)
      if (object === undefined) throw new Error(`产物对象缺失：${version.sha256}（${artifactPath} v${version.version}）`)
      return object
    }
    // 没登记过的文件也允许读：人刚放进存放区的物料还没经过引擎
    return ref.version === undefined ? readFileIfExists(path.join(this.dir(id), artifactPath)) : undefined
  }

  async writeArtifact(input: WriteArtifactInput): Promise<ArtifactRef & { version: number }> {
    const id = assertRequirementId(input.ref.workspace)
    const artifactPath = assertArtifactPath(input.ref.path)
    if (input.author.type === 'human' && !input.reason?.trim()) {
      throw new Error(`人工修改必须写 reason：${artifactPath}`)
    }
    const content = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content, 'utf8')
    const sha = sha256(content)
    const dir = this.dir(id)
    return withLock(dir, async () => {
      await assertNoSymlinks(this.root, path.join(dir, artifactPath))
      const manifest = await this.readManifest(id)
      const record = manifest.artifacts.find((r) => r.path === artifactPath)
      const latest = record?.versions.at(-1)
      if (record && latest && latest.sha256 === sha) {
        await writeFileAtomic(path.join(dir, artifactPath), content)
        return { workspace: id, path: artifactPath, version: latest.version }
      }
      const version: ArtifactVersion = {
        version: (latest?.version ?? 0) + 1,
        sha256: sha,
        size: content.byteLength,
        createdAt: new Date().toISOString(),
        author: input.author,
        reason: input.reason,
        derivedFrom: input.derivedFrom ?? [],
        producedBy: input.producedBy,
      }
      const traceIds = traceIdsOf(content)
      if (record) {
        record.kind = input.kind
        record.mediaType = mediaTypeFor(artifactPath)
        record.traceIds = traceIds
        if (input.title !== undefined) record.title = input.title
        if (input.tags !== undefined) record.tags = [...input.tags]
        record.versions.push(version)
      } else {
        manifest.artifacts.push({
          path: artifactPath,
          kind: input.kind,
          title: input.title,
          mediaType: mediaTypeFor(artifactPath),
          tags: input.tags ?? [],
          traceIds,
          versions: [version],
        })
      }
      const objectFile = path.join(objectsDir(this.taktDir), sha)
      await assertNoSymlinks(this.taktDir, objectFile)
      if (!(await fileExists(objectFile))) await writeFileAtomic(objectFile, content)
      await writeFileAtomic(path.join(dir, artifactPath), content)
      // manifest 最后写：它是这次版本的提交点，崩在中途只会留下无害的孤儿对象
      await writeFileAtomic(this.metadata(id, 'manifest.json'), toJsonText(manifest))
      return { workspace: id, path: artifactPath, version: version.version }
    })
  }

  async detectUntracked(id: string): Promise<Array<{ path: string; sha256: string }>> {
    const rid = assertRequirementId(id)
    const dir = this.dir(rid)
    const manifest = await this.readManifest(rid)
    const tracked = new Map(manifest.artifacts.map((r) => [r.path, r.versions.at(-1)?.sha256 ?? '']))
    const untracked: Array<{ path: string; sha256: string }> = []
    if (!(await fileExists(dir))) return untracked
    for (const rel of await listFiles(dir, ['**'], { ignore: [] })) {
      if (META_FILES.has(rel.toLowerCase())) continue
      await assertNoSymlinks(this.root, path.join(dir, rel))
      const buf = await readFileIfExists(path.join(dir, rel))
      if (buf === undefined) continue
      const sha = sha256(buf)
      if (tracked.get(rel) !== sha) untracked.push({ path: rel, sha256: sha })
    }
    return untracked
  }

  async listComments(id: string, artifactPath?: string): Promise<ArtifactComment[]> {
    const rid = assertRequirementId(id)
    if (artifactPath !== undefined) assertArtifactPath(artifactPath)
    const comments = await readJsonLines<ArtifactComment>(this.metadata(rid, 'comments.jsonl'))
    return artifactPath === undefined ? comments : comments.filter((c) => c.path === artifactPath)
  }

  async addComment(id: string, comment: AddCommentInput): Promise<ArtifactComment> {
    const rid = assertRequirementId(id)
    assertArtifactPath(comment.path)
    if (!Number.isInteger(comment.version) || comment.version < 1) {
      throw new Error(`评论的产物版本不合法：${comment.version}`)
    }
    const created: ArtifactComment = { ...comment, id: randomUUID(), createdAt: new Date().toISOString() }
    const file = this.metadata(rid, 'comments.jsonl')
    await withLock(file, async () => {
      await appendLine(file, JSON.stringify(created))
    })
    return created
  }

  private async readRequirement(file: string): Promise<Requirement | undefined> {
    const requirement = await readJsonFile<Requirement>(file)
    if (requirement === undefined) return undefined
    if (!requirement || typeof requirement.id !== 'string' || typeof requirement.title !== 'string') {
      throw new Error(`requirement.json 结构不合法：${file}`)
    }
    return requirement
  }

  private async readManifest(id: string): Promise<Manifest> {
    const file = this.metadata(id, 'manifest.json')
    await assertNoSymlinks(this.root, file)
    const manifest = await readJsonFile<Manifest>(file)
    if (manifest === undefined) return { artifacts: [] }
    if (!manifest || !Array.isArray(manifest.artifacts)) throw new Error(`manifest.json 结构不合法：${file}`)
    return manifest
  }
}
