# 0004-品牌重命名为 OpenCode-W

- **状态**：已接受
- **日期**：2026-06-15
- **决策者**：Webb + 架构师 Agent

## 背景

OpenCode-W 的前身为 **DBScope-OC**，1.0.0（2026-05-22）发布时即采用此命名。从 1.0.0 → 1.2.0 期间，团队收集到 40+ 条用户与社区反馈，核心痛点集中于三方面：（1）**名称定位模糊**——「DBScope-OC」字面难以读出产品形态，OC 后缀含义不清，OpenCode 社区用户难以快速识别这是 OpenCode 生态工具；（2）**价值主张不显性**——产品实际定位是「AI 编程工程工坊」，但 DBScope 这一数据库查看器命名让用户误以为只是「又一个 SQLite 浏览器」；（3）**叙事空间受限**——`DBScope` 强调「查看」，无法承载后续要展开的「工坊式整理 / 工艺记录 / 归档」等叙事。同时项目作者 Webb 希望在命名中保留个人印记（Webb 的首字母 W）以强化长期投入的承诺。基于 1.2.0 大版本（2026-06-15）需要承载品牌升级窗口，决定同步完成更名、Logo 重塑、定位重写。

## 决策

将项目从 `DBScope-OC` 正式更名为 **`OpenCode-W`**：

- **W 双关**：「W」= **Workshop 工坊**（强调 AI 编程工程工坊的产品定位）= **Webb**（项目作者首字母印记，强化长期投入承诺）。
- **全新条柱 W Logo**：蓝紫渐变（#3B82F6 → #8B5CF6），条柱意象呼应「工坊」与「工程」的力学感；输出资产包括 SVG 源文件、PNG 12 尺寸（16/24/32/48/64/128/256/512/1024/2048/favicon 等）、macOS `.icns`、Windows `.ico`，全规格覆盖三平台打包需求。
- **定位升级**：「AI 编程工程工坊」——对 OpenCode 产生的会话、消息、Part、待办、分享等数据资产进行浏览、整理、迁移、归档的工作台。
- **页面标题工坊隐喻**：各功能页标题统一为工坊叙事——工坊总览（Dashboard）、素材库（Messages）、工艺记录（Session Detail）、整理车间（Cleanup）、归档室（Backup），信息层级与品牌叙事一致。
- **全量同步**：README、AGENTS.md、CONTRIBUTING.md、SECURITY.md、CODE_OF_CONDUCT.md、`docs/` 全量更新到新版品牌与命名；Issue 模板、PR 模板、CI 配置、`package.json` name/description、产品名称、窗口标题、菜单项、关于页等所有用户可见位置同步更新。

## 备选方案

- **保留 DBScope-OC**：最低成本，但定位模糊的核心问题未解决；新用户认知成本持续偏高，与 OpenCode 生态的关联感弱。
- **OpenCode-Studio / OpenCode-Lab / OpenCode-Hub 等命名**：与 OpenCode 主项目对齐度足够，但缺少「工坊」隐喻与作者印记，无法承载工程化叙事与个人承诺的传达。
- **OpenCode-Workshop（完整英文）**：语义最直白，但路径名 / 标识符 / 包名会变得冗长（`opencode-workshop`），且 `Workshop` 难以缩为有视觉冲击力的 Logo 字符。
- **OpenCode-W**（采纳）：6 个字符（含连字符）简洁可记；W 既可作为 Logo 主形，也可双关工坊 + Webb；为后续工程化指标（如 WebDashboard / Workflow / Wireframe 等 W 开头产品线）预留叙事空间。

## 理由

选择 `OpenCode-W` 基于以下四方面考量：

1. **工坊隐喻契合产品定位**：「工坊」= 物理空间 + 工匠态度 + 工艺记录，与产品的「AI 编程工程工坊」定位高度一致；隐喻延伸到页面标题（工坊总览 / 素材库 / 工艺记录 / 整理车间 / 归档室），让信息架构与品牌叙事同构。
2. **W 双关强化长期承诺**：W = Webb，让项目命名中保留作者印记，传达「这是个人长期投入的项目」信号，对开源协作、用户信任、社区贡献意愿都有正向影响。
3. **OpenCode 生态关联**：`OpenCode-` 前缀让 OpenCode 社区用户一眼识别这是 OpenCode 生态工具，避免被误认为是通用 SQLite 浏览器；同时维持 `OpenCode-` 前缀也为未来 OpenCode 生态内的多产品线（如 `OpenCode-CLI`、`OpenCode-Web`）预留命名空间。
4. **视觉与 Logo 设计可行性**：W 是西方字母中适合条柱意象的字符之一，可设计出具有工程力学感的条柱 W Logo（蓝紫渐变呼应 AI 与创造的科技感），且 W 字符在 16×16 favicon 尺寸下仍清晰可辨，覆盖三平台打包需求。

我们接受「品牌升级带来一次性同步成本」这一代价——文档、配置、Issue 模板、Logo 资产、窗口标题、菜单项等所有用户可见位置的全量同步，估算约 1-2 人日工作量，是合理代价。

## 影响

- **代码层面**：`package.json` 的 `name` / `description` 字段、构建配置（`productName`、`appId`）、窗口标题、菜单项、关于页文案、Issue 模板、PR 模板、CI 配置（`BUILD_APP_NAME` 等环境变量）统一更新为 OpenCode-W；移除 `DBScope-OC` 字样的所有用户可见字符串。
- **用户层面**：1.2.x 升级后应用名、窗口标题、侧栏 Logo、Dashboard 标题、文档站全部以新品牌呈现；老用户会经历「品牌焕新」第一印象，新用户从 OpenCode 生态跳转时识别成本大幅降低；Logo 全规格（SVG / 12 尺寸 PNG / icns / ico）一次性重生成，跨平台图标体验统一。
- **运维层面**：README、AGENTS.md、CONTRIBUTING.md、SECURITY.md、CODE_OF_CONDUCT.md、`docs/` 全量同步更新到新版品牌与命名；GitHub 仓库描述、About 区、Topics、社交媒体账号同步更新；历史 CHANGELOG 保留旧品牌字样以确保变更可追溯。
- **后续约束**：所有新增文案、设计资产、Issue 模板必须以 OpenCode-W 为准；新功能命名（如新增 W 开头产品线 / 工作流 / 模块）需先在本文档中预留叙事空间，避免后续命名冲突；Git 标签、Release Notes 必须以新品牌发出，老品牌（DBScope-OC）不再用于新版本。
