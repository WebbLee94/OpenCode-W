# 06-Tauri v2 迁移可行性分析

> **状态**：已完成
> **创建日期**：2026-07-07
> **作者**：Webb Lee + 架构师 Agent
> **关联 ADR**：[0006-迁移到Tauri-v2与Rust后端](../05-决策记录/0006-迁移到Tauri-v2与Rust后端.md)

## 1. 背景与目标

### 1.1 背景

OpenCode-W 当前基于 Electron 42 + React 18 + TypeScript 构建，制品包约 100MB。考虑到 Tauri v2（Rust 后端 + 系统 WebView）在包体积、性能、安全性上的优势，评估迁移可行性。

### 1.2 目标

1. **系统性、全面性对比**改造前后的相关维度
2. 识别不可行维度并提供替代方案
3. 评估功能保留性（改造后功能可强化但不能丢失）

### 1.3 用户决策输入

| 决策项 | 选择 |
|--------|------|
| 团队 Rust 能力 | 熟练使用 |
| 迁移动机优先级 | 包体积 > 性能 > 安全性 |
| parsePartData 策略 | A（Rust + serde_json 重写） |
| 迁移方式 | 一次性切换（非渐进式） |

## 2. 项目现状速览

| 维度 | 现状 |
|------|------|
| 桌面框架 | Electron 42（主进程 + preload.cjs + 渲染进程三层） |
| 后端语言 | TypeScript（Node.js 内嵌 v24.15） |
| 数据库 | `node:sqlite` `DatabaseSync`（同步 API，WAL 模式） |
| IPC 机制 | `contextBridge` + `ipcMain.handle` + `window.electronAPI.invoke()` |
| 通道数 | 35 个 IPC 通道，分布在 8 个模块 |
| 后端代码量 | ~2,300 行 TypeScript |
| 前端 | React 18 + Vite 5 + Tailwind 4 + Recharts + react-markdown |
| 安全 | contextIsolation + nodeIntegration:false + 路径穿越防护 + 协议白名单 + 通道白名单 |
| 自动更新 | electron-updater（手动模式，5 个 push 事件，GitHub Releases） |
| 打包 | electron-builder：macOS DMG(universal) / Windows NSIS(x64+arm64) / Linux AppImage+deb(x64) |
| 包体积 | ~100MB |

### 2.1 IPC 通道清单（35 通道，8 模块）

| 模块 | 通道数 | 通道列表 |
|------|--------|---------|
| Dashboard | 9 | overview, tokens, toolRanking, skillUsage, modelRanking, providerStats, sessionTrend, costTrend, messageTrend |
| Sessions | 7 | list, detail, projects, delete, children, rename, move |
| Messages | 4 | list, detail, list-by-parent, search |
| Cleanup | 2 | preview, execute（手动事务 + SQL 注入防护） |
| Database | 4 | vacuum, checkpoint, open, health |
| Dialog/Shell | 3 | openFile, openDirectory, openExternal |
| Backup | 5 | create, list, restore, delete, preview（重 fs 操作） |
| Todos/Share | 2 | by-parent, get |
| Update | 4 invoke + 5 event | check, download, install, get-state + 5 push events |

### 2.2 关键文件行数

| 文件 | 行数 | 迁移复杂度 | 说明 |
|------|------|-----------|------|
| `electron/main.ts` | 280 | 🟡 中 | 生命周期 + 安全校验 + 自动更新启动 |
| `electron/database.ts` | 207 | 🟢 低 | rusqlite API 一一对应 |
| `electron/preload.ts` | 77 | 🟢 低 | Tauri 无 preload，直接移除 |
| `electron/ipc/analytics.ts` | 326 | 🟡 中 | SQL 不变，仅 Rust 类型映射 |
| `electron/ipc/messages.ts` | 474 | 🔴 高 | parsePartData 216 行，12 PartType |
| `electron/ipc/cleanup.ts` | 248 | 🟡 中 | 事务 + SQL 注入防护 |
| `electron/ipc/backup.ts` | 259 | 🟡 中 | fs 操作 + WAL/SHM + 安全备份 |
| `electron/ipc/update.ts` | 150 | 🟡 中 | 状态机 + 事件推送 |
| `electron/ipc/sessions.ts` | ~200 | 🟢 低 | 标准 CRUD |
| `electron/ipc/todos.ts` | ~80 | 🟢 低 | 简单 JOIN |
| `shared/types.ts` | 379 | — | DTO 定义（Rust serde 对应） |
| `shared/ipc-channels.ts` | 70 | — | 通道常量（Tauri command 名对应） |
| `src/lib/ipc.ts` | 80 | 🟢 低 | 唯一需改的前端文件 |

## 3. Tauri v2 架构概览

```
┌─────────────────────────────────────────────┐
│           Frontend (WebView)                 │
│  React 18 + Vite + Tailwind (几乎不变)       │
│  调用方式: invoke('cmd', args) from          │
│            @tauri-apps/api/core              │
└──────────────────┬──────────────────────────┘
                   │  Tauri Commands (JSON-RPC-like)
┌──────────────────▼──────────────────────────┐
│         Rust Backend (src-tauri/)            │
│  #[tauri::command] 函数 + rusqlite           │
│  + tauri-plugin-fs/dialog/shell/updater      │
│  State<Connection> 管理 SQLite 连接           │
└──────────────────┬──────────────────────────┘
                   │  系统 WebView (非 Chromium)
          ┌────────▼────────┐
          │  macOS: WKWebView  │
          │  Windows: WebView2 │
          │  Linux: WebKitGTK  │
          └───────────────────┘
```

**关键认知**：在 Tauri v2 中，"Rust 后端"就是 Tauri 的原生后端。用 Rust 写 `#[tauri::command]` 函数，前端通过 `invoke('cmd', args)` 调用——等价于 Electron 的 `ipcMain.handle` + `window.electronAPI.invoke()`。不需要额外的 HTTP/REST 层。

## 4. 多维度系统对比

### 4.1 制品包体积

| 维度 | Electron (现状) | Tauri v2 | 评估 |
|------|----------------|----------|------|
| 安装包大小 | ~100MB | ~3-15MB | ✅ 大幅改善（10x 缩小） |
| 原因 | 捆绑 Chromium + Node.js | 使用系统 WebView，Rust 二进制极小 | — |
| 用户下载体验 | 慢，占用磁盘空间大 | 快，轻量 | ✅ 显著提升 |

### 4.2 性能

| 维度 | Electron (现状) | Tauri v2 | 评估 |
|------|----------------|----------|------|
| 启动时间 | 1-3s（Chromium 初始化） | 200-500ms | ✅ 改善 |
| 内存占用 | ~150-300MB | ~50-120MB | ✅ 改善 30-60% |
| IPC 延迟 | ipcMain.handle（序列化开销） | invoke（JSON-RPC，类似） | ⚖️ 持平 |
| SQL 查询 | node:sqlite 同步，V8 绑定 | rusqlite 同步，原生 FFI | ✅ 略优 |

### 4.3 安全性

| 维度 | Electron (现状) | Tauri v2 | 评估 |
|------|----------------|----------|------|
| 隔离模型 | contextIsolation + nodeIntegration:false | 系统 WebView + 无 Node.js 后端 | ✅ 更强 |
| 权限控制 | 通道白名单（preload 硬编码） | Capability/Permission ACL（细粒度） | ✅ 更强 |
| CSP | webSecurity:true | 强制 CSP + 权限作用域 | ✅ 更强 |
| 路径安全 | 手写 validateDbPath + startsWith | tauri-plugin-fs scope + 自定义 Rust 校验 | ⚖️ 持平 |
| 整体评级 | Electron 最佳实践 | 默认更安全 | ✅ 改善 |

### 4.4 SQLite 数据访问

| 维度 | node:sqlite (现状) | rusqlite (Tauri) | tauri-plugin-sql | 评估 |
|------|-------------------|------------------|------------------|------|
| API 模式 | DatabaseSync 同步 | Connection 同步 | 异步 | rusqlite ✅ |
| WAL 模式 | ✅ | ✅ | ✅ | 持平 |
| PRAGMA | ✅ | ✅ | ⚠️ 有限 | rusqlite ✅ |
| json_extract | ✅ SQLite 原生 | ✅ SQLite 原生 | ✅ SQLite 原生 | 持平 |
| 事务 | 手动 BEGIN/COMMIT/ROLLBACK | Transaction 封装 + 手动 | ⚠️ 有限 | rusqlite ✅ 更优 |
| 任意 SQL | ✅ | ✅ | ❌ 面向 migrations | rusqlite ✅ |
| readOnly | ✅ { readOnly: true } | ✅ OpenFlags::READ_ONLY | ❌ | rusqlite ✅ |
| 连接管理 | 单例 Map | tauri::State<Mutex<Connection>> | 插件管理 | rusqlite ✅ |

**结论**：✅ 完全可行。rusqlite 是 node:sqlite 的直接对应物，API 形态几乎一一映射。

### 4.5 文件系统操作

| Node fs (现状) | Rust std::fs | 评估 |
|----------------|-------------|------|
| fs.copyFileSync | std::fs::copy | ✅ 直接对应 |
| fs.existsSync | Path::exists | ✅ 直接对应 |
| fs.mkdirSync({recursive}) | std::fs::create_dir_all | ✅ 直接对应 |
| fs.readdirSync | std::fs::read_dir | ✅ 直接对应 |
| fs.statSync | std::fs::metadata | ✅ 直接对应 |
| fs.unlinkSync | std::fs::remove_file | ✅ 直接对应 |
| dialog.showOpenDialog | tauri-plugin-dialog::open | ✅ 直接对应 |

**结论**：✅ 完全可行。所有 fs 操作都有直接 Rust 对应物。

### 4.6 自动更新

| 维度 | electron-updater (现状) | tauri-plugin-updater | 评估 |
|------|------------------------|---------------------|------|
| 检查 | autoUpdater.checkForUpdates() | app.updater()?.check().await | ✅ 对应 |
| 下载+安装 | downloadUpdate() + quitAndInstall() | update.download_and_install().await + app.restart() | ✅ 对应 |
| 进度回调 | download-progress 事件（push） | download_and_install 闭包回调 | ✅ 对应 |
| 事件推送 | webContents.send() → ipcRenderer.on() | app.emit() → 前端 listen() | ✅ 对应 |
| GitHub Releases | ✅ 原生 | ✅ endpoints 配置 | ✅ 对应 |
| 签名验证 | blockmap 增量 | 公钥签名验证（更严格） | ✅ Tauri 更强 |
| 状态机 | 5 态手写 | 需手动实现等价状态管理 | ⚠️ 需重写 |

**结论**：✅ 可行但需重写。update.ts（150 行）需用 Rust 重写。

### 4.7 跨平台打包

| 维度 | electron-builder (现状) | Tauri bundler | 评估 |
|------|------------------------|---------------|------|
| macOS | DMG + ZIP, universal | DMG, universal | ✅ 对应 |
| Windows | NSIS, x64+arm64 | NSIS + MSI, x64+arm64 | ✅ 更丰富 |
| Linux | AppImage + deb, x64 | AppImage + deb + rpm, x64 | ✅ 更丰富 |
| 代码签名 | CSC_LINK / CSC_KEY_PASSWORD | 证书 + notarization | ✅ 对应 |
| GitHub Releases | publish provider | endpoints 配置 | ✅ 对应 |

**结论**：✅ 完全可行且更丰富。

### 4.8 渲染层兼容性

| 维度 | 现状 | Tauri v2 | 评估 |
|------|------|----------|------|
| React 18 | ✅ | ✅ 完全支持 | ✅ 不变 |
| Vite 5 | vite-plugin-electron | Vite 原生（更简单） | ✅ 改善 |
| Tailwind 4 | ✅ | ✅ | ✅ 不变 |
| Recharts | ✅ | ✅ | ✅ 不变 |
| react-markdown | ✅ | ✅ | ✅ 不变 |
| IPC 调用层 | window.electronAPI.invoke() | invoke() from @tauri-apps/api/core | ⚠️ 需改（仅 src/lib/ipc.ts） |
| 系统 WebView 差异 | Chromium 一致 | 三引擎（WebKit/WebView2/WebKitGTK） | ⚠️ 新风险 |

**结论**：✅ 高度可行。React 代码几乎不变，仅 IPC 调用入口需改。

### 4.9 系统 WebView 差异（新风险）

| 维度 | Electron (Chromium 一致) | Tauri v2 (三引擎) | 风险 |
|------|--------------------------|-------------------|------|
| CSS 渲染 | 完全一致 | 细微差异可能 | 低（Tailwind 跨引擎兼容性好） |
| JS API | Chromium 最新 | WebKit 可能滞后 | 低（React 18 不用前沿 API） |
| 调试 | Chrome DevTools | 各平台 WebView 调试工具不同 | 中 |

**结论**：⚠️ 可控风险。需三平台回归测试。

## 5. 功能保留性评估

**核心结论：所有功能均可保留，无功能丢失风险。**

| 功能模块 | 可保留？ | 迁移策略 |
|---------|---------|---------|
| 仪表盘（9 通道） | ✅ | SQL 不变，Rust 类型映射 |
| 会话浏览（7 通道） | ✅ | 标准 CRUD + rusqlite |
| 消息查看（4 通道） | ✅ | parsePartData 用 serde_json 重写（策略 A） |
| 清理向导（2 通道） | ✅ | 事务 + 注入防护用 Rust 重写 |
| 备份恢复（5 通道） | ✅ | std::fs 直接对应 |
| 数据库管理（4 通道） | ✅ | rusqlite PRAGMA/VACUUM |
| 自动更新（4+5 通道） | ✅ | tauri-plugin-updater + 事件系统 |
| 对话框/Shell（3 通道） | ✅ | tauri-plugin-dialog/shell |
| 待办/分享（2 通道） | ✅ | 简单查询 |
| 路径安全校验 | ✅ | Rust 重写 validateDbPath |
| macOS About/Dock | ✅ | Tauri 菜单 API |

## 6. 风险分析

| 风险 | 级别 | 缓解方案 |
|------|------|---------|
| ~~团队 Rust 能力~~ | ✅ 已消除 | 用户确认团队 Rust 熟练 |
| parsePartData 216 行 TS→Rust | 🟡 中 | 策略 A：serde_json + Rust enum 重写 |
| 系统 WebView 差异 | 🟡 中 | 三平台回归测试 |
| CI/CD 重建 | 🟢 低 | tauri-apps/tauri-action 官方 CI |
| 功能一致性保障 | 🟡 中 | 逐模块对比测试 + 集成测试 |

## 7. "Rust 后端框架"架构建议

| 方案 | 描述 | 推荐度 |
|------|------|--------|
| **A. Tauri Commands** | #[tauri::command] + invoke() | ⭐⭐⭐ 强烈推荐 |
| B. 嵌入 Axum HTTP | Axum 跑在 Tauri 内 | ❌ 过度设计 |
| C. Sidecar Node.js | 保留 Node 后端 | ❌ 违背初衷 |

**推荐方案 A**：Tauri commands 等价于 Electron ipcMain.handle，无需 HTTP 层。Rust 代码按模块组织（`src-tauri/src/db.rs`、`analytics.rs` 等），等价于当前 `electron/ipc/*.ts` 结构。

## 8. 综合建议

### 8.1 可行性总评

| 维度 | 可行性 |
|------|--------|
| 包体积 | ✅ 大幅改善（100MB → 3-15MB） |
| 性能 | ✅ 改善（启动快 2-5x，内存低 30-60%） |
| 安全性 | ✅ 改善（ACL 权限系统更强） |
| SQLite 访问 | ✅ 完全可行（rusqlite 一一对应） |
| 文件系统 | ✅ 完全可行（std::fs 一一对应） |
| 自动更新 | ✅ 可行（需重写状态机） |
| 跨平台打包 | ✅ 可行且更丰富 |
| 渲染层 | ✅ 高度可行（React 不变） |
| 功能保留 | ✅ 100% 可保留 |
| 系统 WebView | ⚠️ 可控风险（需回归测试） |

### 8.2 结论

**技术可行，推荐迁移。** 团队 Rust 熟练（最大风险已消除），所有功能均可保留，包体积/性能/安全性均显著改善。采用一次性切换方式，按模块逐个迁移并对比测试以保障功能一致性。

### 8.3 关联文档

- [ADR-0006：迁移到 Tauri v2 与 Rust 后端](../05-决策记录/0006-迁移到Tauri-v2与Rust后端.md)
- [Tauri v2 目标架构](../02-架构设计/04-Tauri-v2目标架构.md)
- [Tauri v2 迁移方案](../04-技术方案/07-Tauri-v2迁移方案.md)
