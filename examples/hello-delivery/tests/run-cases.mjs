#!/usr/bin/env node
/**
 * 用例执行器：读 $TAKT_WORKSPACE/cases/*.json，逐条真实调用 src/greet.js，
 * 把输入、期望、实际写进 evidence/<id>/result.json，汇总写 evidence/summary.json。
 *
 * 关键约束：
 * - 开跑前先把 summary.json 覆盖成空汇总，损坏的用例或中途崩溃不会留下上一轮的 PASS；
 * - 每条用例单独 try/catch，解析失败记一条 error 并落证据，不中断其余用例；
 * - id 必须是安全文件名，重复 id 记为 error，避免覆盖证据或重复计数。
 *
 * 退出码：全部通过为 0；有任何 failed / error 为 1；环境或用例目录本身有问题为 2。
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspace = process.env.TAKT_WORKSPACE
if (!workspace) {
  console.error('缺少 TAKT_WORKSPACE：用例执行器必须由 takt 运行')
  process.exit(2)
}

const casesDir = join(workspace, 'cases')
const evidenceDir = join(workspace, 'evidence')
const summaryPath = join(evidenceDir, 'summary.json')
const summary = { cases: [] }

/** 每次写盘都是当前完整汇总；崩溃时磁盘上只有已处理的行，不会有旧 PASS。 */
async function persist() {
  await mkdir(evidenceDir, { recursive: true })
  await writeFile(summaryPath, JSON.stringify(summary, null, 2) + '\n')
  return summary
}

/** 先落空汇总：后续任何 throw 之前，旧的通过结论已经被清掉。 */
await persist()

let files
try {
  files = (await readdir(casesDir)).filter((name) => name.endsWith('.json')).sort()
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
  files = []
}

async function record(id, row, evidence) {
  if (evidence !== undefined) await mkdir(dirname(evidence), { recursive: true }).then(() => writeFile(evidence, JSON.stringify(row, null, 2) + '\n'))
  summary.cases.push({ id, status: row.status, evidence: evidence === undefined ? undefined : `evidence/${id}/result.json` })
  await persist()
  const label = row.status === 'passed' ? 'PASS' : row.status.toUpperCase()
  console.log(`${label} ${id} input=${JSON.stringify(row.input)} expected=${JSON.stringify(row.expected)} actual=${JSON.stringify(row.actual)}${row.error ? ` error=${row.error}` : ''}`)
}

// 查询参数带运行随机数，避免同一进程内多次执行拿到旧模块。
const moduleUrl = `${pathToFileURL(join(projectDir, 'src', 'greet.js')).href}?run=${Date.now()}-${Math.random()}`
let greet
try {
  ;({ greet } = await import(moduleUrl))
  if (typeof greet !== 'function') throw new Error('src/greet.js 没有导出 greet 函数')
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  for (const file of files) {
    const id = file.replace(/\.json$/, '')
    const row = { id, status: 'error', error: `无法加载 src/greet.js：${message}`, file: `cases/${file}` }
    await record(SAFE_ID.test(id) ? id : file, row, SAFE_ID.test(id) ? join(evidenceDir, id, 'result.json') : undefined)
  }
  console.error(`无法加载 src/greet.js：${message}`)
  process.exit(2)
}

const seen = new Set()
for (const file of files) {
  const fileId = file.replace(/\.json$/, '')
  let caseFile
  try {
    caseFile = JSON.parse(await readFile(join(casesDir, file), 'utf8'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const row = { id: fileId, status: 'error', error: `用例文件无法解析：${message}`, file: `cases/${file}` }
    await record(SAFE_ID.test(fileId) ? fileId : file, row, SAFE_ID.test(fileId) ? join(evidenceDir, fileId, 'result.json') : undefined)
    continue
  }

  const id = typeof caseFile?.id === 'string' ? caseFile.id : ''
  if (!SAFE_ID.test(id)) {
    // id 不安全时不能拼证据路径；用文件名标记，evidence 置空。
    await record(file, { id: id || fileId, status: 'error', error: `用例 id 不是安全文件名：${JSON.stringify(caseFile?.id)}`, file: `cases/${file}` }, undefined)
    continue
  }
  if (seen.has(id)) {
    // 重复 id 不执行、不写证据，避免覆盖前一条的结果文件。
    await record(id, { id, status: 'error', error: `重复的用例 id，已忽略 ${file}`, file: `cases/${file}` }, undefined)
    continue
  }
  seen.add(id)

  const input = caseFile.input
  const expected = caseFile.expected
  const row = { id, title: caseFile.title, covers: caseFile.covers ?? [], input, expected }
  try {
    const actual = greet(input)
    row.actual = actual
    row.status = Object.is(actual, expected) ? 'passed' : 'failed'
  } catch (error) {
    row.actual = null
    row.error = error instanceof Error ? error.message : String(error)
    row.status = 'error'
  }
  await record(id, row, join(evidenceDir, id, 'result.json'))
}

await persist()
const passed = summary.cases.filter((item) => item.status === 'passed').length
console.log(`\n用例 ${summary.cases.length} 条，通过 ${passed} 条，失败 ${summary.cases.length - passed} 条。汇总：${summaryPath}`)
if (summary.cases.length === 0) {
  console.error('cases/ 下没有任何用例')
  process.exit(2)
}
process.exit(summary.cases.every((item) => item.status === 'passed') ? 0 : 1)
