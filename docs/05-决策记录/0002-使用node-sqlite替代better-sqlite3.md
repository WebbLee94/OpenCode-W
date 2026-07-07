# 0002-使用 node-sqlite 替代 better-sqlite3

- **状态**：已接受
- **日期**：2026-06-15
- **决策者**：Webb + 架构师 Agent

## 背景

在 1.0.0（2026-05-22）到 1.1.0（2026-06-13）期间，OpenCode-W 使用 `better-sqlite3` 作为本地 SQLite 驱动。该库是 C++ 原生模块，通过 N-API 与 Node.js 绑定，在提供同步、零额外进程的 SQLite 访问能力的同时，也带来一个长期痛点：**每次 Electron 主版本升级都会导致 `NODE_MODULE_VERSION` 不匹配**，必须重新编译原生模块才能继续工作。在 1.1.0 → 1.2.0 升级 Electron 30.0.1 → 42.4.0（跨 12 个大版本）时，这个问题集中爆发：CI 多平台构建、用户本地安装、开发者本地 `npm install` 都需要等待原生模块重新编译，CI 流水线偶发失败、安装包体积也因原生二进制膨胀。Electron 42 内嵌 Node 24.15，原生提供 `node:sqlite`（`DatabaseSync`）作为内置模块，API 形态与 better-sqlite3 几乎一致，为彻底解决 ABI 风险提供了窗口。

## 决策

主进程数据库驱动从 `better-sqlite3` 切换到 **Node 24 内置的 `node:sqlite`（`DatabaseSync`）**，所有 SQL 调用仍是同步的，IPC handler 无需改为 async。`DatabaseManager` 单例、`electron/database.ts`、所有 IPC handler（analytics / sessions / messages / todos / cleanup / backup）的 `prepare/run/get/all/exec` 调用方式保持不变，仅需替换导入来源和少量 API 形式差异。配套升级：`engines.node` 上调至 `>=20.11.1` 以与 Electron 42 内嵌 Node 24.15 对齐；`electron-builder` 24 → 25 并移除 `npmRebuild` 步骤以避免原生模块重建。

## 备选方案

- **继续使用 better-sqlite3 + prebuild-install**：保留成熟的 better-sqlite3 生态与 `db.transaction(fn)` 等高阶函数，但每次 Electron 大版本升级仍需等待 prebuild 发布或自行编译；Electron 30 → 42 跨 12 版本的实践已证明这条路维护成本不可接受。
- **better-sqlite3 + 自维护 ABI 兼容矩阵**：理论上可以固定 Electron / Node / better-sqlite3 三者版本组合，但这会与「定期跟进 Electron 安全版本」的目标冲突，长期看会积累安全债。
- **sql.js（纯 WASM 实现）**：完全摆脱 C++ 原生模块，可在任何 JavaScript 运行时工作，但 WASM 性能比原生 C 实现低一个数量级，且无法直接持久化到本地文件（需要手动序列化整个数据库），对 OpenCode 这种单文件 GB 级别的数据库来说不可接受。
- **node:sqlite**：Node 24 内置、零外部依赖、零 ABI 风险、同步 API 与 better-sqlite3 形态一致，安装包减少约 8MB。

## 理由

选择 `node:sqlite` 基于以下五点权衡：

1. **零外部依赖、零 ABI 风险**：`node:sqlite` 由 Node.js 核心团队维护，随 Node 升级而升级，不再受 Electron / Node ABI 版本不匹配影响，从根本上消除了 C++ 原生模块带来的安装失败、CI 失败、用户首次启动崩溃等连锁问题。
2. **同步 API 形态一致**：`prepare/run/get/all/exec` 与 better-sqlite3 几乎一致，所有 IPC handler 无需改为 async，渲染进程侧调用代码完全保持不变，迁移成本极低。
3. **安装包体积优化**：去掉 C++ 原生二进制后，安装包减少约 8MB，对 100MB 级别的 Electron 应用来说是可观的比例。
4. **维护性**：随 Node 升级免维护，CI 不再需要原生模块重建步骤，`npmRebuild` 移除后流水线更精简、更稳定。
5. **未来兼容**：OpenCode-W 与 Node 长期演进方向一致，Node 25 / 26 的 `node:sqlite` 改进（如更好的 prepared statement 缓存、更完善的迁移支持）会自然惠及本项目。

我们接受「失去 `db.transaction(fn)` 高阶函数」这一代价——这只是一处语法糖，可以改为手动 `BEGIN` / `COMMIT` / `ROLLBACK`，已有封装示例，迁移成本可控。

## 影响

- **代码层面**：`electron/database.ts` 改用 `import { DatabaseSync } from 'node:sqlite'`；原 better-sqlite3 的 `db.transaction(fn)` 高阶函数调用点需改为手动 `BEGIN` / `COMMIT` / `ROLLBACK`（目前项目内事务用法有限，影响面小）；`engines.node` 字段从 `>=18` 上调至 `>=20.11.1`。
- **用户层面**：应用安装包减少约 8MB，首次安装与启动不再等待原生模块编译；macOS / Windows / Linux 三平台安装体验更稳定；脚本（test-data/inspect-db.cjs 等）在 Node.js 24 上需加 `--experimental-sqlite` flag（Electron 42 主进程内嵌 Node 24.15 默认可用，无需 flag）。
- **运维层面**：CI 不再需要 `npmRebuild` 步骤，构建速度提升、构建失败率下降；Electron 后续大版本升级时不再触发原生模块兼容性问题；项目对 Node 22.5 以下版本不再兼容，开发者本机 Node 版本需要满足要求。
- **后续约束**：`node:sqlite` 仍在 Node 主线演进中，部分高级特性（如自定义函数、虚拟表扩展）可能暂时落后于 better-sqlite3；新增 SQL 能力时需先评估 `node:sqlite` 是否支持，若不支持再考虑其他方案（例如 `node-ffi-napi` 调用 better-sqlite3 仅作为兜底，不轻易引入）。
