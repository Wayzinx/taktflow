import { rm } from 'node:fs/promises'
import type { Actor } from '../types.js'
import type { ProjectStores } from '../interfaces.js'
import type { CommandRegistry } from '../commands/contracts.js'
import { requireRole } from '../commands/permissions.js'
import { validateSchema } from '../engine/schema.js'
import { withFileLock } from '../store/file-lock.js'
import { readFileIfExists, writeFileAtomic } from '../store/fs-utils.js'
import { sha256 } from '../util/hash.js'
import { stewardFile } from './files.js'

// 仅供撤销调用；公开提案仍使用原命令表的写入口。
export function stewardUndoCommands(stores: ProjectStores, commands: CommandRegistry, audit: (by: Actor, reason: string, message: string) => Promise<void>): CommandRegistry {
  const text = { type: 'string' }
  const inverses = [
    { id: 'steward.file.restore', title: '恢复提案前文件', kind: 'command' as const, risk: 'dangerous' as const, minRole: 'maintainer' as const,
      input: { type: 'object', required: ['path', 'content', 'baseHash'], properties: { path: text, content: {}, baseHash: text } } },
    ...(stores.kb ? [{ id: 'steward.knowledge.remove', title: '撤销新建知识库', kind: 'command' as const, risk: 'dangerous' as const, minRole: 'maintainer' as const,
      input: { type: 'object', required: ['id'], properties: { id: text } } }] : []),
  ]
  return {
    list: () => [...commands.list(), ...inverses],
    async run(id, input, context) {
      const spec = inverses.find((item) => item.id === id)
      if (!spec) return commands.run(id, input, context)
      try {
        validateSchema(input, spec.input)
        requireRole(stores, context.actor, 'maintainer', spec.title)
        if (!context.reason?.trim()) throw new Error('撤销必须说明原因，请重新提交')
        if (id === 'steward.knowledge.remove') await stores.kb!.remove(String(input.id), context.actor, context.reason)
        else {
          if (input.content !== null && typeof input.content !== 'string') throw new Error('原文件内容不合法，请核对撤销记录')
          const file = await stewardFile(stores.projectDir, String(input.path), true)
          await withFileLock(file, async () => {
            await stewardFile(stores.projectDir, String(input.path), true)
            if (sha256(await readFileIfExists(file) ?? '') !== input.baseHash) throw new Error('文件已变化，请重新生成提案')
            await audit(context.actor, context.reason!, JSON.stringify({ action: id, path: input.path, phase: 'requested' }))
            if (input.content === null) await rm(file, { force: true })
            else await writeFileAtomic(file, input.content as string)
          })
        }
        await audit(context.actor, context.reason, JSON.stringify({ action: id, path: input.path, id: input.id, phase: 'finished' }))
        return { ok: true, message: `${spec.title}已执行` }
      } catch (error) { return { ok: false, message: `撤销失败，请核对目标：${String(error)}` } }
    },
  }
}
