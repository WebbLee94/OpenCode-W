# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2025-05-22

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
