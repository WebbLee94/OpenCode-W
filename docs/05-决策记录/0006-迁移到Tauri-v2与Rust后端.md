# 0006-迁移到 Tauri v2 与 Rust 后端

- **状态**：已接受
- **日期**：2026-07-07
- **决策者**：Webb + 架构师 Agent

## 背景

OpenCode-W v1.x 基于 Electron 42 + React 18 + TypeScript，制品包约 100MB。随着项目成熟，包体积大、内存占用高的问题日益影响用户体验。[可行性分析](../00-调研分析/06-Tauri-v2迁移可行性分析.md)表明，迁移到 Tauri v2（Rust 后端 + 系统 WebView）可将包体积降至 3-15MB、内存降低 30-60%、启动时间缩短 2-5x，同时保留全部现有功能。

ADR-0001 曾因"团队 Rust 熟悉度有限"拒绝 Tauri。现团队已熟练掌握 Rust，该约束不再成立。

## 决策

将 OpenCode-W 从 Electron 42 + TypeScript 后端迁移到 **Tauri v2 + Rust 后端**：

- **桌面框架**：Tauri v2（替代 Electron 42）
- **后端语言**：Rust（替代 TypeScript/Node.js）
- **SQLite 驱动**：rusqlite（替代 node:sqlite）
- **IPC 机制**：Tauri commands `invoke()`（替代 contextBridge + ipcMain.handle）
- **自动更新**：tauri-plugin-updater（替代 electron-updater）
- **前端**：React 18 + Vite + Tailwind 4（保留不变）
- **迁移方式**：一次性切换（非渐进式）
- **parsePartData 策略**：Rust + serde_json 重写（策略 A）

## 备选方案

- **保持 Electron**：包体积大的问题无法解决，且 ADR-0001 已记录"后续改用其他框架迁移成本极高，应慎重评估"——越晚迁移成本越高。
- **渐进式迁移（双架构过渡）**：维护两套代码增加复杂度，用户选择一次性切换。
- **嵌入 Axum HTTP server**：单用户本地桌面应用无需 HTTP 层，过度设计。
- **tauri-plugin-sql**：面向 migrations，不支持任意 SQL 查询，不满足需求。

## 理由

1. **包体积**（用户最高优先级）：100MB → 3-15MB，10x 缩小
2. **性能**（用户第二优先级）：启动快 2-5x，内存低 30-60%
3. **安全性**（用户第三优先级）：Tauri ACL 权限系统比 Electron 通道白名单更细粒度
4. **功能保留**：35 个 IPC 通道全部可迁移，无功能丢失
5. **团队 Rust 熟练**：ADR-0001 的原始拒绝理由已消除
6. **rusqlite 完全对应 node:sqlite**：WAL/PRAGMA/json_extract/事务/readOnly 全部支持
7. **渲染层几乎不变**：React 代码保留，仅 IPC 调用入口需改

## 影响

- **代码层面**：
  - `electron/` 目录整体替换为 `src-tauri/`（Rust）
  - `src/lib/ipc.ts` 改写为 Tauri invoke 封装
  - `shared/types.ts` → Rust serde 结构体
  - `shared/ipc-channels.ts` → Tauri command 名称
  - `electron-builder.yml` → `tauri.conf.json`
  - `vite.config.ts` 移除 vite-plugin-electron

- **用户层面**：下载包从 ~100MB 降至 ~10MB，启动更快，内存占用更低

- **运维层面**：
  - CI 从 npm + electron-builder 改为 cargo + tauri build
  - 使用 tauri-apps/tauri-action GitHub Action
  - 三平台需回归测试（系统 WebView 差异）

- **后续约束**：
  - 废止 ADR-0001 中"明确不引入 Tauri"的决定
  - 废止 ADR-0002（node:sqlite → rusqlite）
  - 废止 ADR-0005（electron-updater → tauri-plugin-updater）
  - 新增 ADR 记录 rusqlite、tauri-plugin-updater 选型

## 关联

- [可行性分析](../00-调研分析/06-Tauri-v2迁移可行性分析.md)
- [Tauri v2 目标架构](../02-架构设计/04-Tauri-v2目标架构.md)
- [Tauri v2 迁移方案](../04-技术方案/07-Tauri-v2迁移方案.md)
- 取代 [0001-选用Electron与React技术栈](0001-选用Electron与React技术栈.md)
