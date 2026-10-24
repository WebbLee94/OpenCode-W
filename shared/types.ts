// IPC response wrapper type
export type IpcResult<T = unknown> =
  | { success: true; data: T }
  | { success: false; error: string }

// DTO type definitions shared between main and renderer processes

// Database statistics
export interface DatabaseStats {
  dbSize: number;              // bytes
  rootSessionCount: number;    // 根会话数:parent_id IS NULL
  childSessionCount: number;   // 子会话数:parent_id IS NOT NULL
  sessionCount: number;        // 根+子（合计,UI 已改为展示拆分值,保留字段以兼容老缓存）
  projectCount: number;
  partCount: number;
  freelistSize: number;        // bytes
  walSize: number;             // bytes
}

// Database dialect of the currently opened file.
//  - v1        : 只有旧 session/message/part 表
//  - v2        : 只有 session_v2/session_message 表
//  - v2-mixed  : v2 表与旧的冻结表并存（迁移后形态）
//  - unsupported: 缺少必需的表或列，后端拒绝打开
export type SchemaMode = 'v1' | 'v2' | 'v2-mixed' | 'unsupported'

// `kv['migration.v1-v2'].phase`
export type MigrationPhase = 'none' | 'running' | 'completed' | 'failed' | 'unknown'

// Returned by database:info — mirrors Rust SchemaInfoDTO
export interface SchemaInfoDTO {
  mode: SchemaMode
  migrationPhase: MigrationPhase
  hasLegacyTables: boolean
  v2SessionCount: number
  unsupportedReason: string | null
}

// Database health info returned by database:health
export interface HealthInfo {
  ok: boolean;
  pageCount: number;
  freelistPages: number;
  walSize: number;             // bytes
  dbSize: number;              // bytes
  currentPath: string | null;
  error?: string | null;
}

export interface IntegrityCheckResult {
  ok: boolean;
  result: string | null;
  error?: string | null;
}

// Token statistics
export interface TokenStats {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheRead: number;
  cacheWrite: number;
  estimatedCost: number;
  cacheHitRate: number;    // percentage, 0-100, cacheRead / (cacheRead + inputTokens) * 100
}

// Tool ranking
export interface ToolRanking {
  toolName: string;
  count: number;
}

// Skill usage
export interface SkillUsage {
  skillName: string;
  count: number;
}

// Token group data point (for grouped token stats)
export interface TokenGroupDataPoint {
  period: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheRead: number;
  cacheWrite: number;
  estimatedCost: number;
}

// 趋势图通用数据点（时间 + 值 + 可选标签）
export interface TrendDataPoint2 {
  date: string;         // YYYY-MM-DD
  value: number;
  label?: string;
}

// 会话创建趋势 — 按天的会话计数
export interface SessionTrendItem extends TrendDataPoint2 {
  count: number;
}

// 成本趋势 — 按天的成本总和
export interface CostTrendItem extends TrendDataPoint2 {
  totalCost: number;
}

// 消息活跃度趋势 — 按天的消息计数
export interface MessageTrendItem extends TrendDataPoint2 {
  count: number;
}

// Time range filter
export interface TimeRange {
  startDate: string;  // ISO "2026-05-01"
  endDate: string;    // ISO "2026-05-22"
}

// Session DTOs
export interface SessionDTO {
  id: string;
  title: string;
  directory?: string;
  model?: string;
  agent?: string;
  project_id?: string;
  msg_count: number;
  total_tokens: number;
  data_size: number;       // bytes
  tokens_input: number;
  tokens_output: number;
  tokens_reasoning: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  time_created: number;    // ms timestamp
  time_updated: number;    // ms timestamp
  cost?: number;
  childCount?: number;
  /**
   * 父会话 id（根会话为 undefined）。
   *
   * 清理预览要靠它做「父子归属」：取消勾选父会话时，前端需要知道哪些行是
   * 它的子会话（`childSessionIds` 只说明「是子会话」，说不出属于谁）。
   *
   * 不填的调用点保持缺省（字段可选，向后兼容）。
   */
  parentId?: string;
}

export interface SessionDetailDTO extends SessionDTO {
  tokenStats: TokenStats;
  toolRanking: ToolRanking[];
  skillRanking: SkillUsage[];
}

export interface SessionMoveFilter { sessionIds: string[]; directory: string; }

export interface SessionFilter {
  search?: string;
  projectId?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
  startDate?: string;
  endDate?: string;
  parentFilter?: 'root' | 'all' | 'children';
}

// Message DTOs
export interface MessageDTO {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  data_size: number;       // bytes
  time_created: number;    // ms timestamp
  content?: string;        // truncated preview (max 300 chars)
}

export interface MessageDetailDTO extends MessageDTO {
  content: string;         // raw message content
  parts: PartDTO[];
}

export interface MessageFilter {
  sessionId: string;
  page?: number;
  pageSize?: number;
}

export interface MessageListByParentFilter {
  parentSessionId?: string;
  childSessionIds?: string[];
  page?: number;
  pageSize?: number;
}

// Search result
export interface SearchResult {
  id: string;
  session_id: string;
  content: string;
  session_title: string;
  time_created: number;
}

// ─── 全文搜索索引（FTS5 sidecar）─────────────────────────────────────────
// 索引与 OpenCode 库完全分离，存放于 app_data_dir/search-index-v1.sqlite。
// state: none（从未构建）/ building（后台构建中）/ ready / error（回退 LIKE）

export type SearchIndexState = 'none' | 'building' | 'ready' | 'error'

export interface SearchIndexStatus {
  state: SearchIndexState
  /** 已处理的消息行数（进度分子） */
  indexed: number
  /** 待处理的消息行数（进度分母） */
  total: number
  /** 已索引的最大 time_created（毫秒），0 表示尚未建立水位 */
  watermark: number
  error: string | null
}

/** 事件 search:index-progress 的负载 */
export interface SearchIndexProgress {
  indexed: number
  total: number
  /** rebuild / incremental / v2 / legacy / prune / done */
  phase: string
}

// Part DTO — 覆盖 OpenCode canonical Part union 全部 12 种
export type PartType =
  | 'text' | 'reasoning' | 'tool'
  | 'file' | 'patch' | 'snapshot' | 'agent'
  | 'step-start' | 'step-finish'
  | 'subtask' | 'retry' | 'compaction';

// Canonical token 嵌套结构（与 OpenCode 一致）
// 当前 PartDTO.tokens 仍为 flat（cache_read/cache_write）以兼容 ConversationView / Messages 渲染端
// 未来渲染端重构时可按 canonical 形式扩展
export interface PartTimeRange {
  start?: number;
  end?: number;
}

export interface PartFileSourceDTO {
  type: 'file' | 'symbol' | 'resource';
  path?: string;
  range?: unknown;
  name?: string;
  kind?: number;
  clientName?: string;
  uri?: string;
  text?: { value: string; start: number; end: number };
}

export interface PartDTO {
  // 基础字段
  id: string;
  message_id: string;
  session_id: string;
  type: PartType;
  data_size: number;

  // 通用可选字段
  summary?: string;             // 一行摘要
  metadata?: Record<string, unknown>;  // 通用元数据（text/reasoning/tool）

  // TextPart
  text?: string;                // 完整文本
  synthetic?: boolean;
  ignored?: boolean;
  time?: PartTimeRange;

  // ReasoningPart
  // (复用 text/metadata/time)

  // ToolPart
  toolName?: string;            // 工具名（canonical `tool` 字段）
  callID?: string;              // 工具调用 ID（canonical `callID` 字段）
  toolState?: 'pending' | 'running' | 'completed' | 'error';  // 规范化状态
  status?: string;              // 状态字符串（tool/step-finish 通用）
  input?: string;               // JSON string
  output?: string;              // JSON string
  title?: string;               // 完成态标题
  error?: string;               // 错误态错误信息
  attachments?: { mime: string; url: string; filename?: string }[];  // 附件

  // FilePart
  fileMime?: string;
  fileName?: string;
  fileUrl?: string;
  fileSource?: PartFileSourceDTO;

  // PatchPart
  patchHash?: string;
  patchFiles?: string[];

  // SnapshotPart
  snapshotData?: string;

  // AgentPart
  agentName?: string;
  agentSource?: { value: string; start: number; end: number };

  // StepStartPart
  stepSnapshot?: string;        // canonical 字符串 variant

  // StepFinishPart
  reason?: string;
  cost?: number;
  tokens?: {                    // flat 结构（cache_read/cache_write），与渲染端兼容
    input: number;
    output: number;
    reasoning: number;
    cache_read: number;
    cache_write: number;
    total?: number;             // v1 step-finish 自带；v2 由兼容层相加
  };

  // SubtaskPart
  subtaskPrompt?: string;
  subtaskDescription?: string;
  subtaskAgent?: string;
  subtaskModel?: { providerID: string; modelID: string };
  subtaskCommand?: string;

  // RetryPart
  retryAttempt?: number;
  retryError?: string;
  retryTime?: number;

  // CompactionPart
  compactionAuto?: boolean;
  compactionOverflow?: boolean;
}

// Cleanup DTOs

// 清理/删除的两侧明细：「v2 数据」与「旧版副本」。
// Q-02 = A 决定删除时两套表都要清，因此预览必须分列两侧。
// v1 库只有旧表，v2 侧恒为 null（v1 输出逐字不变）。
export interface CleanupSideDTO {
  sessionCount: number;   // 会话行数
  messageCount: number;   // 消息行数（同 id 消息只在 v2 侧计一次）
  partCount: number;      // 内容块数：v2 侧 = 消息行数（v2 无 part 表），旧版侧 = part 行数
  estimatedSize: number;  // bytes
}

export interface CleanupPreviewDTO {
  sessionCount: number;
  messageCount: number;
  partCount: number;
  estimatedSize: number;   // bytes
  sessions: SessionDTO[];
  /**
   * 结果里的子会话 id（父会话也在结果里）。
   *
   * 子会话不能单独取消勾选：v2 删除父会话会连带删掉整棵子树，只保留子会话
   * 会留下 parent_id 悬空的孤儿（会话页只显示根会话，孤儿会凭空消失）。
   * 前端据此把这些行置灰，只允许取消父会话。
   *
   * v1 不递归（删父不动子），没有孤儿问题，因此恒为空数组。
   */
  childSessionIds: string[];
  v2?: CleanupSideDTO | null;       // v2 数据明细（v2 / 混合库才有）
  legacy?: CleanupSideDTO | null;   // 旧版副本明细（混合库才有）
}

export interface CleanupResultDTO {
  deletedSessions: number;
  deletedMessages: number;
  deletedParts: number;
  freedBytes: number;
  vacuumBefore: number;
  vacuumAfter: number;
  vacuumError?: string | null;      // VACUUM 失败原因（删除已生效，仅空间未回收）
  v2?: CleanupSideDTO | null;       // v2 侧删除计数
  legacy?: CleanupSideDTO | null;   // 旧版副本侧删除计数
}

export type CleanupStrategy = 'time' | 'size' | 'project';

export interface CleanupFilter {
  strategy: CleanupStrategy;
  days?: number;
  sizeMB?: number;
  projectId?: string;
  customWhere?: string;
  excludedSessionIds?: string[];
}

// Backup DTO
export interface BackupDTO {
  fileName: string;
  filePath: string;
  fileSize: number;
  createdAt: string;
}

// Backup preview with content counts
export interface BackupPreviewDTO extends BackupDTO {
  sessionCount: number;
  messageCount: number;
  partCount: number;
  /**
   * 备份是不是 v2 数据库：v2 备份没有 part 表，part_count 的语义是
   * session_message 行数（与仪表盘口径一致），前端据此不展示 Part 行。
   *
   * 后端始终返回该字段（无法探测时按 false 处理）；保持可选是为了兼容
   * 旧后端：字段缺失时按 v1 处理。
   */
  isV2?: boolean;
}

// Todo DTOs
export interface TodoDTO {
  session_id: string;
  position: number;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority: 'high' | 'medium' | 'low';
  time_created: number;
  time_updated: number;
  session_title: string;  // JOIN session.title
}

// 父子会话合并查询过滤条件
// 当 childSessionIds 为空数组或省略时,只查询父会话的 todos
export interface TodoFilterByParent {
  parentSessionId: string;
  childSessionIds?: string[];
}

// Session Share DTO
export interface SessionShareDTO {
  session_id: string;
  // v1 由 session_share 表提供；v2 只有 share_url，因此这两个字段可为 null
  id?: string | null;
  secret?: string | null;
  url: string;
  time_created: number;
}

// ─── Route B: Model & Provider Stats ─────────────────────────────────────

export interface ModelRankingItem {
  model: string
  tokenCount: number
  totalCost: number
}

export interface ProviderStatsItem {
  provider: string
  tokenCount: number
  totalCost: number
}

// ─── Route B: Project Ranking ──────────────────────────────────────────────

export interface ProjectRankingItem {
  project: string       // project folder name (last path segment)
  tokenCount: number
  totalCost: number
}

// === 版本更新 ===
export type UpdateState =
  | 'idle'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'

/**
 * 「检查更新」的结果状态。
 *
 * 与 UpdateState（更新下载流程）分离：UpdateState 描述「已发现更新之后」的
 * 下载/安装进度，而 checkStatus 描述「这次检查得出了什么结论」。
 * 两者组合才能唯一确定设置页要呈现的状态文案。
 */
export type UpdateCheckStatus =
  | 'idle'        // 未检查
  | 'checking'    // 检查中
  | 'up-to-date'  // 已是最新版本
  | 'available'   // 有可用更新
  | 'failed'      // 检查失败

export interface UpdateInfo {
  version: string         // 远端版本号，semver
  releaseDate: string     // ISO 8601
  releaseNotes: string    // Markdown
  sizeBytes: number
}

export interface UpdateProgress {
  bytesPerSecond: number
  percent: number         // 0-100
  transferred: number
  total: number
}

/**
 * 更新相关错误的分类码。
 *
 * 注意：这里**不能**用「当前已是最新版本」作为任何错误的兜底文案 ——
 * 「已是最新」是 check() 返回 null 的成功结果，不是错误。
 */
export type UpdateErrorCode =
  | 'network'            // 网络 / 超时 / DNS / TLS
  | 'ratelimit'          // 被限流
  | 'manifest-missing'   // 远端更新清单 404 / 不可用
  | 'no-platform-asset'  // 清单里没有当前平台的产物
  | 'signature-failed'   // 签名校验失败
  | 'download-failed'    // 下载更新包失败
  | 'install-failed'     // 安装 / 重启失败
  | 'unknown'            // 无法归类

export interface UpdateErrorPayload {
  code: UpdateErrorCode
  message: string
}
