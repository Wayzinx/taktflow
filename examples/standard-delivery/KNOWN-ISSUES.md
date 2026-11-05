# M2-B 接入发现的问题

## sandbox：已有技能不会随源文件更新

位置：`packages/sandbox/src/skills.ts` 的 `syncSkills`。

在临时目录中首次同步 `skills/demo/SKILL.md`（内容 `v1`），将源文件改为 `v2`，然后用相同的 `targetRoot` 再次同步。实测源文件为 `v2`，工作目录 `.agents/skills/demo/SKILL.md` 仍为 `v1`。原因是目标目录已存在时直接跳过。

引擎已在每次 harness 调用前调用该函数；重复使用工作树时，更新空间技能后可能继续读取旧副本。建议 sandbox 模块维护同步清单、更新其管理的副本，并保留用户自建文件。本任务按范围限制没有修改 sandbox 内部实现。
