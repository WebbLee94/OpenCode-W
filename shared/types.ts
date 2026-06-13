// IPC response wrapper type
export type IpcResult<T = unknown> =
  | { success: true; data: T }
  | { success: false; error: string }

// DTO type definitions shared between main and renderer processes

// Database statistics
export interface DatabaseStats {
  dbSize: number;          // bytes
  sessionCount: number;
  projectCount: number;
  partCount: number;
  freelistSize: number;    // bytes
  walSize: number;         // bytes
}

export interface TableStats {
  name: string;
  rowCount: number;
  dataSize: number;        // bytes
}

// Token statistics
export interface TokenStats {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheRead: number;
  cacheWrite: number;
  estimatedCost: number;
  cacheReuseRate: number;    // percentage
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

// Trend data
export interface TrendDataPoint {
  date: string;
  newSessions: number;
  sizeGrowth: number;
  messageCount: number;
}

// Trend comparison (current vs previous period)
export interface TrendComparison {
  current: TrendDataPoint[];
  previous: TrendDataPoint[];
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
  time_created: number;    // ms timestamp
  time_updated: number;    // ms timestamp
  cost?: number;
  childCount?: number;
}

export interface SessionDetailDTO extends SessionDTO {
  tokenStats: TokenStats;
  toolRanking: ToolRanking[];
  skillList: string[];
}

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

// Part DTO — 覆盖 OpenCode canonical Part union 全部 12 种
export type PartType =
  | 'text' | 'reasoning' | 'tool'
  | 'file' | 'patch' | 'snapshot' | 'agent'
  | 'step-start' | 'step-finish'
  | 'subtask' | 'retry' | 'compaction';

// Canonical token 嵌套结构（与 OpenCode 一致，供未来使用）
// 当前 PartDTO.tokens 仍为 flat（cache_read/cache_write）以兼容 ConversationView / Messages 渲染端
// Commit 3 渲染端重构时再统一迁移为 PartTokensDTO
export interface PartTokensDTO {
  total?: number;
  input: number;
  output: number;
  reasoning: number;
  cache: {
    read: number;
    write: number;
  };
}

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
export interface CleanupPreviewDTO {
  sessionCount: number;
  messageCount: number;
  partCount: number;
  estimatedSize: number;   // bytes
  sessions: SessionDTO[];
}

export interface CleanupResultDTO {
  deletedSessions: number;
  deletedMessages: number;
  deletedParts: number;
  freedBytes: number;
  vacuumBefore: number;
  vacuumAfter: number;
}

export type CleanupStrategy = 'time' | 'size' | 'project' | 'custom';

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
  compressed: boolean;
}

// Backup preview with content counts
export interface BackupPreviewDTO extends BackupDTO {
  sessionCount: number;
  messageCount: number;
  partCount: number;
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

export interface TodoFilter {
  search?: string;
  status?: string;
  priority?: string;
  projectId?: string;
  page?: number;
  pageSize?: number;
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
  id: string;
  secret: string;
  url: string;
  time_created: number;
}

// Account DTOs
export interface AccountDTO {
  id: string;
  email: string;
  url: string;
  token_expiry: number | null;
}

export interface AccountStateDTO {
  active_account_id: string | null;
  active_org_id: string | null;
  account_email?: string;
  account_url?: string;
}

// Event DTOs
export interface EventSequenceDTO {
  aggregate_id: string;
  seq: number;
  owner_id: string | null;
}

export interface EventDTO {
  id: string;
  aggregate_id: string;
  seq: number;
  type: string;
  data: string;
}

// ─── Route B: Project & Workspace Stats ─────────────────────────────────

export interface ProjectStatsItem {
  directory: string
  sessionCount: number
  tokenCount: number
  cost: number
}

export interface WorkspaceStatsItem {
  name: string
  branch: string | null
  totalTimeHours: number
}

// ─── Route B: Model & Provider Stats ─────────────────────────────────────

export interface ModelRankingItem {
  model: string
  sessionCount: number
  tokenCount: number
  totalCost: number
}

export interface ProviderStatsItem {
  provider: string
  sessionCount: number
  tokenCount: number
  totalCost: number
}

// ─── Route B: Account Usage ──────────────────────────────────────────────

export interface AccountUsageItem {
  accountId: string
  email: string
  sessionCount: number
  tokenCount: number
  totalCost: number
  isActive: boolean
}
