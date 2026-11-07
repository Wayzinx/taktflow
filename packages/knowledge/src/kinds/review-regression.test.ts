import { expect, it } from 'vitest'
import { bm25, makeIndex } from './search.js'
import { guardSql } from './database.js'
import { inferKnowledgeIntent } from '../store/index.js'

it('M4-4：持久化索引不会读取原型属性', () => {
  const index = JSON.parse(JSON.stringify(makeIndex([])))
  expect(bm25(index, 'constructor __proto__')).toEqual([])
})
it.each([
  '退款规则 v2.0 有什么变化',
  'What is the refund policy.',
  '(e.g. 部分退款)',
  '这个错误码表示什么',
  '订单列表怎么分页',
])('M4-5：业务问题不会被标点或单个汉字误路由：%s', (text) => {
  expect(inferKnowledgeIntent({ text })).toBe('business')
})
it.each([
  'pg_terminate_backend(1)',
  'pg_cancel_backend(1)',
  "pg_read_binary_file('/etc/passwd')",
  "pg_ls_dir('.')",
  "LOAD_FILE('/etc/passwd')",
])('M4-3：拒绝危险数据库函数 %s', (expression) => {
  expect(() => guardSql(`SELECT ${expression}`)).toThrow()
})
