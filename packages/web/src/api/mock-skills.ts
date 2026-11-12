/**
 * 演示数据：技能文件夹与导入（docs/design/14 §技能）。SKILL.md 仍在 MockSpace.files 的 skill:<name>，
 * 其余文件（references / scripts / assets）放在这里；导入的来源只模拟出候选列表，不真的拉仓库。
 */
import type { SkillFileContent, SkillFileEntry, SkillImportCandidate, SkillImportSource, SkillRecord } from '@taktflow/core'
import type { MockSpace } from './mock-space'
import type { M8Source } from './source-m8'

type SkillApi = Pick<M8Source, 'skillTree' | 'skillFile' | 'saveSkillFile' | 'deleteSkillFile' | 'deleteSkill' | 'previewSkillImport' | 'importSkills'>
interface Blob { content: string; size: number; text: boolean }

const clone = <T,>(v: T): T => structuredClone(v)
const delay = <T,>(v: T, ms = 140): Promise<T> => new Promise((r) => setTimeout(() => r(clone(v)), ms))
const fail = (msg: string, ms = 140): Promise<never> => new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const textBlob = (content: string): Blob => ({ content, size: new TextEncoder().encode(content).length, text: true })

const SEED: Record<string, Record<string, Blob>> = {
  'money-format': {
    'references/rounding.md': textBlob('# 舍入方式\n\n| 输入 | half-even | half-up |\n|---|---|---|\n| 12.345 | 12.34 | 12.35 |\n| 12.355 | 12.36 | 12.36 |\n'),
    'scripts/check_amounts.py': textBlob('"""扫描 CSV，找出不是两位小数的金额列。"""\nimport csv, sys\n\nfor row in csv.DictReader(open(sys.argv[1], encoding="utf-8-sig")):\n    for k, v in row.items():\n        if k.startswith("金额") and len(v.split(".")[-1]) != 2:\n            print(k, v)\n'),
  },
  'playwright-e2e': {
    'references/selectors.md': textBlob('# 选择器约定\n\n- 只用 `data-testid`。\n- 列表项用 `data-testid="row-<id>"`。\n'),
    'assets/report-example.png': { content: '', size: 18_342, text: false },
  },
}

/** 模拟一个公开技能仓库里能找到的技能。 */
const CATALOG: Array<SkillImportCandidate & { body: string; extra: Record<string, string> }> = [
  { dir: 'skills/pdf', name: 'pdf', description: '读写 PDF：抽取文字和表格、合并拆分、填表单', files: 4, bytes: 41_200, exists: false, body: '# PDF\n\n先用 `scripts/extract.py` 抽文字，表单见 references/forms.md。', extra: { 'references/forms.md': '# 表单\n', 'scripts/extract.py': 'print("extract")\n', 'LICENSE.txt': 'Apache-2.0\n' } },
  { dir: 'skills/xlsx', name: 'xlsx', description: '读写 Excel：公式、格式、透视表，保持原有样式', files: 3, bytes: 28_900, exists: false, body: '# Excel\n\n改表格前先备份。', extra: { 'references/formulas.md': '# 公式\n', 'scripts/recalc.py': 'print("recalc")\n' } },
  { dir: 'skills/webapp-testing', name: 'webapp-testing', description: '用 Playwright 驱动本地网页做端到端检查，截图留证', files: 3, bytes: 12_400, exists: false, body: '# 网页测试\n\n先起服务再跑 `scripts/with_server.py`。', extra: { 'scripts/with_server.py': 'print("server")\n', 'examples/login.py': 'print("login")\n' } },
  { dir: 'skills/canvas-design', name: 'canvas-design', description: '海报和视觉设计：字体、配色、版式规则', files: 640, bytes: 31_500_000, exists: false, problem: '文件超过 500 个', body: '', extra: {} },
]

const decode = (b64: string) => {
  try {
    const bin = atob(b64)
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
  } catch {
    return ''
  }
}
const front = (text: string, key: string) => text.match(new RegExp(`^---[\\s\\S]*?^${key}:\\s*(.+)$[\\s\\S]*?^---`, 'm'))?.[1]?.trim() ?? ''
const withName = (text: string, name: string) => (/^---\n[\s\S]*?^name:.*$/m.test(text) ? text.replace(/^name:.*$/m, `name: ${name}`) : `---\nname: ${name}\n---\n\n${text}`)

export function createMockSkills(withSpace: <T>(fn: (sp: MockSpace) => T | Promise<T>) => Promise<T>): SkillApi {
  const extras = new Map<string, Map<string, Blob>>()
  const staged = new Map<string, { space: string; source: string; candidates: Array<SkillImportCandidate & { files_: Record<string, Blob> }> }>()
  const bag = (sp: MockSpace, name: string) => {
    const key = `${sp.detail.id}:${name}`
    let m = extras.get(key)
    if (!m) extras.set(key, (m = new Map(sp.seeded ? Object.entries(SEED[name] ?? {}) : [])))
    return m
  }
  const record = (sp: MockSpace, name: string) => sp.detail.skills.find((s) => (s.dir ?? s.name) === name)
  const upsert = (sp: MockSpace, name: string) => {
    const content = sp.files.get(`skill:${name}`) ?? ''
    const rec: SkillRecord = { name: front(content, 'name') || name, dir: name, path: `skills/${name}/SKILL.md`, description: front(content, 'description') }
    sp.detail.skills = [...sp.detail.skills.filter((s) => (s.dir ?? s.name) !== name), rec].sort((a, b) => (a.dir ?? a.name).localeCompare(b.dir ?? b.name))
  }
  const entries = (sp: MockSpace, name: string): SkillFileEntry[] => [
    { path: 'SKILL.md', size: textBlob(sp.files.get(`skill:${name}`) ?? '').size, text: true },
    ...[...bag(sp, name)].sort(([a], [b]) => a.localeCompare(b)).map(([path, b]) => ({ path, size: b.size, text: b.text })),
  ]
  const needReason = (reason?: string) => (reason?.trim() ? undefined : fail('reason 必须是非空字符串'))
  const badPath = (path: string) => !path || path.startsWith('/') || path.includes('\\') || path.split('/').some((s) => !s || s === '.' || s === '..' || s === '.git')

  return {
    skillTree: (name) =>
      withSpace((sp) => {
        if (!record(sp, name)) return fail(`技能 ${name} 不存在`)
        return delay({ name, dir: `skills/${name}`, files: entries(sp, name) }, 90)
      }),
    skillFile: (name, path) =>
      withSpace((sp) => {
        if (!record(sp, name)) return fail(`技能 ${name} 不存在`)
        const blob = path === 'SKILL.md' ? textBlob(sp.files.get(`skill:${name}`) ?? '') : bag(sp, name).get(path)
        if (!blob) return fail('文件不存在')
        return delay<SkillFileContent>({ name, path, ...blob }, 80)
      }),
    saveSkillFile: (name, path, body) =>
      needReason(body.reason) ??
      withSpace((sp) => {
        if (!NAME.test(name)) return fail('技能名只能用字母、数字、点、横线和下划线，最多 64 个字符')
        if (badPath(path)) return fail(`文件路径不合法：${path}`)
        const exists = !!record(sp, name)
        if (!exists && path !== 'SKILL.md') return fail(`技能 ${name} 不存在；先写它的 SKILL.md`)
        const blob: Blob = body.base64 !== undefined ? { content: '', size: Math.floor((body.base64.length * 3) / 4), text: false } : textBlob(body.content ?? '')
        if (body.base64 !== undefined && /\.(md|txt|py|sh|js|ts|json|ya?ml|html|css)$/i.test(path)) Object.assign(blob, textBlob(decode(body.base64)))
        if (path === 'SKILL.md') {
          if (!blob.text) return fail('SKILL.md 必须是 UTF-8 文本')
          sp.files.set(`skill:${name}`, blob.content)
          upsert(sp, name)
        } else bag(sp, name).set(path, blob)
        return delay<SkillFileContent>({ name, path, ...blob }, 220)
      }),
    deleteSkillFile: (name, path, reason) =>
      needReason(reason) ??
      withSpace((sp) => {
        if (path === 'SKILL.md') return fail('SKILL.md 不能删；要删就删除整个技能')
        if (!bag(sp, name).delete(path)) return fail('文件不存在')
        return delay(undefined, 160)
      }),
    deleteSkill: (name, reason) =>
      needReason(reason) ??
      withSpace((sp) => {
        if (!record(sp, name)) return fail(`技能 ${name} 不存在`)
        sp.files.delete(`skill:${name}`)
        extras.delete(`${sp.detail.id}:${name}`)
        sp.detail.skills = sp.detail.skills.filter((s) => (s.dir ?? s.name) !== name)
        return delay(undefined, 200)
      }),
    previewSkillImport: (source: SkillImportSource) =>
      withSpace((sp) => {
        const token = `mock-${Math.random().toString(36).slice(2)}`
        const has = (n: string) => !!record(sp, n)
        if (source.kind === 'git') {
          const url = source.url.trim()
          if (!/^(https:\/\/|ssh:\/\/|git@)\S+$|^[\w.-]+\/[\w.-]+$/.test(url)) return fail('只支持 https:// 或 SSH（git@… / ssh://）的仓库地址，或 GitHub 的 owner/repo')
          if (/not-found|does-not-exist/.test(url)) return fail('拉取仓库失败：remote: Repository not found.', 900)
          const sub = source.path?.trim() || url.match(/\/tree\/[^/]+\/(.+?)\/?$/)?.[1] || ''
          const picked = CATALOG.filter((c) => !sub || c.dir === sub || c.dir.startsWith(`${sub}/`))
          const candidates = picked.map(({ body, extra, ...c }) => ({ ...c, exists: has(c.name), files_: { 'SKILL.md': textBlob(`---\nname: ${c.name}\ndescription: ${c.description}\n---\n\n${body}\n`), ...Object.fromEntries(Object.entries(extra).map(([p, t]) => [p, textBlob(t)])) } }))
          const label = `${url.replace(/^https:\/\//, '').replace(/\/tree\/.*$/, '').replace(/\.git$/, '')}${source.ref ? `@${source.ref}` : ''}${sub ? ` · ${sub}` : ''}`
          if (candidates.length) staged.set(token, { space: sp.detail.id, source: label, candidates })
          return delay({ token: candidates.length ? token : '', source: label, candidates: candidates.map(({ files_, ...c }) => c), skipped: [] }, 1400)
        }
        // 上传：按含 SKILL.md 的目录分组；zip 在演示里当成一个以包名命名的技能
        const groups = new Map<string, Record<string, Blob>>()
        const skipped: string[] = []
        for (const f of source.files) {
          if (!f.path.includes('/') && /\.(zip|skill)$/i.test(f.path)) {
            const n = f.path.replace(/\.(zip|skill)$/i, '')
            groups.set(n, { 'SKILL.md': textBlob(`---\nname: ${n}\ndescription: 从 ${f.path} 导入的技能\n---\n\n# ${n}\n`), 'references/README.md': textBlob('# 参考\n') })
            continue
          }
          const dir = source.files.filter((x) => x.path.endsWith('/SKILL.md') || x.path === 'SKILL.md').map((x) => x.path.replace(/\/?SKILL\.md$/, '')).filter((d) => !d || f.path.startsWith(`${d}/`) || f.path === `${d}/SKILL.md`).sort((a, b) => b.length - a.length)[0]
          if (dir === undefined) continue
          const rel = dir ? f.path.slice(dir.length + 1) : f.path
          const g = groups.get(dir) ?? {}
          const content = decode(f.base64)
          g[rel] = /\.(png|jpe?g|gif|pdf|zip|woff2?)$/i.test(rel) ? { content: '', size: Math.floor((f.base64.length * 3) / 4), text: false } : textBlob(content)
          groups.set(dir, g)
        }
        const candidates = [...groups].map(([dir, files]) => {
          const md = files['SKILL.md']?.content ?? ''
          const declared = front(md, 'name')
          const name = NAME.test(declared) ? declared : (dir.split('/').pop() || 'skill').toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
          const bytes = Object.values(files).reduce((n, b) => n + b.size, 0)
          return { dir, name, description: front(md, 'description'), files: Object.keys(files).length, bytes, exists: has(name), files_: files }
        })
        const label = source.files.length === 1 ? source.files[0]!.path : `${source.files[0]!.path.split('/')[0]} 等 ${source.files.length} 个文件`
        if (candidates.length) staged.set(token, { space: sp.detail.id, source: label, candidates })
        return delay({ token: candidates.length ? token : '', source: label, candidates: candidates.map(({ files_, ...c }) => c), skipped }, 600)
      }),
    importSkills: (req) =>
      needReason(req.reason) ??
      withSpace((sp) => {
        const item = staged.get(req.token)
        if (!item || item.space !== sp.detail.id) return fail('导入预览已过期，请重新预览一次')
        const picks = req.picks.map((p) => ({ c: item.candidates.find((c) => c.dir === p.dir), name: p.name }))
        const bad = picks.find((p) => !p.c || p.c.problem || !NAME.test(p.name))
        if (bad) return fail(bad.c?.problem ? `${bad.c.name} 不能导入：${bad.c.problem}` : `技能名 ${bad.name} 不合法`)
        const taken = picks.filter((p) => record(sp, p.name)).map((p) => p.name)
        if (taken.length && !req.overwrite) return fail(`空间里已有同名技能：${taken.join('、')}；勾选「覆盖同名技能」或换个名字`)
        for (const { c, name } of picks) {
          const files = c!.files_
          sp.files.set(`skill:${name}`, withName(files['SKILL.md']?.content ?? '', name))
          extras.set(`${sp.detail.id}:${name}`, new Map(Object.entries(files).filter(([p]) => p !== 'SKILL.md')))
          upsert(sp, name)
        }
        staged.delete(req.token)
        return delay({ imported: picks.map((p) => ({ name: p.name, files: Object.keys(p.c!.files_).length, replaced: taken.includes(p.name) })) }, 700)
      }),
  }
}
