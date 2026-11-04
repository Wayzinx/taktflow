/** 演示数据里的产物正文：贴近 examples/hello-delivery 的 REQ-001「问候语支持空名字」。 */

export const PRD = `# PRD：问候语支持空名字

## 背景

\`greet(name)\` 目前直接拼接名字。名字为空时返回 \`Hello, !\`，客服反馈"看起来像 bug"。

## 目标

- 名字为空或只有空白时，返回 \`Hello, stranger!\`
- 其他行为保持不变

## 不做

- 多语言问候（另起需求）
- 名字长度截断

## 验收口径

| 场景 | 输入 | 期望 |
|---|---|---|
| 正常名字 | \`"Ada"\` | \`Hello, Ada!\` |
| 空字符串 | \`""\` | \`Hello, stranger!\` |
`

export const MEETING = `# 需求评审会纪要 · 11-03

**参会**：wayne（PM）、lin（研发）、qiao（测试）

1. 空白字符（含全角空格）视同空名字 —— 结论：**是**
2. \`null\` / \`undefined\` 入参 —— 结论：本期不处理，类型层面已限制为 string
3. 默认称呼是否可配置 —— 结论：本期写死 \`stranger\`，预留常量

> 待办：qiao 补充全角空格用例
`

const CLARIFY_BASE = `# 需求澄清

基于 \`inputs/prd.md\` 与 \`inputs/meeting-1103.md\`，以下问题会影响实现或验收：

1. **只有空白字符的名字是否视同空名字？**
   - 为什么问：PRD 只写了空字符串；纪要提到空白字符，但没写是否含全角空格
   - 可选答案：A. 仅 \`""\`；B. \`trim()\` 后为空；C. B + 全角空格
2. **默认称呼是否需要可配置？**
   - 为什么问：影响是否要新增配置项和对应用例
   - 可选答案：A. 写死 \`stranger\`；B. 读环境变量
3. **名字前后的空白是否保留？**（如 \`" Ada "\`）
   - 可选答案：A. 原样保留；B. 去除
`

export const CLARIFY_V1 = CLARIFY_BASE

export const CLARIFY_V2 = `${CLARIFY_BASE}
## 答复（wayne · 11-04）

| 问题 | 结论 | 说明 |
|---|---|---|
| 1 | **C** | 全角空格 U+3000 也算空白 |
| 2 | **A** | 写死，代码里留常量 \`DEFAULT_NAME\` |
| 3 | **A** | 原样保留，本期不改变非空名字的行为 |
`

const specBody = (ac2: string) => `# Spec：问候语支持空名字

> 需求 REQ-001 · 来源 \`inputs/prd.md@v1\`、\`spec/clarify.md@v2\`

## 范围

- \`greet(name: string): string\` 对空名字返回默认称呼
- 非空名字的行为不变

## 不做什么

- 多语言、名字截断、可配置的默认称呼

## 验收标准

| ID | 场景 | 输入 | 期望结果 |
|---|---|---|---|
| AC-1 | 正常名字 | \`"Ada"\` | 返回 \`Hello, Ada!\` |
| AC-2 | 空名字 | ${ac2} | 返回 \`Hello, stranger!\` |

## 约束

- 默认称呼定义为常量 \`DEFAULT_NAME = "stranger"\`
- 不得修改 \`tests/\` 下的执行器
`

export const SPEC_V1 = specBody('`""`、`"   "`')
export const SPEC_V2 = specBody('`""`、`"   "`、`"\\u3000"`')

export const DESIGN = `# 系分：问候语支持空名字

## 改动范围

| 文件 | 改动 | 风险 |
|---|---|---|
| \`src/greet.js\` | 空名字分支 + \`DEFAULT_NAME\` 常量 | 低 |

## 方案

1. 复用现有 \`greet()\`，不新增模块
2. 判空：\`name.trim() === ''\`（\`String.prototype.trim\` 已覆盖全角空格 U+3000）
3. 调用方 3 处（CodeGraph）：\`cli/hello.js\`、\`server/routes/greet.js\`、\`docs/examples/basic.md\`，签名不变，无需改动

\`\`\`js
export const DEFAULT_NAME = 'stranger'

export function greet(name) {
  const who = name.trim() === '' ? DEFAULT_NAME : name
  return \`Hello, \${who}!\`
}
\`\`\`

## 回滚

单文件改动，回滚即还原 \`src/greet.js\`。
`

export const CONTRACTS = JSON.stringify(
  {
    module: 'src/greet.js',
    functions: [
      {
        name: 'greet',
        params: [{ name: 'name', type: 'string' }],
        returns: 'string',
        rules: [
          { ac: 'AC-1', when: "name.trim() !== ''", then: 'Hello, ${name}!' },
          { ac: 'AC-2', when: "name.trim() === ''", then: 'Hello, stranger!' },
        ],
      },
    ],
    constants: { DEFAULT_NAME: 'stranger' },
    breaking: false,
  },
  null,
  2,
)

export const TEST_PLAN = `# 测试计划

## 范围

- 单元层：\`greet()\` 的两条验收标准
- 不在范围：调用方集成（签名不变，影响面评估里确认）

## 用例

| 用例 | 覆盖 | 输入 | 期望 |
|---|---|---|---|
| TC-GREET-001 | AC-1 | \`"Ada"\` | \`Hello, Ada!\` |
| TC-GREET-002 | AC-2 | \`""\` | \`Hello, stranger!\` |

## 数据构造

无外部依赖，执行器直接 import \`src/greet.js\`。

## 不可自动化项

无。
`

export const CASE_1 = JSON.stringify(
  { id: 'TC-GREET-001', title: '正常名字返回问候语', covers: ['AC-1'], input: 'Ada', expected: 'Hello, Ada!', assert: 'result === expected' },
  null,
  2,
)
export const CASE_2 = JSON.stringify(
  { id: 'TC-GREET-002', title: '空名字返回 stranger', covers: ['AC-2'], input: '', expected: 'Hello, stranger!', assert: 'result === expected' },
  null,
  2,
)

export const TASK_CORE = `# 任务 greet-core：默认称呼常量

- **改动**：\`src/greet.js\` 新增 \`export const DEFAULT_NAME = 'stranger'\`
- **自测**：\`greet('Ada')\` → \`Hello, Ada!\` ✅
- **未改动**：调用方、测试执行器
`

export const TASK_EMPTY = `# 任务 greet-empty：空名字返回默认称呼

- **改动**：\`greet()\` 对 \`name.trim() === ''\` 返回 \`Hello, \${DEFAULT_NAME}!\`
- **自测**：\`greet('')\` → \`Hello, stranger!\`
- **备注**：实现过程中上下文超预算，触发 1 次自动压缩（41.2k → 12.6k）

> 首轮执行中 TC-GREET-002 仍失败（分支未合入），见 Loop 第 1 轮判决；第 2 轮由 fix-code 补齐。
`

export const SUMMARY_V1 = JSON.stringify(
  {
    iteration: 1,
    cases: [
      { id: 'TC-GREET-001', status: 'passed', evidence: 'evidence/TC-GREET-001/result.json' },
      { id: 'TC-GREET-002', status: 'failed', evidence: 'evidence/TC-GREET-002/result.json' },
    ],
  },
  null,
  2,
)
export const SUMMARY_V2 = JSON.stringify(
  {
    iteration: 2,
    cases: [
      { id: 'TC-GREET-001', status: 'passed', evidence: 'evidence/TC-GREET-001/result.json' },
      { id: 'TC-GREET-002', status: 'passed', evidence: 'evidence/TC-GREET-002/result.json' },
    ],
  },
  null,
  2,
)

export const RESULT_002_V1 = JSON.stringify(
  { id: 'TC-GREET-002', input: '', expected: 'Hello, stranger!', actual: 'Hello, !', status: 'failed', durationMs: 3 },
  null,
  2,
)
export const RESULT_002_V2 = JSON.stringify(
  { id: 'TC-GREET-002', input: '', expected: 'Hello, stranger!', actual: 'Hello, stranger!', status: 'passed', durationMs: 2 },
  null,
  2,
)

export const VERDICT_RATIONALE =
  "用例期望 'Hello, stranger!' 与 spec AC-2 一致；实际返回 'Hello, !'。src/greet.js 第 3 行直接拼接 name，未处理空字符串，属于产品代码缺陷，不是用例或脚本问题。"

export const VERDICT_JSON = JSON.stringify(
  {
    iteration: 1,
    verdicts: [
      {
        subject: 'TC-GREET-002',
        category: 'product_bug',
        confidence: 0.9,
        rationale: VERDICT_RATIONALE,
        evidence: ['evidence/TC-GREET-002/result.json', 'src/greet.js:3', 'spec/spec.md#AC-2'],
        fixScope: 'mechanical',
        fixHint: "在 greet() 中对 name.trim() === '' 返回 DEFAULT_NAME",
      },
    ],
    routed: { 'fix-code': ['TC-GREET-002'] },
  },
  null,
  2,
)

export const REVIEW_CORE = `# 评审：greet-core

- ✅ 常量命名与 spec 约束一致
- ✅ 未改动调用方
- 建议：常量加一行注释说明本期不可配置
`

export const REVIEW_EMPTY = `# 评审：greet-empty

- ✅ 判空使用 \`trim()\`，覆盖全角空格
- ⚠️ 分支尚未合入 \`src/greet.js\`（只写了任务摘要），需由 Loop 修复
`

export const IMPACT = `# 影响面评估

## 改动

- \`src/greet.js\`：新增空名字分支与 \`DEFAULT_NAME\` 常量

## 调用方（CodeGraph · 3 处）

| 调用方 | 影响 | 建议 |
|---|---|---|
| \`cli/hello.js\` | 无参数时输出变为 \`Hello, stranger!\` | 回归 CLI 帮助示例 |
| \`server/routes/greet.js\` | \`?name=\` 为空时响应变化 | 补一条接口用例 |
| \`docs/examples/basic.md\` | 文档示例 | 更新示例输出 |

## 回归范围

- 单元：TC-GREET-001 / 002 已通过
- 建议补测：\`GET /greet?name=\` 空参数
`

export const QUALITY = `# 质量报告

用例 2 条，通过 2 条。

## 验收标准覆盖

| AC | 用例 | 通过 | 未通过 |
|---|---|---|---|
| AC-1 | 1 | 1 | 0 |
| AC-2 | 1 | 1 | 0 |
`

export const KNOWLEDGE_DIFF = `# 知识回流建议

目标页面：\`docs/wiki/greeting.md\`（问候语规范）

\`\`\`diff
 ## 空名字
-名字为空时行为未定义。
+名字为空或只有空白（含全角空格 U+3000）时，返回 \`Hello, stranger!\`。
+默认称呼为常量 DEFAULT_NAME，本期不可配置。
\`\`\`

## 踩过的坑

- 开发 Agent 在 Loop 第 1 轮曾尝试修改 \`tests/run-cases.mjs\` 让用例通过，被 writeScope 守卫还原
- 实现节点上下文超预算触发压缩，后续只认存放区文件，没有丢失约束
`

export const ACCEPTANCE = `# 准出决策

- **结论**：准出
- **依据**：\`reports/quality.md@v1\`（2 / 2 通过）、\`reports/impact.md@v1\`
- **遗留**：\`GET /greet?name=\` 空参数的接口用例，已记入下一迭代
- **决策人**：wayne
`

export const baseline = (runId: string, at: string) =>
  JSON.stringify({ frozenAt: at, runId, cases: ['TC-GREET-001', 'TC-GREET-002'], acs: ['AC-1', 'AC-2'] }, null, 2)

/** 交互稿：浅色线框。 */
export const SKETCH_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
<rect width="640" height="360" fill="#f6f6f8"/>
<rect x="60" y="48" width="520" height="264" rx="14" fill="#fff" stroke="#e2e3e8"/>
<rect x="60" y="48" width="520" height="40" rx="14" fill="#fafafb" stroke="#e2e3e8"/>
<circle cx="84" cy="68" r="5" fill="#e7e7ec"/><circle cx="100" cy="68" r="5" fill="#e7e7ec"/><circle cx="116" cy="68" r="5" fill="#e7e7ec"/>
<text x="96" y="132" font-family="-apple-system,PingFang SC,sans-serif" font-size="13" fill="#8b8f9b">名字</text>
<rect x="96" y="144" width="300" height="40" rx="8" fill="#fff" stroke="#c9cad3"/>
<text x="112" y="169" font-family="-apple-system,sans-serif" font-size="14" fill="#b7bac3">（留空）</text>
<rect x="410" y="144" width="96" height="40" rx="8" fill="#5b5bd6"/>
<text x="437" y="169" font-family="-apple-system,PingFang SC,sans-serif" font-size="14" fill="#fff">问候</text>
<rect x="96" y="210" width="410" height="64" rx="10" fill="#f1f1fc" stroke="#d9d9f7"/>
<text x="116" y="248" font-family="-apple-system,sans-serif" font-size="20" font-weight="600" fill="#3a3ab0">Hello, stranger!</text>
<text x="560" y="300" text-anchor="end" font-family="-apple-system,PingFang SC,sans-serif" font-size="11" fill="#b7bac3">交互稿 v1 · 空名字态</text>
</svg>`

/** 执行证据：终端截图。 */
export const TERMINAL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="300" viewBox="0 0 640 300">
<rect width="640" height="300" rx="12" fill="#121318"/>
<circle cx="22" cy="20" r="5" fill="#ff5f57"/><circle cx="40" cy="20" r="5" fill="#febc2e"/><circle cx="58" cy="20" r="5" fill="#28c840"/>
<text x="320" y="24" text-anchor="middle" font-family="SF Mono,Menlo,monospace" font-size="11" fill="#6f7380">npm test — hello-delivery</text>
<g font-family="SF Mono,Menlo,monospace" font-size="13">
<text x="24" y="64" fill="#a3a6b1">$ TAKT_WORKSPACE=.takt/workspaces/REQ-001 npm test</text>
<text x="24" y="96" fill="#3dbd85">✓ TC-GREET-001  正常名字返回问候语        2ms</text>
<text x="24" y="122" fill="#ec5f69">✕ TC-GREET-002  空名字返回 stranger       3ms</text>
<text x="48" y="150" fill="#a3a6b1">expected: "Hello, stranger!"</text>
<text x="48" y="172" fill="#ec5f69">  actual: "Hello, !"</text>
<text x="48" y="194" fill="#6f7380">  at src/greet.js:3</text>
<text x="24" y="232" fill="#ececf0">cases 2 · passed 1 · failed 1</text>
<text x="24" y="256" fill="#6f7380">summary → evidence/summary.json</text>
</g>
</svg>`

export function genericDoc(title: string, sections: Array<[string, string[]]>): string {
  return [`# ${title}`, '', ...sections.flatMap(([h, items]) => [`## ${h}`, '', ...items.map((i) => `- ${i}`), ''])].join('\n')
}
