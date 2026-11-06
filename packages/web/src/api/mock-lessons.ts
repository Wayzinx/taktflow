/**
 * 经验库演示（docs/design/19 §8）：5 条，试用 / 启用 / 退役都有；改状态必须写原因。
 */
import type { Lesson, LessonUpdateRequest } from '@taktflow/core'

const DAY = 24 * 60 * 60_000
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString()

function seed(): Lesson[] {
  return [
    {
      id: 'L-001',
      title: '金额字段统一走 formatAmount(value, 2)',
      body: '**现象**：CSV / 接口里金额直接输出浮点数，12.5 写成 "12.5"，与契约 "12.50" 不符。\n\n**原因**：导出代码绕过了 `src/orders/format.ts`。\n\n**做法**：所有金额输出统一调用 `formatAmount(value, 2)`；单测至少覆盖 12.5、0、负数三种。',
      trigger: { roles: ['dev'], paths: ['src/export/**', 'src/orders/**'], categories: ['product_bug'] },
      status: 'active',
      source: { kind: 'judge', runId: 'run-20261104-0002', nodeId: 'dev-test-loop/judge', ref: 'TC-EXP-003' },
      stats: { recalled: 9, helped: 7, hurt: 0 },
      createdAt: ago(6),
      updatedAt: ago(2),
    },
    {
      id: 'L-002',
      title: '判空先 trim，输出保留原值',
      body: '**现象**：为了判空直接 trim 输入，存量调用方的输出被改变（快照测试大面积失败）。\n\n**做法**：`trim()` 只用于判断是否为空，拼接输出时用原值；全角空格 `\\u3000` 同样视为空白。',
      trigger: { roles: ['architect', 'dev'], signatures: ['trim', '空名字|空字符串'] },
      status: 'active',
      source: { kind: 'review', runId: 'run-20261104-0001', nodeId: 'review-design', ref: 'D1-R1' },
      userStated: true,
      stats: { recalled: 4, helped: 4, hurt: 0 },
      createdAt: ago(3),
      updatedAt: ago(3),
    },
    {
      id: 'L-003',
      title: '日期按用户时区生成，缺省 Asia/Shanghai',
      body: '**现象**：服务端用 UTC 生成日期，北京时间 0–8 点的文件名 / 报表日期是前一天。\n\n**做法**：用 `formatInTimeZone(now, tz, ...)`；请求里没有时区时回退 `Asia/Shanghai`；单测覆盖 00:30 和 07:59。',
      trigger: { roles: ['dev'], paths: ['src/export/**', 'src/report/**'] },
      status: 'tentative',
      source: { kind: 'human', ref: 'REQ-007' },
      stats: { recalled: 2, helped: 1, hurt: 0 },
      createdAt: ago(1),
      updatedAt: ago(0.02),
    },
    {
      id: 'L-004',
      title: 'Playwright 等待用 data-testid，不用文本',
      body: '**现象**：按钮文案调整后脚本全部超时。\n\n**做法**：定位一律用 `data-testid`；等待用 `toBeVisible()`，不要 `waitForTimeout`。',
      trigger: { roles: ['automation'], paths: ['tests/**'], categories: ['script_defect'] },
      status: 'tentative',
      source: { kind: 'judge', runId: 'run-20261104-0002', nodeId: 'dev-test-loop/judge', ref: 'TC-EXP-007' },
      stats: { recalled: 5, helped: 2, hurt: 2 },
      createdAt: ago(4),
      updatedAt: ago(1),
    },
    {
      id: 'L-005',
      title: '测试库为空时先跑 seed 脚本',
      body: '**现象**：用例因为订单表为空被判为环境问题。\n\n**做法**：执行用例前先跑 `npm run db:seed -- --env test`。\n\n> 已退役：worktree 引导命令里已经包含 seed，这条不再需要注入。',
      trigger: { categories: ['env_issue', 'test_data'] },
      status: 'retired',
      source: { kind: 'judge', runId: 'run-20261104-0002', nodeId: 'dev-test-loop/judge', ref: 'TC-EXP-008' },
      stats: { recalled: 6, helped: 1, hurt: 3 },
      createdAt: ago(9),
      updatedAt: ago(1.5),
    },
  ]
}

export interface MockLessons {
  list(status?: Lesson['status']): Lesson[]
  update(id: string, body: LessonUpdateRequest): Lesson | string
}

export function createMockLessons(seeded: boolean): MockLessons {
  const lessons = seeded ? seed() : []
  return {
    list: (status) => lessons.filter((l) => !status || l.status === status),
    update(id, body) {
      const l = lessons.find((x) => x.id === id)
      if (!l) return `经验 ${id} 不存在`
      if (!body.reason?.trim()) return '修改经验需要写原因'
      if (body.status) l.status = body.status
      if (body.title !== undefined) l.title = body.title
      if (body.body !== undefined) l.body = body.body
      if (body.trigger) l.trigger = body.trigger
      l.updatedAt = new Date().toISOString()
      return l
    },
  }
}
