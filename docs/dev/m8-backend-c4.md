# 开发简报：M8 后端 C4（serve 重启后的恢复：运行租约、遗留锁回收、中断运行可续跑）

**先读**：`AGENTS.md`、`packages/core/src/store/file-lock.ts`、`packages/core/src/engine/index.ts`（`start` / `resume`）、`packages/core/src/lead/index.ts`（`resume_run`）、`packages/cli/src/commands/run.ts`（`resumeWorkflow`）。

**协议**：本轮只新增 `RunSummary.interrupted` 和 `RunDetail.interrupted`（已写好，在 `api.ts`）。不要再改 `packages/core/src/{types,interfaces,api}.ts`。

**通用要求**：中文错误信息、不调用付费模型、不发真实网络请求、三个 demo 不变红。**不要动 `packages/web/`**。本机 4870 端口有 serve，另有一个 `takt resume` 进程在跑真实运行，不要停它们、不要发请求、不要碰 `~/taktflow-playground`。

---

## 背景（真实发生的）

1. 停掉 serve 后，它持有的两个文件锁（`.takt/runs/.locks/*.lock`，内容 `{"pid":88355}`）留在磁盘上。之后 `takt resume` 等 10 秒报"等待文件锁超时（请确认持有进程已退出后清理）"，只能手动删锁。
2. 运行的 `state.json` 停在 `status: running`，节点停在 `running`，但没有任何进程在执行。界面上调 `run.resume` 被 lead 拒绝："运行仍在执行"。只能去命令行跑 `takt resume`（引擎层的 `resume` 本身接受 running 状态，能正常续跑）。

## 任务 1：遗留锁按持有进程判活回收（`store/file-lock.ts`）

- 现在的原则"绝不按时间抢活锁"保留。
- 新增：锁文件里记录 `pid` 和 `host`（`os.hostname()`）。等待时如果锁文件里的 host 是本机、pid 已经不存在（`process.kill(pid, 0)` 抛 `ESRCH`），就回收这把锁。
- 别的机器的锁、读不出 pid 的锁、`EPERM`（进程在但没权限）一律视为活锁，照旧等待并超时报错。
- **并发安全**：两个进程同时发现同一把死锁时，不能都拿到锁，也不能把刚被别人新建的活锁当死锁删掉。实现方式自选，但要写清楚为什么不会误删（例如：用一个短命的 `.reclaim` 互斥文件，拿到后重新读锁内容确认仍是那个死 pid 再删；`.reclaim` 自身遗留时同样按 pid 判活）。
- 旧格式（只有 pid、没有 host）的锁按本机处理。
- 测试：
  - 死 pid 的锁被回收，函数正常执行；
  - 活 pid（当前进程或测试里起的子进程）的锁不被回收，超时报错；
  - 其他 host 的锁不回收；
  - 两个并发等待者面对同一把死锁，最终严格串行执行（用计数器断言临界区内并发数始终 ≤ 1）。

## 任务 2：运行租约（core 引擎）

- 引擎执行一个运行（`start` 和 `resume`）期间，持有 `.takt/runs/<runId>/lease.json`：`{ pid, host, startedAt }`，用 `wx` 创建，执行结束（成功、失败、等人、取消、异常）在 `finally` 里删除。
- 创建时文件已存在：
  - 持有者活着：报错"运行正在由进程 <pid> 执行"，不执行；
  - 持有者死了（判活规则同任务 1）：回收后继续。
- 导出一个小函数，例如 `runLiveness(stores, runId): Promise<'active' | 'interrupted' | 'idle'>`，规则：
  - 状态不是 `running` → `idle`；
  - 状态是 `running` 且租约有效 → `active`；
  - 状态是 `running` 且租约缺失或持有者已死 → `interrupted`。
- 租约文件在 `.takt/runs/` 下，已被写守卫排除；确认 agent 的写范围碰不到它。

## 任务 3：中断的运行可以从界面续跑

- `lead/index.ts` 的 `resume_run`：把 `if (state.status === 'running') throw` 改成只有 `runLiveness` 为 `active`（或本进程 `engines` 里正在跑）时才拒绝；`interrupted` 时照常 `engine.resume`。
- `run.resume` 命令的其他入口（非 lead 路径，如果有）同样处理。
- CLI `takt resume` 不变（引擎租约已经防止两个进程同时执行同一运行）。
- 测试：模拟崩溃（写一个 `running` 状态 + 死 pid 的租约）后，`run.resume` 命令能续跑到下一个节点；活租约时拒绝。

## 任务 4：服务端把 interrupted 带给前端

- 运行列表（`RunSummary`）和运行详情（`RunDetail`）在 `runLiveness` 为 `interrupted` 时带 `interrupted: true`，否则不带这个字段。
- 列表要注意成本：只对 `status === 'running'` 的运行检查租约（一次 stat / 读小文件），不要读事件日志。
- 测试：路由返回里带 / 不带 `interrupted`。

## 交付

交付说明只写在最终输出里（做了什么、测试结果、没做什么、已知问题），不要在源码目录放文档。不提交、不推送。
