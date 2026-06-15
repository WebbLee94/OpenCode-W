# 安全策略

## 漏洞报告

如果你发现 OpenCode-W 存在安全漏洞，请**不要**通过公开的 GitHub Issue 报告。

### 报告方式

请通过 [GitHub Security Advisory](https://github.com/WebbLee94/OpenCode-W/security/advisories/new) 私下报告安全漏洞。

### 报告内容

请在报告中包含以下信息：

- 漏洞类型（如 XSS、SQL 注入、路径遍历等）
- 受影响的版本
- 复现步骤
- 潜在影响
- 可能的修复建议（如有）

### 响应时间

- **确认收到**: 24 小时内
- **初步评估**: 3 个工作日内
- **修复发布**: 根据严重程度，通常在 7-14 个工作日内

## 支持的版本

| 版本 | 支持状态 |
| --- | --- |
| 1.x.x | ✅ 支持 |

## 安全最佳实践

OpenCode-W 遵循以下安全原则：

- `contextIsolation: true` + `nodeIntegration: false` 隔离渲染进程
- 所有 SQL 查询使用参数化查询，防止 SQL 注入
- 自定义 WHERE 子句经过严格校验
- 破坏性操作（删除、清理）必须经过「预览 → 确认」两步流程
- 备份文件路径校验，防止路径遍历攻击
