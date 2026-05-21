# AGENTS.md - OpenCode DB Manager 项目指南

## 项目概述
OpenCode DB Manager 是一款 Electron 桌面应用，用于可视化管理 OpenCode 的 SQLite 数据库。

## 技术架构
- **主进程** (`electron/`): Node.js + better-sqlite3 + TypeScript，负责数据库操作和 IPC
- **渲染进程** (`src/`): React 19 + TypeScript，负责 UI 展示
- **预加载** (`electron/preload.ts`): contextBridge 安全 API，输出为 `.cjs` 文件
- **共享层** (`shared/`): DTO 类型定义和 IPC 通道常量

## 目录结构
```
opencode-db-manager/
├── electron/
│   ├── main.ts            # 主进程入口
│   ├── database.ts        # DatabaseManager 单例
│   ├── preload.ts         # contextBridge API (输出为 preload.cjs)
│   └── ipc/               # IPC 处理器
│       ├── analytics.ts   # Dashboard 数据聚合
│       ├── sessions.ts    # 会话 CRUD
│       ├── messages.ts    # 消息查询
│       ├── cleanup.ts     # 清理操作
│       └── backup.ts      # 备份恢复
├── src/
│   ├── main.tsx           # React 入口
│   ├── App.tsx            # 路由 + 侧边栏布局
│   ├── features/          # 功能模块
│   │   ├── dashboard/     # 首页仪表盘
│   │   ├── sessions/      # 会话浏览
│   │   ├── messages/      # 消息查看
│   │   ├── cleanup/       # 清理向导
│   │   └── backup/        # 备份恢复
│   ├── components/        # 共享 UI 组件
│   ├── lib/               # 工具函数
│   │   ├── ipc.ts         # 安全 IPC 封装
│   │   └── format.ts      # 格式化工具
│   └── types/
│       └── electron.d.ts  # window.electronAPI 类型声明
├── shared/
│   ├── types.ts           # 所有 DTO 类型定义
│   └── ipc-channels.ts   # IPC 通道名称常量
├── docs/                  # 设计文档
└── test-data/             # 测试数据和夹具生成
```

## 关键约定

1. **安全架构**: `contextIsolation: true` + `nodeIntegration: false` + `sandbox: false`
2. **数据访问**: 所有 SQL 查询通过 DatabaseManager，使用参数化查询
3. **IPC 通信**: 渲染进程通过 `window.electronAPI.invoke(channel, ...args)` 调用
4. **Preload 文件**: 必须为 `.cjs` 扩展名（因为 `package.json` 中有 `"type": "module"`）
5. **破坏性操作**: 必须经过「预览 → 确认」两步流程
6. **分页**: 所有列表查询默认 50 条/页

## 数据库 Schema 关键点

**重要**: `message` 和 `part` 表的 `role`/`type` 字段存储在 `data` JSON 中，不是独立列：

```sql
-- message 表没有 role 列！role 在 data JSON 中
SELECT json_extract(data, '$.role') as role FROM message

-- part 表没有 type 列！type 在 data JSON 中
SELECT json_extract(data, '$.type') as type FROM part
```

## 开发命令

| 命令 | 说明 |
|------|------|
| `npm install` | 安装依赖 |
| `npm run rebuild-native` | 针对 Electron 重新编译 better-sqlite3（必须！） |
| `npm run generate-fixture` | 生成测试数据库 |
| `npm run dev` | 启动开发模式 |
| `npm run build` | 打包应用 |
| `npx tsc --noEmit` | 类型检查 |

## 禁止事项

- ❌ 不引入 ORM (Drizzle/Prisma)
- ❌ 不引入 Redux
- ❌ 不引入 ECharts
- ❌ 不在渲染进程直接访问 better-sqlite3
- ❌ 不将 preload 输出为 `.mjs` 文件（Electron 不支持 ESM preload）
- ❌ 不启用 `renderer: {}` 配置（会干扰 contextBridge）

## 原生模块说明

better-sqlite3 是 C++ 原生模块，编译时绑定了 Node.js ABI 版本。Electron 使用不同版本的 Node.js (NODE_MODULE_VERSION 不同)，所以必须重新编译。

```bash
npm run rebuild-native
# 等价于:
npx node-gyp rebuild \
  --directory=node_modules/better-sqlite3 \
  --target=$(npx electron --version) \
  --arch=$(node -p 'process.arch') \
  --dist-url=https://electronjs.org/headers
```
