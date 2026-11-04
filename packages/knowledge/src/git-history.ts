import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import type { KnowledgeHit, KnowledgeSource } from '@taktflow/core'

function git(root: string, args: string[]): Promise<string> {
  return new Promise((accept, reject) => {
    execFile('git', args, {
      cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C' },
    }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr }))
      else accept(stdout)
    })
  })
}

export function createGitHistorySource(options: { root: string }): KnowledgeSource {
  const root = resolve(options.root)
  return {
    id: 'git-history', kind: 'git-history', intents: ['history', 'symbol'],
    describe: () => '通过 git log -S 字面查找最近 10 条相关提交，返回提交标题和改动文件。',
    async query(q) {
      if (!q.text) return []
      try {
        const scope = q.scope?.map(path => `:(literal)${path}`) ?? []
        const output = await git(root, [
          'log', '-10', '-S', q.text, '--format=%H%x00%s',
          '-z', '--no-ext-diff', '--no-textconv', '--', ...scope,
        ])
        if (!output) return []
        // -z 终止每条记录，每条固定两个字段；标题内容不参与边界判断。
        const fields = output.split('\0')
        if (fields.pop() !== '' || fields.length % 2 !== 0) {
          throw new Error('git log 返回的提交元数据字段不完整')
        }
        const hits: KnowledgeHit[] = []
        const fetchedAt = new Date().toISOString()
        for (let index = 0; index < fields.length; index += 2) {
          const hash = fields[index]!
          const title = fields[index + 1]!
          if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(hash)) {
            throw new Error('git log 返回了无效的提交 hash')
          }
          // 文件列表单独读取，路径中的十六进制串、换行和制表符均原样保留。
          const fileOutput = await git(root, [
            'show', hash, '--format=', '--name-only', '-z', '-S', q.text,
            '--no-ext-diff', '--no-textconv', '--', ...scope,
          ])
          const files = fileOutput ? fileOutput.split('\0') : []
          if (fileOutput && files.pop() !== '') {
            throw new Error(`git show 返回的文件列表不完整（${hash}）`)
          }
          hits.push({
            sourceId: 'git-history', title, ref: hash,
            snippet: [title, ...files].join('\n'), score: 1,
            // 提交记录是历史参考，不能作为当前业务行为已验证的证明。
            evidenceLevel: 'derived', fetchedAt,
          })
        }
        return hits
      } catch (error) {
        const failure = error as NodeJS.ErrnoException & { stderr?: string }
        if (failure.stderr && (
          /^fatal: not a git repository(?: \(or any of the parent directories\))?:/m.test(failure.stderr)
          || /^fatal: your current branch '[^\n]+' does not have any commits yet/m.test(failure.stderr)
        )) return []
        throw new Error(`git-history 搜索失败（${root}）：${failure.message}`, { cause: error })
      }
    },
  }
}
