# 0005-引入 electron-updater

- **状态**：已接受
- **日期**：2026-07-07
- **决策者**：Webb + 架构师 Agent

## 背景

OpenCode-W 自 1.0.0（2026-05-22）发布以来，三个迭代版本（1.0.0 → 1.1.0 → 1.2.0）的升级路径**完全依赖用户主动到 GitHub Releases 页面下载安装包手动升级**。这种"零基础设施"的发布方式在产品早期是合理的——用户量小、迭代快、用户对 OpenCode 生态熟悉度高——但随着 1.2.0 品牌升级、定位升级为「AI 编程工程工坊」后，我们观察到三个具体痛点：

1. **用户感知延迟**：用户只有主动打开 GitHub 才知道有新版，更不会有"需要升级"的意识。从 1.1.0 → 1.2.0 的升级漏斗数据估算（基于 GitHub Releases 下载数 vs 安装活跃用户数），大约 40% 的用户在 1.2.0 发布 30 天后仍停留在 1.1.0，意味着大量用户错过品牌升级、新会话迁移能力、Dashboard 优化等关键改进。
2. **跨平台升级步骤各异**：macOS 用户需要下载 .dmg → 拖入 Applications；Windows 用户需要下载 .exe → 接受 UAC → 通过 SmartScreen；Linux 用户需要选择 AppImage 或 .deb 并按发行版处理。每一步都可能是流失点，特别是 Windows SmartScreen 拦截对非技术用户极不友好。
3. **无应用内引导**：即使有新版，App 内没有任何提示，唯一的引导位是 GitHub Releases 页面，而该页面在 App 外部。

基于此，我们需要在 1.2.x 版本引入**应用内自动更新能力**。但与很多 Electron 应用直接做"完全静默后台下载+下次启动自动安装"不同，本期我们识别到三个**额外的关键约束**：

- **无代码签名**：本项目目前不持有 Apple Developer ID 与 Windows 代码签名证书，这意味着 macOS Gatekeeper 与 Windows SmartScreen 都会拦截未签名的安装包。如果走"静默后台下载 + 下次启动自动安装"路径，用户体验会从"找不到升级按钮"变成"重启后 App 消失了/打不开了"，反而是更糟的体验。
- **用户主动触发**的安全要求：在无代码签名场景下，macOS 必须用户主动在 Finder 右键"打开"、Windows 必须用户主动点"仍要运行"，这是系统级要求，应用层无法绕过。因此更新流程必须**显式包含用户确认动作**，不能纯后台。
- **复用现有 GitHub Releases 流程**：项目已有基于 `electron-builder` + GitHub Releases 的完整发布流水线（4 平台 CI 矩阵、自动生成 latest.yml、产物上传），任何新方案都不应引入独立的发布基础设施（自家服务器 / CDN 等），否则会显著增加运维负担。

## 决策

采用 **`electron-updater` 手动模式** 作为 OpenCode-W 的应用内自动更新方案。具体配置：

- **依赖**：在 `package.json` 中新增 `electron-updater`（electron-builder 官方维护，VS Code / Discord / GitHub Desktop / Notion / Figma Desktop 等数千万级用户应用在用）。
- **运行模式**：`autoUpdater.autoDownload = false` + `autoUpdater.autoInstallOnAppQuit = false`，**全流程不触发任何自动行为**。应用启动后 5s 单次静默调用 `checkForUpdates()`，发现新版本时通过 `webContents.send('update:event:available', info)` 推送到渲染层，渲染层在侧边栏「设置」入口显示红点；用户主动进入「设置 → 版本更新」查看详情，主动点"立即下载"才触发下载，主动点"立即安装"才退出 App 并启动系统安装器。
- **发布通道**：`electron-builder.yml` 新增 `publish: { provider: github, owner: WebbLee94, repo: OpenCode-W, releaseType: release }`，复用现有 GitHub Releases 产物。
- **状态机**：5 态有限状态机（`idle` / `available` / `downloading` / `downloaded` / `installing`），非法转换被拒绝，确保 UI 状态始终一致。
- **缓存**：`userData/update-cache.json` 记录 `lastCheckedAt` + `lastVersion`，便于 UI 展示"上次检查时间"和"最近一次发现的版本"。
- **错误分类**：`network` / `ratelimit` / `no-asset` / `download-failed` / `install-failed` / `unknown` 六类，每类对应不同的 Toast 提示与重试策略。

**首个启用版本**：v1.2.1（参见 [CHANGELOG](../../CHANGELOG.md)）。

## 备选方案

- **方案 A：自研 GitHub API + 原生下载**。直接调 `https://api.github.com/repos/WebbLee94/OpenCode-W/releases/latest` 拉取元数据，用 `node:https` 下载对应平台资产。优势：0 额外依赖；劣势：GitHub API 60 次/小时（未认证）/ 5000 次/小时（认证）的限流需要应对、`latest.yml` 解析与 SHA512 校验逻辑得自写、macOS .dmg / Windows NSIS / Linux AppImage / deb 的安装器接管逻辑各平台都要单独实现、增量更新（blockmap）完全无解。整体工作量是采用 `electron-updater` 的 5-8 倍，且长期维护成本远高于依赖一个成熟库。
- **方案 B：混合（Linux AppImage 走 electron-updater，macOS/Windows 自研）**。仅在 Linux 平台引入 `electron-updater`，macOS 与 Windows 保留自研方案。优势：依赖体积更小。劣势：长期维护两套代码路径，且 macOS/Windows 是 OpenCode-W 90% 用户的平台（基于 1.2.0 下载数据估算），把主力平台放到自研路径上风险与工作量都集中在用户最多的地方，与"减少风险"的目标背道而驰。
- **方案 C：等待拿到代码签名后做全静默更新**。等到有代码签名再做应用内更新，期间继续依赖用户手动升级。优势：跳过手动模式。劣势：代码签名时间表不可控（Apple Developer ID 申请周期 1-3 个月，Windows EV 代码签名证书申请周期更长），期间用户感知延迟与升级漏斗问题持续累积；且即便有代码签名，应用内引导位（侧边栏红点 + 设置页版本更新区）的能力也仍然需要，与本期工作的代码量重合度 70%+，延期收益远小于延期成本。
- **方案 D：应用商店分发（macOS App Store / Windows Store / Snap / Flatpak）**。优势：自动更新由商店机制原生承担。劣势：Apple 沙盒要求与本项目"直连本地 SQLite 文件"的核心能力冲突（沙盒要求文件访问走系统授权），Windows Store 类似的限制同样存在；商店审核周期长、版本回滚困难、收入分成（30%）；与本项目"开发者工具 + 个人/小团队使用"的目标用户群不匹配。不予考虑。
- **方案 E：electron-updater 自动模式**（`autoDownload: true` + `autoInstallOnAppQuit: true`）。最简实现，但**与无代码签名约束冲突**：在 macOS 上静默下载完成后，下次启动时安装器会被 Gatekeeper 拦截；Windows 上会被 SmartScreen 拦截；用户体验从"找不到升级"变成"App 打不开了"，是更糟的结果。明确放弃。

## 理由

选择 `electron-updater` 手动模式基于以下五点权衡：

1. **生态同源、零基础设施复用**：`electron-updater` 是 `electron-builder` 官方维护的姊妹库，本项目 `electron-builder.yml` 已配置 GitHub Releases 作为发布通道，`electron-updater` 读取同一份 `latest.yml` 元数据，发布流水线无需任何调整，运维负担增加量为 0。如果选自研方案（方案 A），则需要额外维护一份发布元数据格式与签名校验逻辑，长期看是技术债。
2. **跨平台心智模型一致**：`electron-updater` 在 macOS / Windows / Linux 三平台提供统一的 `checkForUpdates` / `downloadUpdate` / `quitAndInstall` API，本项目主进程 IPC 层只需封装 3 个 invoke 通道 + 4 个事件推送，渲染层 React Context 即可消费，无需任何平台特定代码。如果选混合方案（方案 B），主进程会同时存在两套更新逻辑，未来加新平台（如 ARM Linux）时复杂度指数增长。
3. **演进路径平滑、风险可控**：本期手动模式（`autoDownload: false` / `autoInstallOnAppQuit: false`）与未来的全静默模式（`autoDownload: true` / `autoInstallOnAppQuit: true`）之间的差异**仅 2 个配置项**，且状态机与 UI 层无需任何改动。这意味着拿到代码签名后，1 行配置即可平滑升级到全静默更新，所有本期投入的状态机、错误处理、缓存、UI 组件**完全复用**。这是「增量式无大爆炸演进」的具体体现。
4. **被数千万级用户应用验证**：`electron-updater` 是 VS Code、Discord、GitHub Desktop、Notion、Figma Desktop、1Password、Signal 等应用在用的更新方案，长期生产环境验证覆盖 macOS Squirrel 限制、Windows NSIS UAC、Linux AppImage/deb 各种 corner case。本项目无需重复踩坑。
5. **依赖体积与 ABI 风险可控**：`electron-updater` 是纯 JavaScript 实现（核心逻辑是下载 + 校验 + 启动安装器），不引入 C++ 原生模块，无 ABI 风险（与 0002 ADR 决策一致——所有原生模块都应迁移到 Node 内置或纯 JS 方案）。安装包体积增加约 200KB（gzip 后），相对于 100MB 级别的 Electron 应用可忽略。

我们接受以下三项代价：

- **失去"一键静默更新"的本期体验**：用户需要主动点"立即下载" + "立即安装"两次按钮。这在无代码签名场景下是合理代价，且手动模式本身就是为这种场景设计的。
- **额外的 UI 复杂度**：本期需要在侧边栏加红点、设置页加版本更新区、UpdateDialog 弹窗三处 UI 改动，工作量约 2-3 人日。
- **不实现「跳过此版本」「多通道」「下载取消」「自动重试」等高级能力**：按 YAGNI 原则本期不实现，待拿到代码签名进入全静默模式后再按需补齐。

## 影响

- **代码层面**：
  - 主进程新增 `electron/ipc/update.ts`（IPC handler + 事件推送 + 本地缓存读写）；
  - 共享层新增 `UpdateInfo` / `UpdateProgress` / `UpdateErrorPayload` DTO 与 7 个 IPC 通道常量；
  - 渲染进程新增 `src/features/update/` 目录（状态机、错误分类、Context、Dialog、Badge、Hook）与 `src/features/settings/` 目录（设置页 + 版本更新区）；
  - `src/components/Sidebar.tsx` 从 `App.tsx` 拆分，便于嵌入 `UpdateBadge` 红点；
  - `electron/main.ts` 在 `app.whenReady()` 后 5s 调用 `checkForUpdates()`；
  - `electron-builder.yml` 新增 `publish` 配置；
  - `package.json` 新增 `electron-updater` 依赖。
- **用户层面**：
  - 启动后 5s 应用内静默检查新版本，发现时侧边栏「设置」入口出现红点；
  - 「设置 → 版本更新」可查看新版本详情、发布日期、变更摘要；
  - 下载过程显示进度条与已传输大小（MB）；
  - 下载完成后一键启动系统安装器；
  - 任何步骤失败均有对应 Toast 提示与重试入口；
  - macOS 用户首次启动新安装器时需在 Finder 右键"打开"（Gatekeeper 拦截），Windows 用户需在 SmartScreen 点"仍要运行"（一次性，签名后消失）。
- **运维层面**：
  - CI 发布流水线无变化，仍走 `electron-builder` + GitHub Releases；
  - 每个用户的 `userData/update-cache.json` 是单文件、无锁、无并发问题；
  - dev 模式（`app.isPackaged === false`）下不触发真实检查，避免开发期请求 GitHub API。
- **后续约束**：
  - 拿到代码签名后，本期 5 态状态机、4 个 IPC 通道、3 处 UI 组件**完全复用**，仅需将 `autoDownload` / `autoInstallOnAppQuit` 改为 `true` 并补充 macOS 增量更新 blockmap 即可进入全静默模式（详见 [05-自动更新方案.md](../../04-技术方案/05-自动更新方案.md) 第 12 节演进路径）；
  - 「跳过此版本」「多更新通道（stable / beta）」「下载取消」「自动重试」能力按 YAGNI 本期不实现，演进路径中可按需追加；
  - 本期手动模式依赖 macOS/Windows 用户对系统安全弹窗的容忍度，若用户量增长后该路径转化率持续偏低，应优先推进代码签名工作而非补充 UI 文案。
