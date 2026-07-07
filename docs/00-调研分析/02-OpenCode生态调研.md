# OpenCode 生态调研

> 调研时间：2026-07-07
> 调研对象：OpenCode 开源项目（github.com/anomalyco/opencode）

## 一、OpenCode 项目概览

- **定位**：AI 编程助手（类似 Claude Code / Cursor）
- **技术栈**：TypeScript + Bun
- **存储**：SQLite（WAL 模式，bun:sqlite 驱动）
- **版本**：v1.x（支持父子会话层级）
- **仓库**：github.com/anomalyco/opencode

## 二、数据存储模型

（参考 docs/00-调研分析/03-数据库Schema参考.md，简述 15 张业务表 + 2 张系统表）
- project / session / message / part 四张核心表
- session 自引用（parent_id）支持父子会话
- part 表的 type 字段存储在 data JSON 中（非独立列）

## 三、TUI 限制

| 限制 | 影响 | OpenCode-W 补全 |
|------|------|----------------|
| `/sessions` 仅显示近 30 天 | 历史会话不可见、不可操作 | 任意时间会话浏览/搜索/重命名/删除 |
| 无成本统计 UI | 无法看清 Token 消耗与费用 | 仪表盘 + 趋势图 |
| 无备份管理 | 数据丢失风险 | 版本化备份 + 灾难恢复 |
| 无批量清理 | 旧数据堆积 | 4 种清理策略 + VACUUM |

> 参考：[OpenCode Issue #16270](https://github.com/anomalyco/opencode/issues/16270)（30 天窗口已知问题）

## 四、版本演进与兼容性

- v1.x：session 表新增 parent_id 列支持父子会话
- OpenCode-W 兼容策略：检测 parent_id 列存在性，缺失时回退为"全部会话"模式
- Schema 变更通过 __drizzle_migrations 追踪

## 五、会话生命周期

1. 用户发起对话 → 创建 root session
2. 子代理调用 → 创建 child session（parent_id 指向父会话）
3. 消息产生 → message 表 + part 表
4. 会话结束 → time_updated 更新
5. 归档 → time_archived 设置

## 六、OpenCode-W 的依赖边界

- **只读为主**：浏览、统计、搜索均为只读 SQL
- **写操作受控**：重命名、删除、清理、迁移均需预览+确认
- **不依赖 OpenCode 进程**：直接读 SQLite 文件，与 OpenCode 进程完全解耦
- **数据库路径**：自动检测 ~/.local/share/opencode/opencode.db
