# 贡献指南

感谢你对 OpenCode-W 项目的关注！本文档将帮助你了解如何参与项目贡献。

## 提交流程

1. **Fork** 本仓库到你的 GitHub 账户
2. 从 `master` 创建功能分支：`git checkout -b feat/your-feature`
3. 进行开发并提交代码
4. 推送到你的 Fork：`git push origin feat/your-feature`
5. 创建 **Pull Request** 到本仓库的 `master` 分支

## 提交规范

使用 [Conventional Commits](https://www.conventionalcommits.org/) 格式，提交信息以中文撰写：

```
feat: 新功能描述
fix: 修复描述
refactor: 重构描述
test: 测试相关描述
docs: 文档更新描述
chore: 构建/工具链调整描述
perf: 性能优化描述
```

**要求**：
- 提交信息必须以动词开头
- 提交信息使用中文
- 提交信息为单行
- 聚焦于"为什么"而非"做了什么"

## 代码风格

- **TypeScript**: 严格模式，启用所有严格检查
- **React**: 函数组件 + Hooks，不使用类组件
- **样式**: Tailwind CSS，不使用内联样式或 CSS Modules
- **命名**: 变量和函数使用 camelCase，组件使用 PascalCase，常量使用 UPPER_SNAKE_CASE
- **导入**: 使用绝对路径或相对路径，按第三方库 → 共享模块 → 本地模块排序

## 开发环境

```bash
# 安装依赖
npm install

# 启动 Tauri 开发模式
npm run tauri:dev

# 仅启动 Vite 前端开发服务器（不启动 Rust 后端）
npm run dev

# 类型检查
npx tsc --noEmit

# 代码风格
npm run lint

# 生成测试数据库
npm run generate-fixture

# 运行测试
npm test
```

> 💡 自 v1.3.0 起已从 Electron 42 迁移到 Tauri v2。前端 `npm run dev` 仅启动 Vite 开发服务器；如需完整桌面应用预览请用 `npm run tauri:dev`（自动编译 Rust 后端并拉起窗口）。

## PR 流程与模板

提交 PR 时请遵循以下步骤：

1. **PR 标题**：与首个 commit 的提交信息一致（中文、动词开头、单行）
   - 好的标题：`fix(share): 修复分页大小变更不生效问题`
   - 不好的标题：`update code` / `fix bug`
2. **关联 Issue**：使用关键字 `Closes #123` / `Fixes #456` 关联对应 Issue
3. **描述结构**（详见 [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md)）：
   - **背景**：为什么要改
   - **变更要点**：改了什么（高层面，不重复 commit 信息）
   - **验证**：如何测试（截图、复现步骤、自动化测试）
   - **风险**：可能的回归点
4. **自检清单**：
   - [ ] `npx tsc --noEmit` 通过
   - [ ] `npm run lint` 无错
   - [ ] `npm test` 通过（如新增/修改了测试）
   - [ ] 文档同步更新（README、CHANGELOG、设计文档）
   - [ ] 与 [AGENTS.md](AGENTS.md) 中"禁止事项"无冲突
5. **Review 要求**：至少 1 名维护者 Approve + CI 4 平台构建通过
6. **合并策略**：Squash and Merge（保持 master 线性历史）

## 禁止事项

- 不引入 ORM（Drizzle/Prisma）
- 不引入 Redux
- 不引入 ECharts
- 不在渲染进程直接访问 node:sqlite

## 关于 `node-gyp` 依赖

`package-lock.json` 中的 `node-gyp` 是旧版 Electron 构建链的遗留物：

- 它是 `electron-builder` 及其子依赖的传递依赖
- 自 v1.3.0 起已迁移到 Tauri v2，**不再依赖 Electron 及 C++ 原生模块**
- 项目 Rust 后端通过 `rusqlite`（bundled 特性）编译 SQLite C 库，无需系统级构建工具
- CI 流水线不再涉及任何 `npm rebuild` 步骤

`node-gyp` 在 lock 中的残留不影响构建产物大小，移除 `electron-builder` 后可在下次 `npm install` 时自动清理。
