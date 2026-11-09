/**
 * 项目空间演示数据：两个空间。
 * - hello-delivery：和运行演示数据（mock-data.ts）同一个业务，成员、角色、harness 与之保持一致；
 * - growth-lab：刚创建的空间，还没有需求，用来展示首次使用的空状态。
 */
import type { SpaceDetail } from '@taktflow/core'

const MIN = 60_000
const ago = (min: number) => new Date(Date.now() - min * MIN).toISOString()

export interface MockSpace {
  detail: SpaceDetail
  /** kind:name → 文件原文（SKILL.md / 角色档案）。 */
  files: Map<string, string>
  /** 是否用完整的运行演示数据；false 时是空空间。 */
  seeded: boolean
}

const skill = (name: string, description: string, body: string) => ({
  rec: { name, path: `skills/${name}/SKILL.md`, description },
  content: `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
})

const SKILLS = [
  skill('money-format', '金额字段的格式化与舍入规则：统一两位小数、银行家舍入、货币符号不进 CSV', '# 金额格式\n\n- 所有对外输出（接口、CSV、邮件）统一走 `formatAmount(value, 2)`，不要自己 `toFixed`。\n- 舍入用银行家舍入（half-even），与财务对账一致。\n- CSV 里不带货币符号，表头写明币种：`金额（CNY）`。\n\n## 反例\n\n```ts\nrow.amount = order.amount.toString() // 12.5，财务系统会拒收\n```'),
  skill('csv-export', '大数据量导出：流式写出、分片、BOM 与转义约定', '# CSV 导出\n\n1. 超过 5000 行必须流式写出，单片不超过 2000 行。\n2. 文件头写 UTF-8 BOM，Excel 才能正确识别中文。\n3. 字段含逗号、引号、换行时整体加双引号，内部引号写两次。'),
  skill('playwright-e2e', 'E2E 用例约定：data-testid 选择器、截图证据、失败重试一次', '# Playwright 约定\n\n- 只用 `data-testid` 选择器，不用文案和 CSS 路径。\n- 每条用例结束写 `evidence/<case>/` 下的截图和 dom.html。\n- 失败自动重试一次，两次都失败才算失败。'),
  skill('api-contract-review', '评审接口契约：错误码、幂等、分页和兼容性检查清单', '# 契约评审清单\n\n- [ ] 每个错误码都有触发条件和前端处理方式\n- [ ] 写接口说明幂等键\n- [ ] 列表接口有分页上限\n- [ ] 字段只增不删；改类型要走新版本'),
]

const yamlList = (k: string, v?: string[]) => (v?.length ? `${k}:\n${v.map((w) => `  - ${w}`).join('\n')}\n` : '')
const role = (r: string, title: string, description: string, harness: string, model: string, writeScope: string[], body: string, use: { skills?: string[]; knowledge?: string[] } = {}) => ({
  rec: { role: r, title, description, harness: { harness, model }, writeScope },
  content: `---\nrole: ${r}\ntitle: ${title}\ndescription: ${description}\nharness: ${harness}\nmodel: ${model}\n${yamlList('skills', use.skills)}${yamlList('knowledge', use.knowledge)}${yamlList('writeScope', writeScope)}---\n\n${body}\n`,
})

const AGENTS = [
  role('pm', '产品分析', '读 PRD 与纪要，产出澄清问题和 spec', 'claude-code', 'sonnet', ['spec/**', 'decisions/**'], '你负责把需求说清楚。只写"会影响实现或验收"的问题，每条验收标准写清输入和期望。', { knowledge: ['wiki', 'git-history'] }),
  role('architect', '系分设计', '影响面分析、方案与接口契约', 'claude-code', 'sonnet', ['design/**'], '先查调用链确认影响面，再给方案。契约只描述行为规则，不写实现细节。', { skills: ['api-contract-review'], knowledge: ['codegraph', 'orders-db', 'wiki'] }),
  role('test-designer', '测分设计', '按 AC 设计用例，覆盖边界与异常', 'codex', 'gpt-5-codex', ['cases/**'], '每条 AC 至少一条正向、一条边界用例；用例 id 形如 TC-<模块>-<序号>。', { skills: ['money-format'], knowledge: ['wiki'] }),
  role('dev', '研发', '在 worktree 里改代码并补单测', 'codex', 'gpt-5-codex', ['src/**', 'test/**'], '只改任务说明里列出的文件范围；每个改动配单测；不碰公共存放区里的基线产物。', { skills: ['money-format', 'csv-export'] }),
  role('reviewer', '代码评审', '按清单评审改动，给结论和问题清单', 'claude-code', 'sonnet', ['reports/review-*.md'], '结论只能是 通过 / 需修改；每个问题写严重程度、位置、建议。', { skills: ['api-contract-review'], knowledge: ['rg', 'codegraph'] }),
  role('judge', '失败归因', '对失败用例做判决并路由修复', 'claude-code', 'sonnet', ['reports/verdict-*.json'], '判决类别：product_bug / case_defect / script_defect / env_issue / flaky / requirement_gap。证据不足时判 unknown，不要猜。'),
  role('automation', '自动化脚本', '把用例转成可执行脚本', 'codex', 'gpt-5-codex', ['e2e/**'], '遵循 playwright-e2e 技能；脚本失败先自查选择器，再上报。', { skills: ['playwright-e2e'], knowledge: ['rg'] }),
]

function seededSpace(): MockSpace {
  const files = new Map<string, string>()
  for (const s of SKILLS) files.set(`skill:${s.rec.name}`, s.content)
  for (const a of AGENTS) files.set(`agent:${a.rec.role}`, a.content)
  return {
    seeded: true,
    files,
    detail: {
      id: 'hello-delivery',
      name: 'hello-delivery',
      description: '商城交付线：问候语、订单导出、登录验证码等需求的物料仓库',
      requirements: 7,
      active: 4,
      members: [
        { id: 'wayne', name: 'wayne', role: 'owner', email: 'wayne@example.com', duties: ['pm'] },
        { id: 'lin', name: 'lin', role: 'maintainer', email: 'lin@example.com', duties: ['arch', 'rd'] },
        { id: 'chen', name: 'chen', role: 'member', email: 'chen@example.com', duties: ['rd'] },
        { id: 'qiao', name: 'qiao', role: 'member', email: 'qiao@example.com', duties: ['qa'] },
        { id: 'ops-bot', name: 'ops-bot', role: 'viewer' },
      ],
      repos: [
        { id: 'shop-web', url: 'git@github.com:example/shop-web.git', path: '.takt/repos/shop-web', defaultBranch: 'main', purpose: 'app', description: '商城前端（React）', bootstrap: 'npm ci --prefer-offline', share: ['node_modules'], status: 'ready', head: '8c41e2a' },
        { id: 'shop-api', url: 'git@github.com:example/shop-api.git', path: '.takt/repos/shop-api', defaultBranch: 'main', purpose: 'app', description: '订单与导出服务', bootstrap: 'npm ci && npm run db:migrate -- --env test', share: ['node_modules', '.cache/prisma'], status: 'ready', head: '3f09b7d' },
        { id: 'shop-e2e', url: 'git@github.com:example/shop-e2e.git', path: '.takt/repos/shop-e2e', defaultBranch: 'master', purpose: 'test', description: 'Playwright 用例与脚本', bootstrap: 'npx playwright install --with-deps chromium', share: ['node_modules', '.cache/ms-playwright'], status: 'ready', head: 'a71c044' },
        { id: 'shop-docs', url: 'git@github.com:example/shop-docs.git', path: '.takt/repos/shop-docs', defaultBranch: 'main', purpose: 'docs', status: 'error', message: '拉取失败：Permission denied (publickey)。给部署密钥加上 shop-docs 的读权限后重试。' },
      ],
      skills: SKILLS.map((s) => s.rec),
      agents: AGENTS.map((a) => a.rec),
      workflows: [
        { id: 'sdlc', title: '标准交付流水线', file: 'workflows/sdlc.workflow.ts', rev: 'e3b9a41c', editable: true, updatedAt: ago(26 * 60), nodes: 17, runs: 6 },
        { id: 'task', title: '临时任务（实现 → 评审）', file: 'workflows/task.workflow.ts', rev: '51d0c7f2', editable: true, updatedAt: ago(3 * 24 * 60), nodes: 2, runs: 3 },
        { id: 'hotfix', title: '线上热修', file: 'workflows/hotfix.workflow.ts', rev: '9a2e6b10', editable: false, updatedAt: ago(9 * 24 * 60), nodes: 6, runs: 0 },
      ],
      knowledge: [
        { id: 'rg', kind: 'ripgrep', description: '精确符号查找：绑定的全部代码仓库' },
        { id: 'codegraph', kind: 'codegraph', description: '调用链与影响面：shop-web、shop-api' },
        { id: 'wiki', kind: 'wiki', description: '业务规则与规范：knowledge/wiki/' },
        { id: 'orders-db', kind: 'db-schema', description: '订单库表结构（只读账号）' },
        { id: 'git-history', kind: 'git', description: '为什么这么写：提交历史与过往需求存放区' },
      ],
    },
  }
}

function freshSpace(): MockSpace {
  return {
    seeded: false,
    files: new Map(),
    detail: {
      id: 'growth-lab',
      name: 'growth-lab',
      description: '增长实验：刚创建，还没有需求',
      requirements: 0,
      active: 0,
      members: [
        { id: 'qiao', name: 'qiao', role: 'owner', email: 'qiao@example.com' },
        { id: 'wayne', name: 'wayne', role: 'member', email: 'wayne@example.com' },
      ],
      repos: [{ id: 'growth-web', url: 'git@github.com:example/growth-web.git', path: '.takt/repos/growth-web', defaultBranch: 'main', purpose: 'app', status: 'missing', message: '还没有镜像到本地，点同步拉取。' }],
      skills: [],
      agents: [],
      workflows: [],
      knowledge: [],
    },
  }
}

export function createMockSpaces(): MockSpace[] {
  return [seededSpace(), freshSpace()]
}

/** 同步一个代码仓库后得到的新 HEAD（演示：随机 7 位短哈希）。 */
export const fakeHead = () => Math.random().toString(16).slice(2, 9).padEnd(7, '0')
