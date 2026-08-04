# ADR: v1.3.3 缓存命中率公式 + DataSource Context

## 决策 1：缓存命中率公式

### 背景

原"缓存复用率"公式：`cacheRead / (input + output + reasoning) * 100`，值可超过 100%，概念难以理解。

### 决策

改为"缓存命中率"，公式：`cacheRead / (cacheRead + input) * 100`。

### 理由

- `cacheRead + input` = 总尝试次数（命中 + 未命中），命中率恒 ≤ 100%
- `output` 和 `reasoning` 是模型生成量，与缓存无关
- `cacheWrite` 是缓存投资（首次写入为了后续命中），不是一次"尝试"

## 决策 2：DataSource 全局状态

### 背景

Sidebar、DataSourceSection 各自独立 fetch `database:health`，时序不同步导致闪烁。

### 决策

新建 `DataSourceContext`（React Context），App 顶层 Provider 挂载，只管理 `connected` + `dbPath`。

### 理由

- 与现有 `UpdateContext` 模式一致，零新依赖
- Context 状态变更自动触发所有消费者重渲染，无需手动广播
- 不含 `dbHealth`——Dashboard 自身的 cache 机制已管理该状态
