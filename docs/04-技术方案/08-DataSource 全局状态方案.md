# DataSource 全局状态方案

## 背景

v1.3.2 之前，数据源连接状态在 Sidebar、DataSourceSection 各自独立调用 `database:health`，导致首次进入设置页时出现"未连接 → 已连接"闪烁和窗口抖动。

v1.3.2 在 DataSourceSection 加了模块级 `dsCache` 缓存，但 Sidebar 不共享它。

## 方案

采用 React Context（与现有 `UpdateContext` 模式一致），新建 `DataSourceContext` + `DataSourceProvider`，在 App 顶层挂载。

### Context 管理

- `connected: boolean` — 数据库是否已连接
- `dbPath: string` — 当前数据库文件路径

### Provider 逻辑

- 首次挂载时调用 `database:health` 获取状态
- `window focus` 事件时刷新
- `database:open` 成功后 `window.location.reload()` 保留不变（reload 后 Provider 重新挂载）

### 不在范围内

- Dashboard 的 `dbHealth`（pageCount / freelistPages / walSize）由 Dashboard 自己的 cache 机制管理，不纳入 Context
