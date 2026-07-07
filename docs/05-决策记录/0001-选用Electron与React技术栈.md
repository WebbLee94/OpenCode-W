# 0001-选用 Electron 与 React 技术栈

- **状态**：已接受
- **日期**：2026-05
- **决策者**：Webb + 架构师 Agent

## 背景

OpenCode-W 立项于 2026 年 5 月，定位是「AI 编程工程工坊」桌面应用，核心需求是让用户能够直接打开本地 SQLite 数据库，对 OpenCode 产生的会话、消息、Part、待办等数据资产进行可视化浏览、检索、清理和备份。在选型阶段，我们评估了若干约束：必须能直连本地 SQLite（无中间服务）、必须跨 macOS / Windows / Linux 三平台、必须具备成熟生态以支撑后续 Dashboard / Sessions / Messages / Cleanup / Backup 等多个功能模块的快速迭代。同时，项目作者 Webb 希望前端技术栈与 OpenCode 主项目保持一致，以便在工程化、类型安全、组件复用上复用经验。

## 决策

桌面框架选用 **Electron 42**（主进程 + 预加载 + 渲染进程三层架构），前端框架选用 **React 18**，语言统一为 **TypeScript 5**，构建链使用 Vite + vite-plugin-electron，打包分发使用 electron-builder，覆盖 macOS / Windows / Linux 三平台。配套技术栈包括 Tailwind CSS 4、Recharts、Zustand、React Router 7、Lucide React、react-markdown 等，均为 React 生态中轻量且与本项目需求匹配度最高的方案。

## 备选方案

- **Tauri**：基于 Rust + 系统 WebView，安装包体积小（约 10MB）、启动更快，但 Rust 生态对 sqlite 集成需要额外胶水代码（rusqlite、tauri-plugin-sql 等），且团队对 Rust 工具链熟悉度有限，会显著拖慢首版交付。
- **原生桌面应用（Swift + WinUI + GTK）**：性能最佳、可深度调用系统能力，但三平台需要三套代码与三组维护者，开发成本不可接受，且难以复用 OpenCode 前端已有的 React 组件经验。
- **纯 Web 应用**：部署简单、跨平台零成本，但浏览器无法直连本地 SQLite 文件，必须引入本地代理或上传文件，违背「直连本地数据库」的核心价值主张。
- **Electron + Vue / Svelte 组合**：生态同样成熟，但与 OpenCode 主项目的 React 技术栈不一致，会增加组件库、Hook 复用与新人上手成本。

## 理由

选择 Electron + React + TypeScript 组合是基于四方面权衡的结果：

1. **生态成熟度**：Electron 是当前桌面应用领域社区最大、文档最完备的方案，Vite、vite-plugin-electron、electron-builder 等工具链稳定可靠，React 在 UI 组件、状态管理、路由、图表、Markdown 渲染等所有本项目需要的子领域都有事实标准方案。
2. **直连 SQLite 能力**：Electron 主进程运行完整的 Node.js，可以直接通过 `node:sqlite` 同步访问本地数据库文件，配合 `contextIsolation: true` 的安全架构，无需引入任何中间服务即可满足「直连本地 SQLite」的核心需求。
3. **与 OpenCode 技术栈对齐**：OpenCode 主项目使用 React + TypeScript，OpenCode-W 复用相同技术栈可以让代码片段、组件、Hook、类型定义在两个项目间无缝迁移，也方便熟悉 OpenCode 的贡献者快速上手本项目。
4. **跨平台打包与分发**：electron-builder 支持 macOS Universal（arm64+x64）、Windows NSIS、Linux AppImage/deb，CI 四平台矩阵验证相对成熟，可以满足「一次开发、多端分发」的目标。

包体积较大（约 100MB）这一已知代价，与 Tauri 的轻量相比处于劣势，但相对于需要三套原生代码或引入中间代理的方案，仍然是综合最优解。

## 影响

- **代码层面**：项目采用主进程 / 预加载 / 渲染进程三层架构，所有 SQL 调用通过主进程 `DatabaseManager` 单例，渲染进程仅通过 `window.electronAPI.invoke(channel, ...args)` 异步通信；`contextIsolation: true` + `nodeIntegration: false` + `webSecurity: true` 的安全配置需要持续维护，webPreferences 任何变更都必须经过安全审查。
- **用户层面**：用户需要下载约 100MB 的安装包（macOS / Windows / Linux 各自平台），首次启动需要 1-2 秒的窗口创建时间；与之换来的是完整的 React 生态、流畅的 UI 交互、可靠的本地数据库访问。
- **运维层面**：CI 必须在 macOS / Windows / Linux 三个平台分别构建，Electron 主版本升级（当前为 42.4.0）会带来 Chromium / V8 / Node 内嵌版本联动变化，需要在每次大版本升级时回归测试 sqlite 兼容性、安全配置、IPC 行为；后续若改用其他框架，迁移成本极高，应慎重评估。
- **后续约束**：明确不引入 ORM（Drizzle/Prisma）、Redux、ECharts、shadcn/ui、Next.js 等方案，理由已记录在 `docs/02-架构设计/03-技术栈选型.md` 中，新增依赖前必须先在该文件中查重并补充理由。
