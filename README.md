# DBScope-OC

> OpenCode 数据库可视化管理工具 - 轻松管理你的 OpenCode 会话数据

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Electron](https://img.shields.io/badge/Electron-42.4.0-blue.svg)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-18.2.0-61dafb.svg)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.2.2-blue.svg)](https://www.typescriptlang.org/)
[![OpenCode](https://img.shields.io/badge/OpenCode-%E2%86%92-blueviolet.svg)](https://github.com/anomalyco/opencode)

## 📖 简介

DBScope-OC 是一款跨平台桌面应用，用于可视化管理 OpenCode 的 SQLite 数据库。支持数据库概览仪表盘、会话与消息浏览、安全清理、备份恢复，覆盖 OpenCode 全部核心数据表。

> 基于 [OpenCode](https://github.com/anomalyco/opencode) 构建
> 
> **支持的 OpenCode 版本**：需 OpenCode v1.x 及以上（`session` 表需包含 `parent_id` 列以支持会话层级功能）。旧版本数据库仍可打开，部分功能不可用。

## ✨ 功能特性

![Dashboard](docs/images/dashboard.png)

- 📊 **首页仪表盘** - 时间范围选择 (7/30/90/全部)、6 行分区布局、时段对比、Token/工具/技能分析、增长趋势、并行加载
- 💬 **会话浏览** - 搜索、日期筛选、项目筛选、排序、分页、详情面板 (Token/Tool/Skill/Todos/Share)
- 📝 **消息查看器** - Markdown 渲染、代码语法高亮、全文搜索、跨 Session 搜索、Part 明细、Tool 展开
- 🔗 **分享管理** - 会话分享记录浏览、复制链接、在浏览器打开
- 🧹 **清理向导** - 4 种策略、预览确认、3 秒倒计时安全机制
- 💾 **备份恢复** - 一键备份、版本管理、灾难恢复

## 🚀 快速开始

### 系统要求

- macOS 12.0+, Windows 10+, Linux (x64)
- Node.js 18.0 或更高版本

### 安装

```bash
# 1. 克隆仓库
git clone https://github.com/JieYueGo/DBScope-OC.git
cd DBScope-OC

# 2. 安装依赖
npm install

# 3. 重新编译原生模块（重要！否则无法运行）
npm run rebuild-native

# 4. 生成测试数据（可选）
npm run generate-fixture

# 5. 启动开发模式
npm run dev

# 6. 打包应用
npm run build
```

## 🛠️ 技术栈

- **桌面框架**: Electron
- **前端**: React 18 + TypeScript
- **数据库**: better-sqlite3
- **样式**: Tailwind CSS
- **图表**: Recharts
- **构建工具**: Vite + electron-builder
- **跨平台**: macOS Universal (arm64+x64) / Windows NSIS (x64+arm64) / Linux AppImage+deb (x64)

## 📁 项目结构

```
DBScope-OC/
├── electron/           # 主进程代码
│   ├── main.ts        # 主进程入口
│   ├── database.ts    # DatabaseManager 单例
│   ├── preload.ts     # contextBridge API
│   └── ipc/           # IPC 处理器
│       ├── analytics.ts   # Dashboard 数据聚合
│       ├── sessions.ts    # 会话 CRUD
│       ├── messages.ts    # 消息查询 + 全文搜索
│       ├── todos.ts       # 会话详情内嵌待办 Tab
│       ├── cleanup.ts     # 清理操作
│       └── backup.ts      # 备份恢复
├── src/               # 渲染进程代码
│   ├── features/      # 功能模块
│   │   ├── dashboard/     # 首页仪表盘
│   │   ├── sessions/      # 会话浏览
│   │   ├── messages/      # 消息查看
│   │   ├── cleanup/       # 清理向导
│   │   └── backup/        # 备份恢复
│   ├── components/    # 共享 UI 组件
│   └── lib/           # 工具函数
├── shared/            # 共享类型和常量
├── docs/              # 设计文档和用户手册
└── test-data/         # 测试数据
```

## 📚 文档

详细文档请参阅 [docs/](docs) 目录：

- [架构设计](docs/01-架构设计.md)
- [数据访问层](docs/02-数据访问层.md)
- [技术栈](docs/03-技术栈.md)
- [功能模块](docs/04-功能模块)
- [使用手册](docs/05-使用手册.md)

## 💡 常见问题

### Q: 升级 Electron 后遇到 "NODE_MODULE_VERSION mismatch" 错误怎么办？

A: 自 v1.2.0 起已切换到 Node 内置 `node:sqlite`，**不再有原生模块**，此问题不再出现。

### Q: 清理后空间未释放怎么办？

A: 运行 VACUUM 或重启应用。

### Q: 备份文件存储在哪里？

A: 默认存储在 `~/opencode-backups/` 目录。

## 🔧 数据库驱动

主进程使用 Node 24 内置 `node:sqlite`（`DatabaseSync`），不再使用 `better-sqlite3` 等 C++ 原生模块。

- 零外部依赖、零 ABI 风险、同步 API
- API 形态与 better-sqlite3 几乎一致，IPC handler 无需改为 async
- 升级 Electron 不再需要重新编译原生模块

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可证

本项目采用 MIT 许可证 - 详见 [LICENSE](LICENSE) 文件。

## 👥 作者

- **Webb Lee** - [Webb Lee](https://github.com/webbLee94)

---

Made with ❤️ by [Webb Lee](https://github.com/webbLee94)
