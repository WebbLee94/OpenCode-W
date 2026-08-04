// DTOs in this file mirror shared/types.ts for documentation purposes.
// Some filter/wrapper types are not used directly by Tauri commands because
// the frontend spreads object payloads into individual params (see src/lib/ipc.ts).
// They are kept here as a type reference and to keep `serde` derives in sync.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

// ─── IPC Result Wrapper ──────────────────────────────────────────────────
// Mirrors shared/types.ts IpcResult<T> discriminated union.
// All commands return IpcResult<T> to match the frontend ipc.ts expectations.

#[derive(Serialize)]
#[serde(untagged)]
pub enum IpcResult<T> {
    Success { success: bool, data: T },
    Error { success: bool, error: String },
}

impl<T> IpcResult<T> {
    pub fn ok(data: T) -> Self {
        IpcResult::Success { success: true, data }
    }

    pub fn err(error: impl Into<String>) -> Self {
        IpcResult::Error { success: false, error: error.into() }
    }
}

// ─── Database ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseStats {
    pub db_size: i64,
    pub root_session_count: i64,
    pub child_session_count: i64,
    pub session_count: i64,
    pub project_count: i64,
    pub part_count: i64,
    pub freelist_size: i64,
    pub wal_size: i64,
}

// ─── Dashboard / Analytics ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenStats {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_tokens: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub estimated_cost: f64,
    pub cache_hit_rate: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRanking {
    pub tool_name: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillUsage {
    pub skill_name: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenGroupDataPoint {
    pub period: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_tokens: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub estimated_cost: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrendDataPoint2 {
    pub date: String,
    pub value: f64,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionTrendItem {
    pub date: String,
    pub value: f64,
    pub label: Option<String>,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostTrendItem {
    pub date: String,
    pub value: f64,
    pub label: Option<String>,
    pub total_cost: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageTrendItem {
    pub date: String,
    pub value: f64,
    pub label: Option<String>,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeRange {
    pub start_date: String,
    pub end_date: String,
}

// ─── Sessions ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionDTO {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub msg_count: i64,
    pub total_tokens: i64,
    pub data_size: i64,
    pub tokens_input: i64,
    pub tokens_output: i64,
    pub tokens_reasoning: i64,
    pub tokens_cache_read: i64,
    pub tokens_cache_write: i64,
    pub time_created: i64,
    pub time_updated: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "childCount")]
    pub child_count: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDetailDTO {
    #[serde(flatten)]
    pub session: SessionDTO,
    pub token_stats: TokenStats,
    pub tool_ranking: Vec<ToolRanking>,
    pub skill_ranking: Vec<SkillUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFilter {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort_order: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_size: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_filter: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMoveFilter {
    pub session_ids: Vec<String>,
    pub directory: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRankingItem {
    pub model: String,
    pub session_count: i64,
    pub token_count: i64,
    pub total_cost: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatsItem {
    pub provider: String,
    pub session_count: i64,
    pub token_count: i64,
    pub total_cost: f64,
}

// ─── Messages ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageDTO {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub data_size: i64,
    pub time_created: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageFilter {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_size: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageListByParentFilter {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub child_session_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_size: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub id: String,
    pub session_id: String,
    pub content: String,
    pub session_title: String,
    pub time_created: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Paginated<T> {
    #[serde(rename = "data")]
    pub items: Vec<T>,
    pub total: i64,
    pub page: i64,
    #[serde(rename = "pageSize")]
    pub page_size: i64,
}

// ─── Part ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PartType {
    Text,
    Reasoning,
    Tool,
    File,
    Patch,
    Snapshot,
    Agent,
    #[serde(rename = "step-start")]
    StepStart,
    #[serde(rename = "step-finish")]
    StepFinish,
    Subtask,
    Retry,
    Compaction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PartTimeRange {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PartFileSourceDTO {
    #[serde(rename = "type")]
    pub source_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PartTokens {
    pub input: i64,
    pub output: i64,
    pub reasoning: i64,
    pub cache_read: i64,
    pub cache_write: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PartDTO {
    pub id: String,
    pub message_id: String,
    pub session_id: String,
    #[serde(rename = "type")]
    pub part_type: String,
    pub data_size: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub synthetic: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ignored: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time: Option<PartTimeRange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_mime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_source: Option<PartFileSourceDTO>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patch_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patch_files: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_snapshot: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<PartTokens>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtask_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtask_description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtask_agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtask_model: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtask_command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_attempt: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_time: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compaction_auto: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compaction_overflow: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<PartAttachment>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PartAttachment {
    pub mime: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
}

// ─── Cleanup ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupPreviewDTO {
    pub session_count: i64,
    pub message_count: i64,
    pub part_count: i64,
    pub estimated_size: i64,
    pub sessions: Vec<SessionDTO>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupResultDTO {
    pub deleted_sessions: i64,
    pub deleted_messages: i64,
    pub deleted_parts: i64,
    pub freed_bytes: i64,
    pub vacuum_before: i64,
    pub vacuum_after: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupFilter {
    pub strategy: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub days: Option<i64>,
    #[serde(rename = "sizeMB", skip_serializing_if = "Option::is_none")]
    pub size_mb: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_where: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub excluded_session_ids: Option<Vec<String>>,
}

// ─── Backup ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupDTO {
    pub file_name: String,
    pub file_path: String,
    pub file_size: i64,
    pub created_at: String,
    pub compressed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPreviewDTO {
    #[serde(flatten)]
    pub backup: BackupDTO,
    pub session_count: i64,
    pub message_count: i64,
    pub part_count: i64,
}

// ─── Todos ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoDTO {
    pub session_id: String,
    pub position: i64,
    pub content: String,
    pub status: String,
    pub priority: String,
    pub time_created: i64,
    pub time_updated: i64,
    pub session_title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoFilterByParent {
    pub parent_session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub child_session_ids: Option<Vec<String>>,
}

// ─── Session Share ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionShareDTO {
    pub session_id: String,
    pub id: String,
    pub secret: String,
    pub url: String,
    pub time_created: i64,
}

// ─── Update ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateState {
    Idle,
    Available,
    Downloading,
    Downloaded,
    Installing,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub release_date: String,
    pub release_notes: String,
    pub size_bytes: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateCheckResult {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub info: Option<UpdateInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub bytes_per_second: f64,
    pub percent: f64,
    pub transferred: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateErrorPayload {
    pub code: String,
    pub message: String,
}
