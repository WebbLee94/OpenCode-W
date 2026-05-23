# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
