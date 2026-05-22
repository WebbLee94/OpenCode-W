# 贡献指南

感谢你对 DBScope-OC 项目的关注！本文档将帮助你了解如何参与项目贡献。

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

# 重新编译原生模块（必须！）
npm run rebuild-native

# 启动开发模式
npm run dev

# 类型检查
npx tsc --noEmit

# 生成测试数据库
npm run generate-fixture
```

## PR 模板

提交 PR 时请参考 [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md)。

## 禁止事项

- 不引入 ORM（Drizzle/Prisma）
- 不引入 Redux
- 不引入 ECharts
- 不在渲染进程直接访问 better-sqlite3
- 不将 preload 输出为 `.mjs` 文件
