import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, basename, join, resolve, relative, isAbsolute, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { openProject, sha256 } from '@taktflow/core'
import { spaceId } from './space.js'
import { spaceLock } from './space-lock.js'
import { teamRoomService } from './team-room.js'
import { teamNodes, teamJobs, enqueueTeamJob } from './team-hub.js'
import { wechatClient, WeChatTransportError, type WeChatTurn, type WeChatAccount } from './wechat-wire.js'

interface Binding { project: string; space: string; member: string; wechatUser: string }
interface Checkpoint { binding: Binding; cursor: string; pending: WeChatTurn[]; sent: string[] }

async function privateJson(file: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) {
      throw new Error('请使用属于当前用户且仅本人可读写的微信文件（chmod 600）')
    }
    return JSON.parse(await handle.readFile('utf8'))
  } finally { await handle.close() }
}

async function save(file: string, state: Checkpoint) {
  const tmp = file + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(tmp, JSON.stringify(state), { mode: 0o600, flag: 'wx' })
    await rename(tmp, file)
  } finally { await rm(tmp, { force: true }) }
}

/** One authorized Tencent account runs in one space as its bound member.
 * No credentials are copied to the project or sent to the browser. */
export async function listenWeChat(projectDir: string, member: string, accountFile: string, signal: AbortSignal,
  report: (message: string) => void, fetcher: typeof fetch = fetch): Promise<void> {
  const project = await realpath(projectDir)
  const accountName = basename(accountFile)
  if (!accountName.endsWith('.json') || accountName === 'accounts.json' || /\.(sync|taktflow)\.json$/.test(accountName)) {
    throw new Error('请选择 openclaw-weixin/accounts/<账号ID>.json 中的具体微信账号文件')
  }
  const credential = join(await realpath(dirname(resolve(accountFile))), accountName)
  const rel = relative(project, credential)
  if (!rel.startsWith('..' + sep) && !isAbsolute(rel)) {
    throw new Error('微信账号凭证须保存在项目目录之外')
  }
  const account: WeChatAccount = await privateJson(credential)
  if (typeof account?.userId !== 'string' || !account.userId.trim() || typeof account.token !== 'string' || !account.token.trim()) {
    throw new Error('请先使用腾讯微信插件扫码授权，再选择带 userId 的本地账号文件')
  }
  const client = wechatClient(account, fetcher, signal)
  const initial = await openProject(project)
  const binding: Binding = { project, space: spaceId(initial), member, wechatUser: account.userId }
  const current = async () => {
    const [live, authorized] = await Promise.all([openProject(project), privateJson(credential)])
    if (authorized?.userId !== account.userId || authorized.token !== account.token || authorized.baseUrl !== account.baseUrl) {
      throw new Error('微信账号授权已变化，请核对绑定后重新启动接收')
    }
    if (spaceId(live) !== binding.space || member === 'web' ||
        !live.config.members?.some(entry => entry.id === member && entry.role !== 'viewer')) {
      throw new Error('微信绑定要求当前空间中具有发言权限的实名成员')
    }
    return live
  }
  await current()
  const room = teamRoomService(initial, {}, { teamNodes, teamJobs, enqueueTeamJob }, current, 'wechat')
  const file = credential + '.taktflow.json'
  await spaceLock(file, async () => {
    let state: Checkpoint
    try { state = await privateJson(file) }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      state = { binding, cursor: '', pending: [], sent: [] }
      await save(file, state)
    }
    if (!Array.isArray(state?.sent) || !Array.isArray(state.pending) || typeof state.cursor !== 'string') throw new Error('微信接收进度文件损坏')
    if (Object.entries(binding).some(([key, value]) => state.binding?.[key as keyof Binding] !== value)) {
      throw new Error('此微信账号已绑定到其他空间或成员')
    }
    report('微信已绑定到 ' + binding.space + ' / ' + member + '，正在接收文字私聊')
    let failures = 0
    while (!signal.aborted) {
      try {
        if (!state.pending.length) {
          await current()
          const batch = await client.poll(state.cursor)
          state.pending = batch.turns
          if (batch.cursor !== state.cursor || state.pending.length) {
            state.cursor = batch.cursor
            await save(file, state)
          }
        }
        while (state.pending.length && !signal.aborted) {
          const turn = state.pending[0]!
          const key = sha256(JSON.stringify([binding, turn.id]))
          if (!state.sent.includes(key)) {
            const { reply } = await room.submit({ type: 'human', id: member }, { mode: 'chat', requestId: 'wechat:' + key, text: turn.text })
            await current()
            await client.reply(turn, 'takt-' + key, reply.text)
            state.sent.push(key)
            state.sent = state.sent.slice(-512)
          }
          state.pending.shift()
          await save(file, state)
        }
        failures = 0
      } catch (error) {
        if (signal.aborted) return
        if (!(error instanceof WeChatTransportError) || !error.retryable) throw error
        report(error.message + '，稍后重试')
        await delay(Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)), undefined, { signal }).catch(() => {})
      }
    }
  })
}
