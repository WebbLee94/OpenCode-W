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
  cacheHitRate: number;    // percentage
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

// Search result
export interface SearchResult {
  id: string;
  session_id: string;
  content: string;
  session_title: string;
  time_created: number;
}

// Part DTO
export interface PartDTO {
  id: string;
  message_id: string;
  session_id: string;
  type: 'text' | 'tool' | 'reasoning' | 'step-start' | 'step-finish' | 'compaction' | 'patch' | 'file';
  data_size: number;
  // Parsed from JSON data field
  summary?: string;        // text preview or tool name
  toolName?: string;       // for tool type
  input?: string;          // tool input params
  output?: string;         // tool output
  status?: string;         // completed/failed
  tokens?: {               // step-finish tokens
    input: number;
    output: number;
    reasoning: number;
    cache_read: number;
    cache_write: number;
  };
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
