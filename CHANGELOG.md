# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.1] - 2026-07-08

> **构建与签名解耦（利好开源协作）**：贡献者 Pull 代码后无需任何签名密钥即可本地出包；自动更新能力对终端用户完全无感知。

### 🔧 Changed｜构建配置

- **自动更新签名与本地构建解耦**：`tauri.conf.json` 中 `createUpdaterArtifacts` 默认由 `true` 改为 `false`，贡献者 / GitHub 上的非发布构建无需 `TAURI_SIGNING_PRIVATE_KEY` 等私钥即可正常出包。仅 **tag 发布** 时，Release CI（`.github/workflows/release.yml`）临时将该项置为 `true` 并注入签名 Secret，生成 `.sig` 更新构件。公开的 `pubkey` 始终保留在仓库中，本地构建出的 App 仍可验证官方发布的更新。

### 🐛 Fixed｜问题修复

- **修复贡献者本地构建被私钥卡住**：此前 `createUpdaterArtifacts: true` 与公开 `pubkey` 一同提交仓库，导致任何本地 `npm run tauri:build` 都会因缺少维护者私钥而报错（`A public key has been found, but no private key`）。现将更新构件生成默认关闭，本地出包与开源协作不再依赖签名密钥。

### 📌 升级说明

- **终端用户无感知**：应用内自动更新能力保持不变，官方 Release 仍由 CI 用私钥签名、App 用提交的公开 `pubkey` 验签。
- **维护者发布带自动更新的版本**：仍需在仓库 **Secrets** 配置 `TAURI_SIGNING_PRIVATE_KEY` 与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（Tauri 不读取 `.env`，必须是真实环境变量 / CI Secret）。

## [1.3.0] - 2026-07-08

> **重大架构迁移：从 Electron 42 切换到 Tauri v2 (Rust 后端)**。应用体积更小（安装包 7.1 MB）、启动更快、彻底告别 `NODE_MODULE_VERSION` 报错。同时清理了大量 Electron 遗留代码与配置。

### 🔥 Changed｜重大架构变更（升级前请务必阅读）

- **🔥 Electron → Tauri v2**：从 Electron 42 + Node.js 迁移到 Tauri v2 + Rust 后端，`rusqlite`（bundled）替代 `node:sqlite`，IPC 从 `contextBridge` 迁移到 Tauri `invoke()`。
- **删除旧 Electron 代码**：`electron/`、`dist-electron/`、`src/types/electron.d.ts` 目录及文件已移除；`electron-builder`、`@electron/rebuild` 等 npm 依赖已卸载。
- **纯 Rust 数据库层**：所有 SQL 操作通过 Rust 端 `rusqlite` 同步 API 执行，命令模块结构保持不变但使用 Tauri 命令宏注册（`#[tauri::command]`）。
- **单一 Binary Crate**：合并 `lib.rs` → `main.rs`，省略 `[lib]` 目标以绕过 macOS arm64 上 LLVM 归档器 `.rlib` 静态打包 bug。
- **macOS 安装包发布模式变更**：`tauri build --bundles dmg` 输出 `.dmg` 格式，不再使用 `electron-builder` 的 `.dmg` 生成流程。
- **数据库连接池优化**：引入 `r2d2` + `r2d2_sqlite` 连接池，替换原有的 `Arc<Mutex<Option<Connection>>>` 嵌套锁模式，提升并发查询性能。
- **异步命令改造**：35+ 个同步命令改为 `async fn` + `spawn_blocking`，避免阻塞 Tauri 主线程导致 UI 卡顿。

### ⚡ Added｜新增能力

- **Dashboard 按 Tab 懒加载**：概览/统计/趋势三个 Tab 仅加载当前可见 Tab 的数据，大幅降低首屏加载时间。
- **r2d2 数据库连接池**：支持连接复用与并发访问，合并 Dashboard 计数查询减少数据库调用次数。
- **GitHub Actions CI 完整适配**：添加 Rust 工具链配置、`cargo check`、`cargo clippy` 校验步骤。

### 🐛 Fixed｜问题修复（升级即可受益）

- **Release 构建成功**：修复 LLVM 归档器对超大 `.rlib` 文件引发 `error(ErrorArchive)` 崩溃问题。
- **测试修正**：`errorClassifier.test.ts` 中 2 个测试期望值从 `unknown` 更新为 `no-asset`，1 处消息文本同步修正。
- **TypeScript 配置清理**：移除已废弃的 `baseUrl` 配置项，`tsc --noEmit` 通过。
- **测试范围修正**：`vite.config.ts` 中 vitest `include` / `exclude` 限定为 `src/**/*.{test,spec}.*`，不再尝试运行 e2e 测试。
- **IPC 命令名转换修复**：camelCase 和连字符完整转换为 snake_case，确保命令正确匹配。
- **Dialog 阻塞问题修复**：使用 `tokio::sync::oneshot` channel 将回调式 API 转换为 async，避免切换数据源时应用卡死。
- **检查更新失败修复**：完善错误分类逻辑，`no-asset` 状态正确显示"暂无可用的更新"而非报错。
- **Lint 错误修复**：移除 `e2e/console-errors.spec.ts` 未使用的 `expect` 导入；为 `UpdateContext` 的 `useCallback` 添加缺失的 `toast` 依赖。
- **构建命令修复**：`tauri:build` 脚本改为先执行 `npm run build` 再调用 `tauri build`，确保前端资源已生成。
- **Ubuntu 构建依赖修复**：更新系统依赖安装命令，使用 `libwebkit2gtk-4.1-dev` 替代过时的 `libwebkit2gtk-4.0-dev`。
- **更新签名公钥修复**：移除 `tauri.conf.json` 中空字符串的 `pubkey` 字段，修复构建时公钥解析失败问题。

### 🧹 Cleanup｜代码清理

- **移除 `isElectron` 别名**：`src/lib/ipc.ts` 中已无活跃引用的 `isElectron` 导出。
- **移除 Electron 主入口配置**：删除 `package.json` 中的 `"main": "src-tauri/target/release/opencode-w"` 字段。
- **GitHub Actions CI 更新**：CI 流程从 Electron 构建切换为 Tauri v2 构建矩阵。
- **Issue 模板更新**：将"Electron版本"字段更新为"Tauri版本"。

### 🛠️ Technical｜技术细节

- Rust toolchain: `rustc 1.96.1`（推荐，最低 1.77.2）
- 前端开发：`npm run dev` 仅启动 Vite；`npm run tauri:dev` 启动完整 Tauri 开发模式
- 打包：`npm run tauri:build`（macOS 输出 `.dmg`，也可指定 `--bundles`）
- IPC 调用：命令名自动转换为 snake_case（如 `dashboard:overview` → `dashboard_overview`）
- Serde 序列化：使用 `rename_all = "camelCase"` 确保前后端参数命名一致

### ⚠️ 升级注意事项

| 项目 | v1.2.x (Electron) | v1.3.0 (Tauri) |
|------|-------------------|----------------|
| 开发启动 | `npm run dev` | `npm run tauri:dev` |
| 打包命令 | `npm run build` | `npm run tauri:build` |
| 数据库驱动 | `node:sqlite` (Node.js) | `rusqlite` (Rust, bundled) |
| IPC 调用 | `window.electronAPI.invoke()` | `window.__TAURI_INTERNALS__.invoke()` |
| 安装包格式 | Electron + electron-builder | Tauri + 系统原生格式 |
| Rust 工具链 | 不需要 | 必须安装 `rustc` + `cargo` |

## [1.2.1] - 2026-07-07

> **应用内版本更新能力上线**：在「设置」页可一键检查/下载/安装 GitHub Releases 新版本；侧边栏自动出现红点提示。本期采用手动确认模式（macOS / Windows 无代码签名场景下用户需在系统弹窗中确认一次）。

### ✨ Added｜新增能力

- **🔥 应用内版本更新**：启动后后台静默检查 GitHub Releases,发现新版本在侧边栏显示红点;在「设置 → 版本更新」查看详情,一键下载与安装（手动模式,避免静默安装被 Gatekeeper / SmartScreen 拦截）。
- **侧边栏红点提示**：新版本可用时,「设置」导航项右侧出现红点。
- **进度条 + 安装器接管**：下载过程实时显示百分比与已传输大小;下载完成后一键启动系统安装器。
- **仪表盘缓存读写 Token 指标**：仪表盘新增缓存读、缓存写的独立指标卡片与趋势折线图，让 Token 复用情况一目了然。

### 🛠️ Technical｜实现细节

- 主进程集成 `electron-updater` 库,采用 `autoDownload=false` / `autoInstallOnAppQuit=false` 手动模式。
- 复用现有 GitHub Releases 发布流程,无需额外基础设施。
- 状态机管理（idle / available / downloading / downloaded / installing）,非法转换被拒绝。
- 启动 5s 后单次静默检查,本会话失败不重试（避免启动期阻塞）。
- 本地缓存 `update-cache.json` 记录上次检查时间,便于 UI 展示。

### 🔄 Changed｜重构与优化

- **侧边栏简化**：移除独立的「配置」分组，「设置」入口移到底部工具栏齿轮图标，左侧仅保留概览 / 数据 / 工具三组。
- **设置页新增「数据源」区块**：展示当前数据库连接状态与文件路径，并提供「切换数据源」按钮（原位于侧边栏底部）。
- **设置页布局对齐**：容器样式与 PageHeader 风格与仪表盘、会话浏览等页面保持一致。
- **默认分页优化**：会话列表默认分页从 20 条调整为 10 条，减少初始加载的数据量，页面响应更轻快。

### 🐛 Fixed｜问题修复（升级即可受益）

- **仪表盘统计数据失真**：修复了跨天会话的 Token 和成本统计不准确问题；统计逻辑从 session 表改为从 part 表获取 step-finish 类型的真实逐次用量，确保数据精准。

## [1.2.0] - 2026-06-15

> **品牌升级 + 会话迁移新能力**：DBScope-OC → **OpenCode-W**，全新「AI 编程工程工坊」定位 + 条柱 W Logo；新增根会话批量迁移至指定项目目录的能力，一次整理多个会话更省心。推荐所有用户升级。

### ✨ Added｜新增能力（建议升级的主要理由）

- **🔥 根会话批量迁移**：在会话列表勾选多个根会话后，可通过顶部「📁 迁移」按钮一键批量迁移到指定的项目目录；迁移后相关会话的 `directory` 与 `project_id` 会同步更新，对齐 OpenCode `session migrate` 的目录归属策略，便于按项目维度集中管理历史会话。

### 🔄 Changed｜品牌升级与体验优化

- **品牌重命名**：项目从 `DBScope-OC` 正式更名为 **OpenCode-W**，定位升级为「AI 编程工程工坊」，所有文档与配置项同步更新。
- **新 Logo**：全新条柱 W Logo（蓝紫渐变 #3B82F6 → #8B5CF6），包括 SVG / PNG 12 尺寸 / icns / ico 等全规格资产。
- **工坊式页面标题**：各功能页标题统一为工坊隐喻——工坊总览、素材库、工艺记录、整理车间、归档室，信息层级更直观。
- **会话详情排版微调**：优化会话详情页布局类名与间距，阅读更舒适。
- **文档与配置同步**：README、AGENTS.md、CONTRIBUTING.md、SECURITY.md、CODE_OF_CONDUCT.md、docs/ 全量更新到新版品牌与命名；Issue 模板同步更名。

### 🗑️ Removed｜已移除（升级前请留意）

- **文件导出功能**：该功能在实际使用中与核心数据管理链路关联较弱，为保持产品聚焦与维护性，本版统一移除相关 IPC 通道与页面入口。如你确有导出需求，欢迎通过 Issue 反馈。

### 🐛 Fixed｜问题修复（升级即可受益）

- **会话重命名后选中项未同步更新**：修复了在会话详情页重命名会话后，列表中当前选中项的数据（名称等）仍停留在旧值的问题；现在重命名完成后会自动拉取最新会话数据并刷新界面，并提供轻量操作反馈提示。

### 🛠️ Technical｜实现细节（使用者无需关心，仅作记录）

- 新增 `SESSIONS_BATCH_MIGRATE` 等 IPC 通道，主进程实现会话目录 / project_id 批量更新逻辑，渲染层新增目录选择弹窗与批量迁移交互。
- 主进程与 preload 统一移除 `DIALOG_SAVE_FILE` / `saveFile` 相关通道。
- 所有工程配置、构建描述中的项目名统一更新为 OpenCode-W。

## [1.1.0] - 2026-06-13

> 一次聚焦「**会话浏览更直观、消息查看更顺滑、整体交互更一致**」的大版本。1.0.1 → 1.1.0 共 106 个 commit，**强烈建议升级**：本版修复了若干会导致页面空白/统计错位的问题，并把会话层级、消息查看、交互效率整体提了一档。

### ✨ Added｜新增能力（建议升级的主要理由）

- **🔥 会话层级视图（父子会话）**：在会话列表中可内联展开某个会话的子会话（👶 按钮），并支持「只看根会话 / 显示全部」切换；列表新增「子会话数」列取代原先的「消息数」，一眼分辨出活跃的根会话。
- **🔥 会话详情五 Tab 分栏布局**：点击会话后，页面自动进入 5%/95% 弹性分栏，右侧依次展示「**基础信息 / 解析 / 预览 / 待办 / 分享**」五个 Tab，可通过 URL 直接跳转到指定 Tab（支持从待办、分享等外部入口深度链接）。
- **🔥 消息查看器全新升级（原生对话流）**：不再只是消息列表——新增「**预览 Tab**」可按连续对话流渲染消息，含 Markdown、代码高亮、Tool 调用内联、Reasoning 折叠、Step-finish 摘要等；同时新增「**解析 Tab**」查看结构化 Part 明细（12 种 Part 类型），并支持父/子会话合并查看。
- **🔥 Dashboard 趋势查询**：新增会话数、成本、消息活跃度的趋势查询能力（配合已有的时间范围选择），让数据展示更完整。
- **Dashboard 会话数拆分展示**：会话数统计拆分为根会话数 / 子会话数独立展示，与层级视图对齐。
- **Sessions 键盘导航**：会话列表支持 `j / k` 上下移动、`Enter` 打开详情、`d` 删除，键鼠皆可高效操作。
- **分享信息操作增强**：会话详情基础 Tab 中的分享信息模块支持一键复制链接 + 用系统默认浏览器打开（替代 Electron 内嵌 webview）。

### 🎯 Changed｜显著优化（升级后能明显感觉到更顺手）

- **列头可点击排序**：会话列表表头改为点击即切换排序字段 + 升/降序，不再需要下拉选择框。
- **搜索栏精简 + 日期快捷选择**：筛选区瘦身，日期范围更易点选，视觉上更清爽。
- **系统级标题统一**：所有页面标题统一为「图标 + 中文名」格式（`PageHeader` 组件）。
- **系统级分页栏统一**：Todos / Shares / Sessions / Messages 四个列表分页栏样式、高度、sticky 行为一致。
- **Sidebar 三分组**：左侧菜单按「概览 / 数据 / 工具」分为三个一级分组，更易定位。
- **项目下拉体验优化**：项目下拉搜索支持输入过滤、按项目名排序（非完整路径），对齐会话列表与待办列表的筛选逻辑。
- **会话详情头部优化**：标题改为根会话名（可点击编辑/重命名），删除 / 关闭按钮样式重整。
- **子会话选择器**：解析 / 预览 / 待办 Tab 共用同一子会话选择器，切换子会话更直观，右侧附带子会话统计信息。
- **MessageViewer 分页可配置**：默认 10 条/页，可选 10/20/50，设置持久化。
- **待办 Tab 列表增强**：会话详情待办 Tab 新增序号、优先级、所属会话列 + sticky 底部分页栏，风格对标待办管理页面。
- **长内容折叠展开**：会话列表和聊天界面中长内容支持折叠 / 展开，避免超长条目占据过多屏幕。

### 🗑️ Removed｜已移除（升级前请留意）

- **分享管理页（Shares）**：使用频次低、维护成本高，已从侧栏与路由中移除。
- **全局待办（Todos）与账户管理（Accounts）页面**：为保持产品聚焦与可维护性，从本次版本起不再作为独立页面。
- **Events 事件溯源 IPC**：当前 OpenCode 无对应事件数据，移除相关 IPC 处理代码（无 UI，非用户面功能）。
- **Session 详情右侧滑出面板**：已由本次的「五 Tab 分栏布局」取代，移除旧面板以避免布局冲突。
- **Todos 内联编辑功能**：待办管理恢复为只读展示，移除行内编辑交互。
- **自动备份调度功能**：备份设置面板、定时调度、保留策略整体移除（该功能在开发周期内添加后评估为非核心，于发布前移除）。

### 🐛 Fixed｜问题修复（升级即可受益）

- **🔥 会话浏览页面空白**：`Sessions.tsx` 中 `closeDetail` 的 `useCallback` 缺少闭合括号，导致整个页面编译失败并渲染空白——已修复并通过 `tsc --noEmit` 校验。
- **🔥 Dashboard 统计时区偏差**：时间查询使用 UTC 时区导致与本地日期错位，已修正为按用户本地日期统计。
- **🔥 Dashboard 首屏不显示数据**：项目排行、模型排行、Provider 统计、时间范围选择在组件首次挂载或页面切换后可能为空——已接入 `dashboardCache` 确保数据与用户选择持续生效。
- **子会话数查询列名错误**：`parent_session_id` → `parent_id`；当数据表缺少该列时自动回退为「全部会话」模式，兼容旧版 schema。
- **预览 Tab 显示「暂无消息」**：preload 白名单漏加 `messages:list-by-parent` 通道，导致预览 Tab 永远为空——已补齐。
- **子会话列表排序可视性**：子会话下拉列表按时间戳排序并显示时间，避免顺序不明。
- **Part 内容水平溢出**：解析 Tab 加 `word-wrap + overflow-auto`，长文本不再撑破页面。
- **会话详情页 URL 联动分栏**：`openDetail` 会正确设置 URL `session` 参数并触发分栏布局。
- **若干代码质量问题**：移除 `as any` 类型逃逸、空 `catch`、非 null 断言等常见隐患。

### 🛠️ Technical｜实现细节（使用者无需关心，仅作记录）

- `PartDTO` 扩展 + `parsePartData` 兼容 flat / nested state
- 12 个 Part 独立组件 + 注册表（`PartBubbles`）
- `ConversationView` 组件：连续对话流渲染
- IPC 通道扩容：`MESSAGES_LIST_BY_PARENT` / `TODOS_BY_PARENT` / `SESSIONS_CHILDREN` / `SESSIONS_SHARE` 等 Route B 通道
- 8 个 IPC handler + 6 个 DTO
- `PageHeader` / `PaginationBar` / `SidebarGroup` / `SubSessionSelector` / `MessageViewer` 等共享组件沉淀
- 最低 OpenCode 版本请参考 README 中的要求说明

### 🛠️ Changed (Technical)｜底层升级

- **Electron 30.0.1 → 42.4.0**：跨 12 个大版本升级，Chromium 与 V8 升级修复多个高危 CVE。
- **数据库驱动 `better-sqlite3` → `node:sqlite`**：迁移到 Node 24 内置 `DatabaseSync` 同步 API，零 C++ 原生模块，零 ABI 风险，安装包减少约 8MB；API 形态（`prepare/run/get/all/exec`）与 better-sqlite3 几乎一致，IPC handler 无需改为 async。
- **`electron-builder` 24 → 25 + 移除 `npmRebuild` 步骤**：CI 流水线更精简。
- **数据库路径白名单**：`validateDbPath` 限制仅可打开 `~/.local/share/opencode/` 与仓库内 `test-data/` 下的数据库文件（参见 `electron/main.ts`），避免任意路径误打开。
- **Web 安全显式化**：`webPreferences` 显式声明 `contextIsolation: true`、`nodeIntegration: false`、`webSecurity: true`、`allowRunningInsecureContent: false`，禁止渲染进程加载外部脚本与未签名资源。
- **`engines.node` 上调至 `>=20.11.1`**：与 Electron 42 内嵌 Node 24.15 对齐。
- **扩展名校验**：`DATABASE_OPEN` handler 增 `.db` / `.sqlite` / `.sqlite3` 扩展名白名单。

## [1.0.1] - 2026-05-23

### Added

- **Dashboard**: 时间范围选择 (7/30/90/全部)、6 行分区布局、时段对比曲线、日/周/月聚合切换、并行数据加载 (Promise.all)、缓存复用率指标
- **模块联动**: Dashboard 图表点击 → Sessions 日期/项目筛选 → Messages 详情，全程 URL Query Params 串联
- **Messages**: 跨 Session 全文搜索 + 关键词高亮 + 代码语法高亮 (highlight.js) + 内容预览截断
- **Todos**: 全局待办汇总页面 + Session 详情内嵌 Tab + 状态 (待处理/进行中/已完成/取消)/优先级 (高/中/低)/项目筛选 + position 前缀 [N] + pageSize 可配置
- **Accounts**: 活跃账户卡片 (含 Token 过期倒计时/组织信息) + 全量账户表 + 敏感字段访问态脱敏 (access_token/refresh_token 不经过 IPC)
- **Session Share**: 详情面板条件渲染分享信息 + 密钥默认遮罩 + 可复制分享链接
- **跨平台构建**: macOS Universal (arm64+x64) / Windows NSIS (x64+arm64) / Linux AppImage+deb (x64)；CI 四平台矩阵验证
- **Session 增强**: 日期范围筛选、pageSize 上限 200
- **Events IPC**: 事件序列查询通道 (无 UI，预留给后续版本)

### Fixed

- 页面加载时 UI 冻结 → 快/慢数据并行加载 (Promise.all)
- Dashboard 时间范围切换页面后重置 → 缓存 timePreset
- Sidebar Tooltip 被主内容区 overflow 裁剪 → 方向改为下方展开 + z-index 提升
- Todos 项目筛选返回空结果 → SQL 改用 directory 字段匹配
- 缓存命中率公式修正 → 分母改为 totalTokens (input+output+reasoning)，语义更正为"缓存复用率"
- 健康状态统计卡片文本溢出 → 紧凑双行格式 (页数/碎片分列)
- 估算成本 RMB 汇率偏差 → 恢复 USD 格式 ($X.XX)
- Dashboard 趋势查询 N+1 → GROUP BY 优化
- Docker API 调用 → 平台守卫 (Windows/Linux 兼容)

### Changed

- Dashboard 布局重构为 6 行分区方案 (标题栏→概览卡片→时间选择→时段统计→趋势并排→分布并排)
- Sessions/Messages 虚拟渲染 (CSS content-visibility)
- Messages 内容预览截断至 300 字符
- StatCard 组件支持 children 插槽 (附加内容行)

## [1.0.0] - 2026-05-22

### Added

- **Dashboard**: 数据库概览仪表盘，展示会话数、项目数、Token 统计、工具使用排行、Skill 使用统计和趋势图
- **Sessions**: 会话浏览与管理，支持搜索、项目筛选、排序、分页，以及会话详情面板（Token 明细饼图、Tool 使用排行柱状图、Skill 列表）
- **Messages**: 消息查看器，支持按会话浏览消息列表、查看消息详情（Markdown 渲染、代码高亮）、Part 类型筛选（text/tool/reasoning）、工具调用展开查看
- **Cleanup**: 清理向导，支持按时间/大小/项目/自定义策略筛选会话，预览清理范围，倒计时确认执行，VACUUM 回收空间
- **Backup**: 备份与恢复，支持一键创建数据库备份、浏览备份列表、预览备份内容、恢复数据库

### Technical

- 基于 Electron 30 + React 18 + TypeScript 5.2 构建
- 使用 better-sqlite3 直接访问 SQLite 数据库
- contextIsolation 安全架构，所有数据库操作通过 IPC 通道完成
- 统一的 IPC 错误处理格式 `{ success: boolean; data?: T; error?: string }`
