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
    /// 父会话 id（根会话为 `None`）。
    ///
    /// 清理预览要靠它做「父子归属」：取消勾选父会话时，前端需要知道哪些行
    /// 是它的子会话（`childSessionIds` 只说明「是子会话」，说不出属于谁）。
    ///
    /// 不填的调用点保持 `None`（字段可选，向后兼容）。
    #[serde(rename = "parentId", skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
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
    pub token_count: i64,
    pub total_cost: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatsItem {
    pub provider: String,
    pub token_count: i64,
    pub total_cost: f64,
}

/// 排行未覆盖到的 token（没有归属到任何模型 / Provider）。
///
/// 真库里存在**没有 model 字段**的会话（`session_v2.model` 为 NULL）：
/// 它们的 token 会进入概览卡的「Token 合计」，却不进入模型 / Provider 排行。
/// 用户把排行合计与概览合计对比时对不上、又无从解释，因此后端把这段差额
/// **如实算出来**交给前端展示，而不是让前端用减法估算（排行是 TOP 10，
/// 减法会把第 11 名及以后也算进「缺口」，数值不真实）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RankingCoverageGap {
    /// 没有归属到任何模型（或 Provider）的 token 合计
    pub token_count: i64,
    /// 涉及的会话数
    pub session_count: i64,
}

/// 模型排行的返回体：排行条目 + 覆盖缺口。
///
/// `coverage_gap` 为 `None` 时**不输出该字段**（前端据此整行不显示）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRankingResponse {
    pub items: Vec<ModelRankingItem>,
    /// 没有 model 记录、因而不参与排行的会话
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coverage_gap: Option<RankingCoverageGap>,
}

/// Provider 统计的返回体：统计条目 + 覆盖缺口。
///
/// `coverage_gap` 为 `None` 时**不输出该字段**（前端据此整行不显示）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatsResponse {
    pub items: Vec<ProviderStatsItem>,
    /// 有 model 但没有 providerID、因而不参与 Provider 统计的会话
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coverage_gap: Option<RankingCoverageGap>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRankingItem {
    pub project: String,
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
    /// v1 的 `step-finish` 自带 `tokens.total`；v2 由兼容层自行相加后填充。
    /// v1 路径保持 `None`，因此 v1 的 IPC 输出逐字段不变。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<i64>,
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

/// 清理/删除的两侧明细：「v2 数据」与「旧版副本」。
///
/// Q-02 = A 决定删除时两套表都要清，因此预览必须分列两侧，用户才能看清
/// 到底会删掉什么。v1 库只有旧表，`v2` 侧恒为 `None`（v1 输出逐字不变）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupSideDTO {
    /// 会话行数（v2 侧 = `session_v2` 行；旧版侧 = `session` 行）。
    pub session_count: i64,
    /// **逻辑消息数**：v2 侧 = `session_message` 行；旧版侧 = 旧表独有消息。
    ///
    /// 同 id 副本只在 v2 侧计一次，所以这个数是逻辑消息数，与实际删除的物理
    /// 行数可能不同（混合库里旧表还留着同 id 的冻结副本，那些行也会被删掉）。
    pub message_count: i64,
    /// 内容块数。
    ///
    /// - v2 侧：**消息行数**（v2 没有 `part` 表，内容块数按 `session_message`
    ///   行数统计，与 TASK-006 / 仪表盘 `partCount` 口径一致；不再解析 JSON）；
    /// - 旧版侧：`part` 行数（沿用 v1 口径）。
    pub part_count: i64,
    /// 体积。
    ///
    /// - **v2 预览 = 字节数**（`octet_length`）：v2 侧与旧版副本侧单位一致，
    ///   与磁盘占用一致，前端 `formatBytes` 在 v2 下才真正准确；
    /// - **v1 预览 = 字符数**（`LENGTH`）：1.3.5 的历史口径，逐字保留。
    pub estimated_size: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupPreviewDTO {
    pub session_count: i64,
    pub message_count: i64,
    pub part_count: i64,
    pub estimated_size: i64,
    pub sessions: Vec<SessionDTO>,
    /// 预览结果里的**子会话** id（父会话也在结果里）。
    ///
    /// 子会话不能单独取消勾选：v2 删除父会话会连带删掉整棵子树，若只保留
    /// 子会话就会留下 `parent_id` 悬空的孤儿（会话页只显示根会话，孤儿会
    /// 凭空消失）。前端据此把这些行置灰、只允许取消父会话。
    ///
    /// v1 不递归（删父不动子），没有孤儿问题，因此恒为空数组。
    #[serde(default)]
    pub child_session_ids: Vec<String>,
    /// v2 数据明细（v2 / 混合库才有；v1 库为 `None` 且不序列化）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub v2: Option<CleanupSideDTO>,
    /// 旧版副本明细（混合库才有；v1 库为 `None` 且不序列化）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legacy: Option<CleanupSideDTO>,
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
    /// VACUUM 失败原因；删除本身已生效，此字段仅用于提示空间未回收。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vacuum_error: Option<String>,
    /// v2 侧删除计数（v2 / 混合库才有）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub v2: Option<CleanupSideDTO>,
    /// 旧版副本侧删除计数（混合库才有）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legacy: Option<CleanupSideDTO>,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPreviewDTO {
    #[serde(flatten)]
    pub backup: BackupDTO,
    pub session_count: i64,
    pub message_count: i64,
    pub part_count: i64,
    /// 备份是不是 v2 数据库。
    ///
    /// v2 备份没有 `part` 表，`part_count` 固定为 0；前端据此隐藏「Part 0」，
    /// 免得用户误以为备份里没有内容块。
    pub is_v2: bool,
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
#[serde(rename_all = "camelCase")]
pub struct SessionShareDTO {
    pub session_id: String,
    /// v1 由 `session_share.id` 提供；v2 没有对应字段，返回 `null`。
    pub id: Option<String>,
    /// v1 由 `session_share.secret` 提供；v2 没有对应字段，返回 `null`。
    pub secret: Option<String>,
    pub url: String,
    pub time_created: i64,
}
