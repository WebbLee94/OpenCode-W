# 04-Tauri v2 目标架构

> **状态**：设计中
> **创建日期**：2026-07-07
> **目标版本**：OpenCode-W v1.3.0
> **关联 ADR**：[0006-迁移到Tauri-v2与Rust后端](../05-决策记录/0006-迁移到Tauri-v2与Rust后端.md)
> **关联可行性分析**：[06-Tauri-v2迁移可行性分析](../00-调研分析/06-Tauri-v2迁移可行性分析.md)

## 1. 架构总览

```
┌─────────────────────────────────────────────────────┐
│              Frontend (System WebView)               │
│  React 18 + Vite 5 + Tailwind 4 + Recharts           │
│  调用方式: invoke('cmd', args) from                   │
│            @tauri-apps/api/core                       │
│  事件监听: listen('event', cb) from                   │
│            @tauri-apps/api/event                      │
└──────────────────────┬──────────────────────────────┘
                       │  Tauri Commands (JSON-RPC-like IPC)
┌──────────────────────▼──────────────────────────────┐
│             Rust Backend (src-tauri/)                │
│                                                      │
│  #[tauri::command] 函数 + rusqlite                   │
│  + tauri-plugin-fs / dialog / shell / updater        │
│                                                      │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │  db.rs       │  │  commands/   │  │  models/   │  │
│  │  DatabaseMgr │  │  8 个模块     │  │  serde DTO │  │
│  │  rusqlite    │  │  对应 ipc/*  │  │  PartType  │  │
│  └─────────────┘  └──────────────┘  └────────────┘  │
│                                                      │
│  State<Mutex<Connection>> 管理 SQLite 连接             │
└──────────────────────┬──────────────────────────────┘
                       │  系统 WebView (非 Chromium)
          ┌────────────▼────────────┐
          │  macOS: WKWebView (WebKit)  │
          │  Windows: WebView2 (Chromium)│
          │  Linux: WebKitGTK           │
          └─────────────────────────────┘
```

**核心设计**：Tauri commands 等价于 Electron 的 `ipcMain.handle` + `window.electronAPI.invoke()`。Rust 后端按模块组织，结构镜像当前 `electron/ipc/*.ts`。无需 HTTP/REST 层。

## 2. 目标项目结构

```
OpenCode-W/
├── src-tauri/               # Rust 后端（新建，替代 electron/）
│   ├── Cargo.toml           # Rust 依赖
│   ├── tauri.conf.json      # Tauri 配置（替代 electron-builder.yml）
│   ├── capabilities/        # 权限 ACL 配置
│   │   └── main.json        # 主窗口权限
│   ├── icons/               # 应用图标
│   └── src/
│       ├── main.rs          # Tauri 应用入口
│       ├── lib.rs           # 命令注册 + State 初始化
│       ├── db.rs            # DatabaseManager (rusqlite)
│       ├── security.rs      # 路径校验 (validateDbPath)
│       ├── commands/        # IPC 命令模块（对应 electron/ipc/）
│       │   ├── mod.rs       # 模块导出 + register_all()
│       │   ├── analytics.rs # 仪表盘数据聚合
│       │   ├── sessions.rs  # 会话 CRUD
│       │   ├── messages.rs  # 消息查询 + parsePartData
│       │   ├── cleanup.rs   # 清理向导（事务 + 注入防护）
│       │   ├── backup.rs    # 备份恢复（fs 操作）
│       │   ├── todos.rs     # 待办查询
│       │   ├── database.rs  # DB 管理（open/health/vacuum/checkpoint）
│       │   └── update.rs    # 自动更新（状态机 + 事件）
│       └── models/          # serde 数据结构（对应 shared/types.ts）
│           ├── mod.rs
│           ├── dto.rs       # IpcResult, DatabaseStats, SessionDTO 等
│           └── part.rs      # PartDTO + 12 PartType enum
├── src/                     # React 前端（保留，仅 ipc.ts 改写）
│   ├── lib/
│   │   └── ipc.ts           # 改写为 Tauri invoke 封装
│   ├── features/            # 不变
│   ├── components/          # 不变
│   └── main.tsx             # 不变
├── shared/                  # 保留（TS 类型 + 通道常量）
│   ├── types.ts             # 保留（前端类型声明）
│   └── ipc-channels.ts      # 保留（command 名称常量）
├── docs/                    # 保留
└── package.json             # 更新依赖 + 版本号
```

## 3. IPC 命令映射（35 通道 → Tauri commands）

### 3.1 命名映射规则

Electron IPC 通道名（如 `dashboard:overview`）→ Tauri command 名（如 `dashboard_overview`）。冒号 `:` 替换为下划线 `_`，符合 Rust 命名规范。

### 3.2 完整映射表

| 模块 | Electron 通道 | Tauri Command | Rust 函数签名（简） |
|------|--------------|---------------|-------------------|
| Dashboard | `dashboard:overview` | `dashboard_overview` | `(state, time_range?) -> DbStats` |
| | `dashboard:tokens` | `dashboard_tokens` | `(state, time_range?, group_by?) -> TokenStats \| Vec<TokenGroup>` |
| | `dashboard:toolRanking` | `dashboard_tool_ranking` | `(state, time_range?) -> Vec<ToolRanking>` |
| | `dashboard:skillUsage` | `dashboard_skill_usage` | `(state, time_range?) -> Vec<SkillUsage>` |
| | `dashboard:modelRanking` | `dashboard_model_ranking` | `(state, time_range?) -> Vec<ModelRanking>` |
| | `dashboard:providerStats` | `dashboard_provider_stats` | `(state, time_range?) -> Vec<ProviderStats>` |
| | `dashboard:sessionTrend` | `dashboard_session_trend` | `(state, time_range?, root_only?) -> Vec<SessionTrend>` |
| | `dashboard:costTrend` | `dashboard_cost_trend` | `(state, time_range?) -> Vec<CostTrend>` |
| | `dashboard:messageTrend` | `dashboard_message_trend` | `(state, time_range?) -> Vec<MessageTrend>` |
| Sessions | `sessions:list` | `sessions_list` | `(state, filter) -> Paginated<SessionDTO>` |
| | `sessions:detail` | `sessions_detail` | `(state, id) -> SessionDetailDTO` |
| | `sessions:projects` | `sessions_projects` | `(state) -> Vec<String>` |
| | `sessions:delete` | `sessions_delete` | `(state, id) -> bool` |
| | `sessions:children` | `sessions_children` | `(state, parent_id) -> Vec<SessionDTO>` |
| | `sessions:rename` | `sessions_rename` | `(state, id, title) -> bool` |
| | `sessions:move` | `sessions_move` | `(state, filter) -> bool` |
| Messages | `messages:list` | `messages_list` | `(state, filter) -> Paginated<MessageDTO>` |
| | `messages:detail` | `messages_detail` | `(state, id) -> MessageDetailDTO` |
| | `messages:list-by-parent` | `messages_list_by_parent` | `(state, filter) -> Paginated<MessageDTO>` |
| | `messages:search` | `messages_search` | `(state, keyword) -> Vec<SearchResult>` |
| Cleanup | `cleanup:preview` | `cleanup_preview` | `(state, filter) -> CleanupPreviewDTO` |
| | `cleanup:execute` | `cleanup_execute` | `(state, filter) -> CleanupResultDTO` |
| Database | `database:open` | `database_open` | `(state, path) -> String` |
| | `database:health` | `database_health` | `(state) -> HealthInfo` |
| | `database:vacuum` | `database_vacuum` | `(state) -> VacuumResult` |
| | `database:checkpoint` | `database_checkpoint` | `(state) -> bool` |
| Dialog | `dialog:openFile` | `dialog_open_file` | `() -> String` |
| | `dialog:openDirectory` | `dialog_open_directory` | `() -> String?` |
| Shell | `shell:openExternal` | `shell_open_external` | `(url) -> bool` |
| Backup | `backup:create` | `backup_create` | `(state) -> BackupDTO` |
| | `backup:list` | `backup_list` | `() -> Vec<BackupDTO>` |
| | `backup:restore` | `backup_restore` | `(state, path?) -> String` |
| | `backup:delete` | `backup_delete` | `(file_name) -> bool` |
| | `backup:preview` | `backup_preview` | `(file_name) -> BackupPreviewDTO` |
| Todos | `todos:by-parent` | `todos_by_parent` | `(state, filter) -> Vec<TodoDTO>` |
| Share | `session-share:get` | `session_share_get` | `(state, session_id) -> SessionShareDTO` |
| Update | `update:check` | `update_check` | `(state) -> UpdateCheckResult` |
| | `update:download` | `update_download` | `(state) -> bool` |
| | `update:install` | `update_install` | `(state) -> bool` |
| | `update:get-state` | `update_get_state` | `(state) -> UpdateState` |
| Update Events | `update:event:available` | Tauri event `update://available` | `app.emit("update://available", info)` |
| | `update:event:not-available` | Tauri event `update://not-available` | `app.emit("update://not-available", ())` |
| | `update:event:progress` | Tauri event `update://progress` | `app.emit("update://progress", progress)` |
| | `update:event:downloaded` | Tauri event `update://downloaded` | `app.emit("update://downloaded", info)` |
| | `update:event:error` | Tauri event `update://error` | `app.emit("update://error", error)` |

## 4. 数据访问层

### 4.1 rusqlite Connection 管理

```rust
use rusqlite::Connection;
use std::sync::Mutex;
use tauri::State;

pub struct DbState(pub Mutex<Option<Connection>>);

#[tauri::command]
pub fn database_open(state: State<DbState>, path: String) -> Result<String, String> {
    validate_db_path(&path)?;
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
    let mut lock = state.0.lock().unwrap();
    *lock = Some(conn);
    Ok(path)
}
```

### 4.2 SQL 查询模式

所有 SQL 语句**完全不变**——`json_extract`、`strftime`、`GROUP_CONCAT`、`COALESCE` 等都是 SQLite 原生函数，在 rusqlite 中行为一致。

```rust
// analytics.rs — SQL 与 Electron 版完全相同
#[tauri::command]
pub fn dashboard_tokens(
    state: State<DbState>,
    time_range: Option<TimeRange>,
    group_by: Option<String>,
) -> Result<TokenStats, String> {
    let lock = state.0.lock().unwrap();
    let conn = lock.as_ref().ok_or("No database open")?;
    // SQL 语句与 electron/ipc/analytics.ts 完全一致
    let row = conn.query_row(
        "SELECT COALESCE(SUM(json_extract(p.data, '$.tokens.input')), 0) as inputTokens, ...
         FROM part p WHERE json_extract(p.data, '$.type') = 'step-finish'",
        [],
        |row| { /* ... */ },
    );
    // ...
}
```

## 5. 安全模型

### 5.1 Capability/Permission ACL

```json
// src-tauri/capabilities/main.json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "main-capability",
  "windows": ["main"],
  "platforms": ["linux", "macOS", "windows"],
  "permissions": [
    "core:default",
    "dialog:allow-open",
    "shell:allow-open",
    "fs:allow-read-file",
    "fs:allow-write-file",
    "updater:default"
  ]
}
```

### 5.2 路径校验（Rust 重写）

```rust
// security.rs — 对应 electron/main.ts validateDbPath
use std::path::{Path, PathBuf};
use dirs::home_dir;

pub fn validate_db_path(path: &str) -> Result<PathBuf, String> {
    let home = home_dir().ok_or("Cannot find home directory")?;
    let allowed_roots = [
        home.join(".local/share/opencode"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../test-data"),
    ];
    let abs = PathBuf::from(path).canonicalize().map_err(|e| e.to_string())?;
    let inside = allowed_roots.iter().any(|root| abs.starts_with(root));
    if !inside {
        return Err("不允许打开该目录下的数据库文件".into());
    }
    // 扩展名白名单
    let ext = abs.extension().and_then(|e| e.to_str()).unwrap_or("");
    match ext {
        "db" | "sqlite" | "sqlite3" => Ok(abs),
        _ => Err(format!("数据库扩展名不允许：{}", ext)),
    }
}
```

## 6. 自动更新

### 6.1 tauri-plugin-updater 配置

```json
// tauri.conf.json
{
  "bundle": { "createUpdaterArtifacts": true },
  "plugins": {
    "updater": {
      "pubkey": "CONTENT FROM PUBLICKEY.PEM",
      "endpoints": [
        "https://github.com/WebbLee94/OpenCode-W/releases/latest/download/latest.json"
      ]
    }
  }
}
```

### 6.2 状态机 + 事件推送

Rust 后端管理 `UpdateState`（idle/available/downloading/downloaded/installing），通过 `app.emit("update://available", info)` 推送事件，前端通过 `listen("update://available", cb)` 监听——等价于 Electron 的 `webContents.send()` + `ipcRenderer.on()`。

## 7. 构建与打包

### 7.1 tauri.conf.json

```json
{
  "productName": "OpenCode-W",
  "version": "1.3.0",
  "identifier": "com.webb.opencode-w",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:5173"
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": ["icons/icon.icns", "icons/icon.ico", "icons/icon.png"],
    "macOS": { "hardenedRuntime": true, "minimumSystemVersion": "10.13" },
    "windows": { "nsis": null, "webviewInstallMode": { "type": "downloadBootstrapper" } },
    "linux": { "appimage": {}, "deb": {} }
  }
}
```

### 7.2 三平台打包目标

| 平台 | 格式 | 架构 | 签名 |
|------|------|------|------|
| macOS | DMG | universal (arm64+x64) | hardenedRuntime + notarization |
| Windows | NSIS | x64 + arm64 | 代码签名（可选） |
| Linux | AppImage + deb | x64 | — |

## 8. 技术栈选型（更新后）

| 层面 | 方案 | 理由 |
|------|------|------|
| 桌面框架 | Tauri v2 | 包体积 3-15MB，系统 WebView |
| 后端语言 | Rust | 性能、安全、rusqlite 直连 |
| SQLite | rusqlite | 同步 API，WAL/PRAGMA/json_extract 全支持 |
| 前端 | React 18 + TypeScript 5 | 保留不变 |
| 样式 | Tailwind CSS 4 | 保留不变 |
| 图表 | Recharts | 保留不变 |
| 构建 | Vite 5 + cargo | 前端 Vite + 后端 cargo |
| 打包 | Tauri bundler | 三平台原生支持 |
| 自动更新 | tauri-plugin-updater | 公钥签名 + GitHub Releases |
| 测试 | Vitest + cargo test | 前端 Vitest + 后端 cargo test |

## 9. 与 Electron 架构的对应关系

| Electron (现状) | Tauri v2 (目标) | 对应关系 |
|----------------|----------------|---------|
| `electron/main.ts` | `src-tauri/src/main.rs` + `lib.rs` | 入口 + 生命周期 |
| `electron/database.ts` | `src-tauri/src/db.rs` | DatabaseManager |
| `electron/preload.ts` | 不需要 | Tauri 无 preload |
| `electron/ipc/*.ts` | `src-tauri/src/commands/*.rs` | IPC 命令模块 |
| `shared/types.ts` | `src-tauri/src/models/*.rs` | DTO（Rust serde） |
| `shared/ipc-channels.ts` | Tauri command 名称 | 通道→命令映射 |
| `src/lib/ipc.ts` | 改写为 `invoke()` 封装 | 前端 IPC 入口 |
| `electron-builder.yml` | `tauri.conf.json` | 打包配置 |
| `vite-plugin-electron` | Vite 原生 | 前端构建 |
| `electron-updater` | `tauri-plugin-updater` | 自动更新 |
| `contextBridge` | Tauri commands | 安全 IPC |
| `ipcMain.handle` | `#[tauri::command]` | 后端命令注册 |
| `ipcRenderer.invoke` | `@tauri-apps/api/core invoke` | 前端调用 |
| `webContents.send` | `app.emit` | 事件推送 |
| `ipcRenderer.on` | `@tauri-apps/api/event listen` | 事件监听 |
