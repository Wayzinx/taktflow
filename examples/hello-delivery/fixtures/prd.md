# PRD：问候语支持空名字

## 背景

`greet(name)` 目前对任何名字都返回 `Hello, <name>!`。上游调用方在用户未填写名字时会传入空字符串，此时页面出现 `Hello, !`，观感很差。

## 需求

- 传入非空名字时，保持现有行为：返回 `Hello, <名字>!`。
- 传入空字符串时，返回 `Hello, stranger!`。
- 本次只改问候语拼接逻辑，不新增接口、不改调用方、不做输入 trim 或类型转换。

## 验收标准

- AC-1：`greet("Alice")` 返回 `Hello, Alice!`。
- AC-2：`greet("")` 返回 `Hello, stranger!`。
