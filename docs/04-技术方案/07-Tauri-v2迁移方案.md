# 07-Tauri v2 迁移方案

> **状态**：设计中
> **创建日期**：2026-07-07
> **目标版本**：OpenCode-W v1.3.0
> **关联 ADR**：[0006-迁移到Tauri-v2与Rust后端](../05-决策记录/0006-迁移到Tauri-v2与Rust后端.md)
> **关联架构**：[04-Tauri-v2目标架构](../02-架构设计/04-Tauri-v2目标架构.md)

## 1. 背景与决策

基于 [可行性分析](../00-调研分析/06-Tauri-v2迁移可行性分析.md) 结论，OpenCode-W 将从 Electron 42 迁移到 Tauri v2 + Rust 后端。

| 决策项 | 选择 |
|--------|------|
| 团队 Rust 能力 | 熟练使用 |
| 迁移动机优先级 | 包体积 > 性能 > 安全性 |
| parsePartData 策略 | A（Rust + serde_json 重写） |
| 迁移方式 | 一次性切换 |
| 目标版本 | v1.3.0 |

## 2. 迁移策略

一次性切换 + 模块化推进。每个模块迁移后做对比测试保障功能一致性。

```
Phase 0: 版本号 + Tauri 骨架
Phase 1: 数据库层 (db.rs + security.rs)
Phase 2: 简单模块 (sessions/todos/database/dialog/shell)
Phase 3: Analytics (SQL 重)
Phase 4: Cleanup (事务 + 注入防护)
Phase 5: Backup (fs 操作)
Phase 6: Messages (parsePartData — 最大工作量)
Phase 7: Auto-update (状态机 + 事件)
Phase 8: 前端 IPC 迁移 (src/lib/ipc.ts)
Phase 9: 构建/CI/打包
Phase 10: 三平台回归 + 功能一致性验证
```

## 3. 文件结构映射

### 3.1 新建文件（src-tauri/）

| 文件 | 职责 | 对应 Electron 文件 |
|------|------|-------------------|
| `Cargo.toml` | Rust 依赖 | — |
| `tauri.conf.json` | Tauri 配置 | `electron-builder.yml` |
| `capabilities/main.json` | 权限 ACL | `preload.ts` 白名单 |
| `src/main.rs` | 应用入口 | `main.ts` |
| `src/lib.rs` | 命令注册 + State | `main.ts` registerIpcHandlers |
| `src/db.rs` | DatabaseManager | `database.ts` |
| `src/security.rs` | 路径校验 | `main.ts` validateDbPath |
| `src/commands/analytics.rs` | 仪表盘 | `ipc/analytics.ts` |
| `src/commands/sessions.rs` | 会话 CRUD | `ipc/sessions.ts` |
| `src/commands/messages.rs` | 消息 + parsePartData | `ipc/messages.ts` |
| `src/commands/cleanup.rs` | 清理向导 | `ipc/cleanup.ts` |
| `src/commands/backup.rs` | 备份恢复 | `ipc/backup.ts` |
| `src/commands/todos.rs` | 待办 | `ipc/todos.ts` |
| `src/commands/database.rs` | DB 管理 | `main.ts` DB handlers |
| `src/commands/update.rs` | 自动更新 | `ipc/update.ts` |
| `src/models/dto.rs` | serde DTO | `shared/types.ts` |
| `src/models/part.rs` | PartDTO + 12 PartType | `types.ts` PartDTO |

### 3.2 修改文件

| 文件 | 改动 |
|------|------|
| `package.json` | 版本 → 1.3.0；移除 electron 依赖；加 @tauri-apps/api |
| `src/lib/ipc.ts` | 改写为 Tauri invoke 封装 |
| `vite.config.ts` | 移除 vite-plugin-electron |
| `docs/README.md` | 更新文档索引 |

### 3.3 删除文件（迁移完成后）

| 文件 | 说明 |
|------|------|
| `electron/` 整个目录 | 被 src-tauri/ 替代 |
| `electron-builder.yml` | 被 tauri.conf.json 替代 |

## 4. 实施计划

### Phase 0: 版本号 + Tauri v2 骨架

**目标**：搭建 Tauri 项目结构，版本号升级到 v1.3.0

**任务**：

- [ ] **0.1 版本号升级**
  - 修改 `package.json`：`"version": "1.3.0"`
  - 修改 `tauri.conf.json`：`"version": "1.3.0"`
  - 验证：`node -e "console.log(require('./package.json').version)"` 输出 `1.3.0`

- [ ] **0.2 初始化 Tauri v2 项目**
  - 运行 `npm install --save-dev @tauri-apps/cli@latest`
  - 运行 `npx tauri init`，配置：
    - app name: `OpenCode-W`
    - window title: `OpenCode-W`
    - frontend dist: `../dist`
    - dev url: `http://localhost:5173`
  - 生成 `src-tauri/` 目录结构
  - 验证：`ls src-tauri/` 显示 `Cargo.toml`、`tauri.conf.json`、`src/`

- [ ] **0.3 配置 Cargo.toml 依赖**
  ```toml
  [dependencies]
  tauri = { version = "2", features = [] }
  tauri-plugin-dialog = "2"
  tauri-plugin-shell = "2"
  tauri-plugin-fs = "2"
  tauri-plugin-updater = "2"
  rusqlite = { version = "0.32", features = ["bundled"] }
  serde = { version = "1", features = ["derive"] }
  serde_json = "1"
  dirs = "5"
  chrono = "0.4"
  ```

- [ ] **0.4 配置 tauri.conf.json**
  - 参考 `docs/02-架构设计/04-Tauri-v2目标架构.md` 第 7 节
  - 配置三平台 bundle 目标
  - 配置 updater endpoints（GitHub Releases）
  - 验证：`npx tauri info` 无报错

- [ ] **0.5 配置 capabilities/main.json 权限**
  - 参考 `docs/02-架构设计/04-Tauri-v2目标架构.md` 第 5.1 节
  - 授权 dialog/shell/fs/updater 权限
  - 验证：`npx tauri build --debug` 能编译通过

- [ ] **0.6 移除 Electron 构建依赖**
  - 从 `vite.config.ts` 移除 `vite-plugin-electron` 和 electron 相关配置
  - 保留 `react()` 和 `tailwindcss()` 插件
  - 从 `package.json` devDependencies 移除 `electron`、`electron-builder`、`vite-plugin-electron`
  - 验证：`npx vite build` 能构建前端到 `dist/`

> ⚠️ **暂不提交**：用户要求先不 commit，所有 Phase 完成后统一提交。

### Phase 1: 数据库层 (db.rs + security.rs)

**目标**：用 rusqlite 重写 DatabaseManager，重写路径校验

**参考文件**：
- `electron/database.ts`（207 行）— 当前 DatabaseManager
- `electron/main.ts:39-69` — validateDbPath + validateDbExtension

- [ ] **1.1 编写 db.rs — DatabaseManager**
  - 创建 `src-tauri/src/db.rs`
  - 用 `rusqlite::Connection` 替代 `DatabaseSync`
  - 实现：open（WAL + foreign_keys PRAGMA）、close、getDb、healthCheck、getStats、vacuum、checkpoint、rawQuery、rawGet、run
  - 用 `tauri::State<Mutex<Option<Connection>>>` 管理连接
  - 验证：`cargo test db` — 单元测试 open/close/vacuum

- [ ] **1.2 编写 security.rs — 路径校验**
  - 创建 `src-tauri/src/security.rs`
  - 重写 `validate_db_path`：仅允许 `~/.local/share/opencode/` 和 `test-data/`
  - 重写 `validate_db_extension`：仅允许 .db/.sqlite/.sqlite3
  - 重写 `validate_shell_url`：仅允许 http/https 协议
  - 验证：`cargo test security` — 路径穿越攻击测试

- [ ] **1.3 编写 models/dto.rs — serde DTO**
  - 创建 `src-tauri/src/models/dto.rs`
  - 将 `shared/types.ts` 的所有 DTO 转为 Rust serde 结构体
  - IpcResult<T> → `Result<T, String>`（Tauri 自动转为 Promise reject）
  - 验证：`cargo build` 编译通过

### Phase 2: 简单命令模块

**目标**：迁移 sessions/todos/database/dialog/shell（低复杂度模块）

**参考文件**：
- `electron/ipc/sessions.ts` — 会话 CRUD
- `electron/ipc/todos.ts` — 简单 JOIN
- `electron/main.ts:115-218` — database/dialog/shell handlers

- [ ] **2.1 sessions.rs — 会话 CRUD（7 命令）**
  - 创建 `src-tauri/src/commands/sessions.rs`
  - 实现 7 个 `#[tauri::command]`：list、detail、projects、delete、children、rename、move
  - SQL 语句从 `sessions.ts` 原样搬运（参数化查询用 `?` 占位符 → rusqlite `params!` 宏）
  - 验证：对比测试 — 相同输入下 Electron 版和 Tauri 版输出一致

- [ ] **2.2 todos.rs — 待办查询（1 命令）**
  - 创建 `src-tauri/src/commands/todos.rs`
  - 实现 `todos_by_parent` 命令
  - 验证：对比测试

- [ ] **2.3 database.rs — DB 管理（4 命令）**
  - 创建 `src-tauri/src/commands/database.rs`
  - 实现：open（调用 security::validate_db_path）、health、vacuum、checkpoint
  - 验证：对比测试

- [ ] **2.4 dialog + shell 命令（3 命令）**
  - 在 `lib.rs` 或单独模块实现：dialog_open_file、dialog_open_directory、shell_open_external
  - 使用 `tauri-plugin-dialog::open` 和 `tauri-plugin-shell`
  - shell_open_external 调用 `security::validate_shell_url`
  - 验证：手动测试 — 打开文件对话框、打开浏览器

### Phase 3: Analytics 模块

**目标**：迁移仪表盘数据聚合（9 命令，SQL 最复杂但纯查询）

**参考文件**：`electron/ipc/analytics.ts`（326 行）

- [ ] **3.1 analytics.rs — 9 个仪表盘命令**
  - 创建 `src-tauri/src/commands/analytics.rs`
  - 实现 9 个命令：overview、tokens、toolRanking、skillUsage、modelRanking、providerStats、sessionTrend、costTrend、messageTrend
  - **SQL 语句完全不变**（json_extract、strftime、GROUP_CONCAT、COALESCE 都是 SQLite 原生函数）
  - `buildDateFilter` 辅助函数用 Rust 重写
  - 参数化查询：TS 的 `?` 占位符 → rusqlite 的 `params![...]`
  - 验证：对比测试 — 9 个命令的输出与 Electron 版完全一致

### Phase 4: Cleanup 模块

**目标**：迁移清理向导（2 命令，事务 + SQL 注入防护）

**参考文件**：`electron/ipc/cleanup.ts`（248 行）

- [ ] **4.1 cleanup.rs — preview + execute**
  - 创建 `src-tauri/src/commands/cleanup.rs`
  - 实现 `cleanup_preview`：构建 WHERE 子句 + 查询匹配会话
  - 实现 `cleanup_execute`：事务包裹的级联删除（parts → messages → sessions）+ VACUUM
  - 重写 `validate_custom_where`：DANGEROUS_PATTERNS + ALLOWED_PATTERN 正则
  - 事务用 `conn.execute_batch("BEGIN TRANSACTION")` / `COMMIT` / `ROLLBACK`
  - 验证：对比测试 + SQL 注入攻击测试

### Phase 5: Backup 模块

**目标**：迁移备份恢复（5 命令，重 fs 操作）

**参考文件**：`electron/ipc/backup.ts`（259 行）

- [ ] **5.1 backup.rs — create/list/restore/delete/preview**
  - 创建 `src-tauri/src/commands/backup.rs`
  - fs 操作映射：`std::fs::copy`、`create_dir_all`、`read_dir`、`metadata`、`remove_file`
  - WAL/SHM 文件处理：copy/remove `-wal` 和 `-shm` 文件
  - 安全备份：restore 前创建 safety backup
  - 路径安全：`resolvedPath.starts_with(&backup_dir)` 校验
  - readOnly 预览：`Connection::open_with_flags(OpenFlags::SQLITE_OPEN_READ_ONLY)`
  - 验证：对比测试 — 创建/列出/恢复/删除/预览备份

### Phase 6: Messages 模块（最大工作量）

**目标**：迁移消息查看（4 命令，含 parsePartData 216 行 TS→Rust）

**参考文件**：`electron/ipc/messages.ts`（474 行）

- [ ] **6.1 models/part.rs — PartDTO + 12 PartType enum**
  - 创建 `src-tauri/src/models/part.rs`
  - 定义 `PartType` enum（12 变体：text/reasoning/tool/file/patch/snapshot/agent/step-start/step-finish/subtask/retry/compaction）
  - 定义 `PartDTO` struct（所有可选字段）
  - 用 serde `#[serde(default)]` + `#[serde(alias = "...")]` 实现 canonical/flat 兼容
  - 验证：`cargo test part` — 12 种 PartType 的 JSON 反序列化测试

- [ ] **6.2 parse_part_data — Rust 重写**
  - 在 `messages.rs` 中实现 `parse_part_data(row) -> PartDTO`
  - `pick()` 辅助函数用 `serde_json::Value::pointer` 或手动嵌套路径遍历
  - 12 个 match 分支对应 12 种 PartType
  - canonical/flat 兼容：先查 nested 路径，fallback 到 flat 字段
  - 验证：对比测试 — 用真实 part 数据测试 12 种类型的解析结果

- [ ] **6.3 messages.rs — list/detail/list-by-parent/search（4 命令）**
  - 创建 `src-tauri/src/commands/messages.rs`
  - SQL 语句完全不变（含 GROUP_CONCAT 子查询）
  - `messages_list`：分页查询 + content_preview 拼接
  - `messages_detail`：查消息 + 查 parts + parse_part_data
  - `messages_search`：LIKE 全文搜索
  - 验证：对比测试 — 4 个命令的输出与 Electron 版完全一致

### Phase 7: Auto-update 模块

**目标**：迁移自动更新（4 invoke + 5 event 命令）

**参考文件**：`electron/ipc/update.ts`（150 行）

- [ ] **7.1 update.rs — 状态机 + 事件推送**
  - 创建 `src-tauri/src/commands/update.rs`
  - 用 `tauri-plugin-updater` 替代 `electron-updater`
  - 状态机：`Mutex<UpdateState>`（idle/available/downloading/downloaded/installing）
  - 4 个 invoke 命令：check、download、install、get_state
  - 5 个事件推送：`app.emit("update://available", info)` 等
  - 本地缓存：`update-cache.json` 用 `std::fs` 读写
  - 验证：手动测试 — mock GitHub Releases 检查更新流程

### Phase 8: 前端 IPC 迁移

**目标**：改写前端 IPC 调用层

**参考文件**：`src/lib/ipc.ts`（80 行）

- [ ] **8.1 改写 src/lib/ipc.ts**
  - `window.electronAPI.invoke(channel, ...args)` → `invoke(command, args)` from `@tauri-apps/api/core`
  - `isElectron()` 检查移除（Tauri 环境不需要）
  - `openExternal` 改用 `@tauri-apps/plugin-shell`
  - 事件监听：`ipcRenderer.on()` → `listen()` from `@tauri-apps/api/event`
  - 通道名映射：`dashboard:overview` → `dashboard_overview`（冒号→下划线）
  - 验证：`npx tsc --noEmit` 类型检查通过

- [ ] **8.2 更新 src/types/electron.d.ts**
  - 移除 `window.electronAPI` 类型声明
  - 添加 `@tauri-apps/api` 类型导入
  - 验证：`npx tsc --noEmit` 通过

- [ ] **8.3 更新前端组件中的 IPC 调用**
  - 全局搜索 `window.electronAPI` 和 `electronAPI` 引用
  - 替换为新的 `invoke()` 封装
  - 更新事件监听（update events）为 `listen()`
  - 验证：`npx tsc --noEmit` + `npm run lint` 通过

### Phase 9: 构建/CI/打包

**目标**：配置 Tauri 构建和 CI/CD

- [ ] **9.1 配置构建脚本**
  - 更新 `package.json` scripts：
    - `"dev": "vite"` + `"tauri:dev": "tauri dev"`
    - `"build": "tsc && vite build"` + `"tauri:build": "tauri build"`
  - 验证：`npm run tauri:build` 能打包

- [ ] **9.2 配置 GitHub Actions CI**
  - 使用 `tauri-apps/tauri-action@v0`
  - 三平台矩阵：macOS (universal)、Windows (x64+arm64)、Linux (x64)
  - GitHub Releases 自动发布
  - 验证：push tag 触发 CI 构建

- [ ] **9.3 删除 Electron 文件**
  - 删除 `electron/` 目录
  - 删除 `electron-builder.yml`
  - 从 `package.json` 移除所有 electron 依赖
  - 验证：`npm install` 无报错 + `npm run tauri:build` 成功

### Phase 10: 三平台回归 + 功能一致性验证

**目标**：全量回归测试，保障功能 100% 一致

- [ ] **10.1 功能一致性对比测试**
  - 编写对比测试脚本：对每个 Tauri command，用相同输入调用，对比输出 JSON
  - 35 个命令全覆盖
  - 边界用例：空数据库、超大会话、非法路径、SQL 注入
  - 验证：所有命令输出一致

- [ ] **10.2 三平台回归测试**
  - macOS (WKWebView)：全功能手动测试
  - Windows (WebView2)：全功能手动测试
  - Linux (WebKitGTK)：全功能手动测试
  - 重点关注：CSS 渲染、highlight.js、Recharts 图表
  - 验证：三平台功能正常

- [ ] **10.3 打包验证**
  - macOS：DMG universal，安装运行
  - Windows：NSIS x64+arm64，安装运行
  - Linux：AppImage + deb，安装运行
  - 验证：三平台安装包可正常安装和运行

- [ ] **10.4 自动更新验证**
  - 发布测试 tag 触发 CI
  - 旧版本检查更新 → 下载 → 安装
  - 验证：更新流程完整

## 5. 测试策略

### 5.1 后端测试（cargo test）

| 模块 | 测试点 |
|------|--------|
| db.rs | open/close/vacuum/checkpoint/healthCheck |
| security.rs | 路径穿越攻击 / 扩展名白名单 / 协议白名单 |
| models/part.rs | 12 PartType JSON 反序列化 / canonical+flat 兼容 |
| commands/*.rs | 每个命令的 happy path + error path |

### 5.2 前端测试（Vitest）

| 模块 | 测试点 |
|------|--------|
| src/lib/ipc.ts | invoke 封装 / 错误处理 |
| 前端组件 | mock invoke / 渲染不变 |

### 5.3 对比测试（功能一致性）

对每个 Tauri command，用相同输入调用 Electron 版（旧代码）和 Tauri 版（新代码），对比输出 JSON 完全一致。

### 5.4 端到端测试（三平台真实打包产物）

| 平台 | 验证步骤 |
|------|---------|
| macOS | 安装 DMG → 打开应用 → 全功能测试 |
| Windows | 运行 NSIS → 打开应用 → 全功能测试 |
| Linux | AppImage 运行 / dpkg -i → 全功能测试 |

## 6. 风险与缓解

| 风险 | 级别 | 缓解方案 |
|------|------|---------|
| parsePartData 翻译错误 | 🟡 中 | 用真实 part 数据做 12 类型对比测试 |
| 系统 WebView 差异 | 🟡 中 | 三平台回归测试 |
| rusqlite 事务行为差异 | 🟢 低 | cleanup 模块重点测试事务回滚 |
| 自动更新签名 | 🟡 中 | 生成 Tauri 更新签名密钥对 |
| CI/CD 重建 | 🟢 低 | tauri-apps/tauri-action 官方文档 |

## 7. 版本规划

| 版本 | 内容 | 状态 |
|------|------|------|
| v1.2.x | Electron 最终版本 | 当前稳定版 |
| **v1.3.0** | **Tauri v2 + Rust 后端迁移** | **本方案** |
| v1.4.0+ | 功能强化（基于 Tauri 新架构） | 未来 |

### 7.1 版本号更新清单

- [ ] `package.json` → `"version": "1.3.0"`
- [ ] `src-tauri/tauri.conf.json` → `"version": "1.3.0"`
- [ ] `src-tauri/Cargo.toml` → `version = "1.3.0"`
- [ ] 更新 README.md 中的版本徽章
- [ ] 更新 docs 中的版本引用

## 8. 提交策略

> ⚠️ **用户要求**：当前阶段先不 commit，所有文档和代码完成后统一提交。

提交时按 Phase 分批提交：
1. `docs: 添加 Tauri v2 迁移可行性分析与 ADR`
2. `docs: 添加 Tauri v2 目标架构与迁移方案`
3. `chore: 版本号升级到 v1.3.0 + Tauri 项目骨架`
4. `feat: 迁移数据库层到 rusqlite`
5. `feat: 迁移简单命令模块 (sessions/todos/database/dialog/shell)`
6. `feat: 迁移 analytics 模块`
7. `feat: 迁移 cleanup 模块`
8. `feat: 迁移 backup 模块`
9. `feat: 迁移 messages 模块 (parsePartData Rust 重写)`
10. `feat: 迁移 auto-update 模块`
11. `feat: 迁移前端 IPC 层到 Tauri invoke`
12. `chore: 配置 Tauri 构建/CI + 删除 Electron 文件`
13. `test: 三平台回归 + 功能一致性验证`
14. `release: v1.3.0 Tauri v2 + Rust 后端`
