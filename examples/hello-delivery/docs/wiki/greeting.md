---
aliases: [问候语规范, greeting rules, 空名字]
summary: 问候语统一使用英文 Hello, <name>!；名字为空时回退为 Hello, stranger!。
verifiedAt: 2026-11-01
---

# 问候语规范

对外展示的问候语统一为 `Hello, <name>!`，名字与 `Hello,` 之间保留一个空格，感叹号结尾。

## 空名字

当用户没有填写名字（空字符串）时，不允许出现 `Hello, !` 这样的空占位，统一回退为固定称呼 `stranger`：

- `greet("Alice")` → `Hello, Alice!`
- `greet("")` → `Hello, stranger!`

## 边界

- 不做 trim：只有空字符串本身触发回退，空格字符串按普通名字处理。
- 不做类型转换：调用方负责保证传入字符串。
