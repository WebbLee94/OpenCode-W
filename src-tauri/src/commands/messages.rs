//! Messages commands — migrated from electron/ipc/messages.ts
//!
//! Implements 4 Tauri commands + parse_part_data (the 216-line TS function).
//! SQL statements are copied verbatim from the Electron implementation.

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::db::{self, DbState};
use crate::models::dto::{
    IpcResult, MessageDTO, PartAttachment, PartTimeRange, PartTokens, SearchResult,
};

// ─── Output types ─────────────────────────────────────────────────────────
// PartDTOOut mirrors shared/types.ts PartDTO with precise serde renames.
// dto.rs::PartDTO uses snake_case, but the frontend expects mixed naming:
//   - toolName, callID, toolState, fileMime, fileName, fileUrl, fileSource
//   - patchHash, patchFiles, snapshotData, agentName, agentSource, stepSnapshot
//   - subtaskPrompt, subtaskDescription, subtaskAgent, subtaskModel, subtaskCommand
//   - retryAttempt, retryError, retryTime, compactionAuto, compactionOverflow
//   - message_id, session_id, data_size (stay snake_case)

#[derive(Debug, Clone, Serialize)]
pub struct PartDTOOut {
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

    // ToolPart
    #[serde(skip_serializing_if = "Option::is_none", rename = "toolName")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "callID")]
    pub call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "toolState")]
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
    pub attachments: Option<Vec<PartAttachment>>,

    // FilePart
    #[serde(skip_serializing_if = "Option::is_none", rename = "fileMime")]
    pub file_mime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "fileName")]
    pub file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "fileUrl")]
    pub file_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "fileSource")]
    pub file_source: Option<serde_json::Value>,

    // PatchPart
    #[serde(skip_serializing_if = "Option::is_none", rename = "patchHash")]
    pub patch_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "patchFiles")]
    pub patch_files: Option<Vec<String>>,

    // SnapshotPart
    #[serde(skip_serializing_if = "Option::is_none", rename = "snapshotData")]
    pub snapshot_data: Option<String>,

    // AgentPart
    #[serde(skip_serializing_if = "Option::is_none", rename = "agentName")]
    pub agent_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "agentSource")]
    pub agent_source: Option<serde_json::Value>,

    // StepStartPart
    #[serde(skip_serializing_if = "Option::is_none", rename = "stepSnapshot")]
    pub step_snapshot: Option<String>,

    // StepFinishPart
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<PartTokens>,

    // SubtaskPart
    #[serde(skip_serializing_if = "Option::is_none", rename = "subtaskPrompt")]
    pub subtask_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "subtaskDescription")]
    pub subtask_description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "subtaskAgent")]
    pub subtask_agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "subtaskModel")]
    pub subtask_model: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "subtaskCommand")]
    pub subtask_command: Option<String>,

    // RetryPart
    #[serde(skip_serializing_if = "Option::is_none", rename = "retryAttempt")]
    pub retry_attempt: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "retryError")]
    pub retry_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "retryTime")]
    pub retry_time: Option<i64>,

    // CompactionPart
    #[serde(skip_serializing_if = "Option::is_none", rename = "compactionAuto")]
    pub compaction_auto: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "compactionOverflow")]
    pub compaction_overflow: Option<bool>,
}

impl PartDTOOut {
    fn new(id: &str, message_id: &str, session_id: &str, part_type: String, data_size: i64) -> Self {
        Self {
            id: id.to_string(),
            message_id: message_id.to_string(),
            session_id: session_id.to_string(),
            part_type,
            data_size,
            summary: None,
            metadata: None,
            text: None,
            synthetic: None,
            ignored: None,
            time: None,
            tool_name: None,
            call_id: None,
            tool_state: None,
            status: None,
            input: None,
            output: None,
            title: None,
            error: None,
            attachments: None,
            file_mime: None,
            file_name: None,
            file_url: None,
            file_source: None,
            patch_hash: None,
            patch_files: None,
            snapshot_data: None,
            agent_name: None,
            agent_source: None,
            step_snapshot: None,
            reason: None,
            cost: None,
            tokens: None,
            subtask_prompt: None,
            subtask_description: None,
            subtask_agent: None,
            subtask_model: None,
            subtask_command: None,
            retry_attempt: None,
            retry_error: None,
            retry_time: None,
            compaction_auto: None,
            compaction_overflow: None,
        }
    }
}

/// MessageDetailDTO — extends MessageDTO with raw content + parsed parts.
/// Defined here because dto.rs doesn't include it.
#[derive(Debug, Clone, Serialize)]
pub struct MessageDetailDTO {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub data_size: i64,
    pub time_created: i64,
    pub content: String,
    pub parts: Vec<PartDTOOut>,
}

/// MessageListResult — matches frontend expectation `{ data, total, page, pageSize }`.
/// Defined here because dto.rs::Paginated uses `items`/`page_size` (snake_case).
#[derive(Debug, Clone, Serialize)]
pub struct MessageListResult {
    pub data: Vec<MessageDTO>,
    pub total: i64,
    pub page: i64,
    #[serde(rename = "pageSize")]
    pub page_size: i64,
}

// ─── JSON helpers ─────────────────────────────────────────────────────────

/// Navigate a JSON value by dot-separated path (e.g., "state.status").
/// Returns the first non-null value found across the provided paths.
fn pick_first<'a>(data: &'a serde_json::Value, paths: &[&str]) -> Option<&'a serde_json::Value> {
    for p in paths {
        let json_path = format!("/{}", p.replace('.', "/"));
        if let Some(v) = data.pointer(&json_path) {
            if !v.is_null() {
                return Some(v);
            }
        }
    }
    None
}

/// Pick a string value from the first non-empty path.
fn pick_str(data: &serde_json::Value, paths: &[&str]) -> Option<String> {
    pick_first(data, paths)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Pick a non-empty string value (TS `pick<string>(...) || undefined` semantics).
fn pick_str_opt(data: &serde_json::Value, paths: &[&str]) -> Option<String> {
    pick_str(data, paths).filter(|s| !s.is_empty())
}

/// Pick an i64 value.
fn pick_i64(data: &serde_json::Value, paths: &[&str]) -> Option<i64> {
    pick_first(data, paths).and_then(|v| v.as_i64())
}

/// Pick an f64 value.
fn pick_f64(data: &serde_json::Value, paths: &[&str]) -> Option<f64> {
    pick_first(data, paths).and_then(|v| v.as_f64())
}

/// Pick a bool value.
fn pick_bool(data: &serde_json::Value, paths: &[&str]) -> Option<bool> {
    pick_first(data, paths).and_then(|v| v.as_bool())
}

/// Convert a JSON value to string (TS `asString`).
/// - String → as-is
/// - Other → pretty-printed JSON
/// - Null/None → empty string
fn as_string(v: Option<&serde_json::Value>) -> String {
    match v {
        None => String::new(),
        Some(serde_json::Value::Null) => String::new(),
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(other) => serde_json::to_string_pretty(other).unwrap_or_default(),
    }
}

/// Convert a JSON value to Option<String> (TS `asStringOrUndef`).
/// Empty results become None.
fn as_string_or_undef(v: Option<&serde_json::Value>) -> Option<String> {
    let s = as_string(v);
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// Truncate a string to `max` Unicode characters (TS `text.slice(0, max)`).
fn truncate_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// Truncate with ellipsis if longer than `max` chars.
fn truncate_with_ellipsis(s: &str, max: usize) -> Option<String> {
    if s.is_empty() {
        return None;
    }
    if s.chars().count() > max {
        let truncated: String = s.chars().take(max).collect();
        Some(format!("{}...", truncated))
    } else {
        Some(s.to_string())
    }
}

/// Parse a PartTimeRange from a JSON object.
fn parse_time_range(v: &serde_json::Value) -> Option<PartTimeRange> {
    if !v.is_object() {
        return None;
    }
    Some(PartTimeRange {
        start: v.get("start").and_then(|s| s.as_i64()),
        end: v.get("end").and_then(|e| e.as_i64()),
    })
}

/// Extract time_created from a rusqlite Row, handling both INTEGER and TEXT.
fn row_get_time(row: &rusqlite::Row, idx: usize) -> rusqlite::Result<i64> {
    let val: rusqlite::types::Value = row.get(idx)?;
    Ok(match val {
        rusqlite::types::Value::Integer(i) => i,
        rusqlite::types::Value::Real(f) => f as i64,
        rusqlite::types::Value::Text(s) => parse_date_string(&s),
        _ => 0,
    })
}

/// Parse an ISO date string to millisecond timestamp.
fn parse_date_string(s: &str) -> i64 {
    use chrono::TimeZone;
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return dt.timestamp_millis();
    }
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S") {
        return chrono::Utc.from_utc_datetime(&dt).timestamp_millis();
    }
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S") {
        return chrono::Utc.from_utc_datetime(&dt).timestamp_millis();
    }
    if let Ok(d) = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return chrono::Utc
            .from_utc_datetime(&d.and_hms_opt(0, 0, 0).unwrap())
            .timestamp_millis();
    }
    0
}

// ─── parse_part_data ──────────────────────────────────────────────────────

/// Parse a part row's data JSON into a PartDTOOut.
///
/// Mirrors the 216-line TS `parsePartData` function from electron/ipc/messages.ts.
/// Handles 12 PartType variants with canonical/flat field compatibility.
fn parse_part_data(
    row_id: &str,
    row_message_id: &str,
    row_session_id: &str,
    row_data: &str,
) -> PartDTOOut {
    let data: serde_json::Value =
        serde_json::from_str(row_data).unwrap_or(serde_json::Value::Null);

    let part_type = data
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("text")
        .to_string();

    let data_size = row_data.len() as i64;

    let mut part = PartDTOOut::new(
        row_id,
        row_message_id,
        row_session_id,
        part_type.clone(),
        data_size,
    );

    // metadata (applies to text/reasoning/tool)
    if let Some(meta) = data.get("metadata") {
        if meta.is_object() {
            part.metadata = Some(meta.clone());
        }
    }

    match part_type.as_str() {
        // ============ TextPart ============
        "text" => {
            let text = as_string(pick_first(&data, &["text", "content"]));
            part.text = if text.is_empty() { None } else { Some(text.clone()) };
            part.summary = truncate_with_ellipsis(&text, 200);
            if pick_bool(&data, &["synthetic"]) == Some(true) {
                part.synthetic = Some(true);
            }
            if pick_bool(&data, &["ignored"]) == Some(true) {
                part.ignored = Some(true);
            }
            if let Some(t) = pick_first(&data, &["time"]) {
                part.time = parse_time_range(t);
            }
        }

        // ============ ReasoningPart ============
        "reasoning" => {
            let text = as_string(pick_first(&data, &["text", "content"]));
            part.text = if text.is_empty() { None } else { Some(text.clone()) };
            part.summary = truncate_with_ellipsis(&text, 200);
            if let Some(t) = pick_first(&data, &["time"]) {
                part.time = parse_time_range(t);
            }
        }

        // ============ ToolPart ============
        "tool" => {
            // canonical: state nested; flat: tool_name/tool_input/tool_output/status
            part.tool_name = Some(pick_str(&data, &["tool", "tool_name"]).unwrap_or_default());
            part.call_id = pick_str_opt(&data, &["callID"]);

            let status = pick_str(&data, &["state.status", "status"])
                .unwrap_or_else(|| "completed".to_string());
            if matches!(status.as_str(), "pending" | "running" | "completed" | "error") {
                part.tool_state = Some(status.clone());
            }
            part.status = Some(status.clone());

            part.summary = Some(
                part.tool_name
                    .clone()
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "[tool]".to_string()),
            );

            // input
            if let Some(input) = pick_first(&data, &["state.input", "tool_input", "input"]) {
                part.input = as_string_or_undef(Some(input));
            }
            // output
            if let Some(output) = pick_first(&data, &["state.output", "tool_output", "output"]) {
                part.output = as_string_or_undef(Some(output));
            }
            // error
            if let Some(error) = pick_first(&data, &["state.error", "error"]) {
                part.error = as_string_or_undef(Some(error));
            }
            // title
            if let Some(title) = pick_str_opt(&data, &["state.title", "title"]) {
                part.title = Some(title);
            }
            // attachments
            if let Some(atts) = pick_first(&data, &["state.attachments"]) {
                if let Some(arr) = atts.as_array() {
                    part.attachments = Some(
                        arr.iter()
                            .map(|a| PartAttachment {
                                mime: a
                                    .get("mime")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string(),
                                url: a
                                    .get("url")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string(),
                                filename: a
                                    .get("filename")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string()),
                            })
                            .collect(),
                    );
                }
            }
            // time
            if let Some(t) = pick_first(&data, &["state.time", "time"]) {
                part.time = parse_time_range(t);
            }
        }

        // ============ FilePart ============
        "file" => {
            part.file_mime = pick_str_opt(&data, &["mime"]);
            part.file_name = pick_str_opt(&data, &["filename"]);
            part.file_url = pick_str_opt(&data, &["url"]);
            if let Some(source) = pick_first(&data, &["source"]) {
                if source.is_object() {
                    part.file_source = Some(source.clone());
                }
            }
            let filename = part
                .file_name
                .clone()
                .or_else(|| part.file_url.clone())
                .unwrap_or_else(|| "file".to_string());
            let mime = part.file_mime.clone().unwrap_or_default();
            part.summary = Some(format!("[file] {} {}", mime, filename).trim().to_string());
        }

        // ============ PatchPart ============
        "patch" => {
            part.patch_hash = pick_str_opt(&data, &["hash"]);
            // patchFiles is Vec<String>
            if let Some(files) = pick_first(&data, &["files"]) {
                if let Some(arr) = files.as_array() {
                    let names: Vec<String> = arr
                        .iter()
                        .filter_map(|f| f.as_str().map(|s| s.to_string()))
                        .collect();
                    if !names.is_empty() {
                        part.patch_files = Some(names);
                    }
                }
            }
            part.summary = Some(format!(
                "[patch] {} 个文件",
                part.patch_files.as_ref().map(|v| v.len()).unwrap_or(0)
            ));
        }

        // ============ SnapshotPart ============
        "snapshot" => {
            let snap = pick_str(&data, &["snapshot"]).unwrap_or_default();
            part.snapshot_data = if snap.is_empty() { None } else { Some(snap.clone()) };
            part.summary = Some(if snap.is_empty() {
                "[snapshot]".to_string()
            } else if snap.chars().count() > 30 {
                format!("[snapshot] {}...", truncate_chars(&snap, 30))
            } else {
                format!("[snapshot] {}", snap)
            });
        }

        // ============ AgentPart ============
        "agent" => {
            part.agent_name = pick_str_opt(&data, &["name"]);
            if let Some(source) = pick_first(&data, &["source"]) {
                if source.is_object() {
                    part.agent_source = Some(source.clone());
                }
            }
            part.summary = Some(
                part.agent_name
                    .clone()
                    .map(|n| format!("agent: {}", n))
                    .unwrap_or_else(|| "[agent]".to_string()),
            );
        }

        // ============ StepStartPart ============
        "step-start" => {
            let snap = pick_first(&data, &["snapshot"]);
            match snap {
                Some(serde_json::Value::String(s)) => {
                    part.step_snapshot = Some(s.clone());
                    part.summary = Some(format!("[step] {}", truncate_chars(s, 30)));
                }
                Some(obj) if obj.is_object() => {
                    let step_name = obj
                        .get("step_name")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    let step_id = obj.get("step_id");
                    let id_str = step_id
                        .and_then(|v| {
                            if let Some(n) = v.as_i64() {
                                Some(n.to_string())
                            } else {
                                v.as_str().map(|s| s.to_string())
                            }
                        })
                        .unwrap_or_default();
                    part.summary = Some(if let Some(name) = step_name {
                        name
                    } else {
                        format!("Step {}", id_str)
                    });
                }
                _ => {
                    part.summary = Some("Step start".to_string());
                }
            }
        }

        // ============ StepFinishPart ============
        "step-finish" => {
            let reason = pick_str(&data, &["reason", "result"])
                .unwrap_or_else(|| "completed".to_string());
            part.reason = Some(reason.clone());
            part.status = Some(reason.clone());
            part.cost = pick_f64(&data, &["cost"]);

            if let Some(tokens) = pick_first(&data, &["tokens"]) {
                if tokens.is_object() {
                    let cache_nested = tokens.get("cache").map(|c| c.is_object()).unwrap_or(false);
                    let (cache_read, cache_write) = if cache_nested {
                        let cache = tokens.get("cache").unwrap();
                        (
                            cache.get("read").and_then(|v| v.as_i64()).unwrap_or(0),
                            cache.get("write").and_then(|v| v.as_i64()).unwrap_or(0),
                        )
                    } else {
                        (
                            tokens.get("cache_read").and_then(|v| v.as_i64()).unwrap_or(0),
                            tokens.get("cache_write").and_then(|v| v.as_i64()).unwrap_or(0),
                        )
                    };
                    let t = PartTokens {
                        input: tokens.get("input").and_then(|v| v.as_i64()).unwrap_or(0),
                        output: tokens.get("output").and_then(|v| v.as_i64()).unwrap_or(0),
                        reasoning: tokens.get("reasoning").and_then(|v| v.as_i64()).unwrap_or(0),
                        cache_read,
                        cache_write,
                    };
                    let mut summary_parts = Vec::new();
                    if t.input != 0 {
                        summary_parts.push(format!("in {}", t.input));
                    }
                    if t.output != 0 {
                        summary_parts.push(format!("out {}", t.output));
                    }
                    part.summary = Some(format!(
                        "Step finished: {} ({})",
                        reason,
                        summary_parts.join("/")
                    ));
                    part.tokens = Some(t);
                } else {
                    part.summary = Some(format!("Step finished: {}", reason));
                }
            } else {
                part.summary = Some(format!("Step finished: {}", reason));
            }
        }

        // ============ SubtaskPart ============
        "subtask" => {
            part.subtask_prompt = pick_str_opt(&data, &["prompt"]);
            part.subtask_description = pick_str_opt(&data, &["description"]);
            part.subtask_agent = pick_str_opt(&data, &["agent"]);
            part.subtask_model = pick_first(&data, &["model"]).map(|v| v.clone());
            part.subtask_command = pick_str_opt(&data, &["command"]);
            part.summary = Some(
                part.subtask_description
                    .clone()
                    .or_else(|| {
                        part.subtask_prompt
                            .as_ref()
                            .map(|p| truncate_chars(p, 40))
                    })
                    .unwrap_or_else(|| "[subtask]".to_string()),
            );
        }

        // ============ RetryPart ============
        "retry" => {
            part.retry_attempt = pick_i64(&data, &["attempt"]);
            let err_obj = pick_first(&data, &["error"]);
            part.retry_error = as_string_or_undef(err_obj);
            part.retry_time = pick_i64(&data, &["time.created"]);
            let attempt_str = part
                .retry_attempt
                .map(|a| a.to_string())
                .unwrap_or_else(|| "?".to_string());
            let error_str = part
                .retry_error
                .as_deref()
                .map(|s| truncate_chars(s, 50))
                .unwrap_or_else(|| "unknown error".to_string());
            part.summary = Some(format!("Retry attempt {}: {}", attempt_str, error_str));
        }

        // ============ CompactionPart ============
        "compaction" => {
            part.compaction_auto = pick_bool(&data, &["auto"]);
            part.compaction_overflow = pick_bool(&data, &["overflow"]);
            part.summary = Some(if part.compaction_auto == Some(false) {
                "手动压缩".to_string()
            } else if part.compaction_overflow == Some(true) {
                "压缩（溢出）".to_string()
            } else {
                "自动压缩".to_string()
            });
        }

        _ => {
            // Unknown part type — leave with base fields only
        }
    }

    part
}

// ─── Row mappers ──────────────────────────────────────────────────────────

fn map_message_row(row: &rusqlite::Row) -> rusqlite::Result<MessageDTO> {
    let id: String = row.get(0)?;
    let session_id: String = row.get(1)?;
    let role: String = row
        .get::<_, Option<String>>(2)?
        .unwrap_or_else(|| "user".to_string());
    let data_size: i64 = row.get::<_, Option<i64>>(3)?.unwrap_or(0);
    let time_created = row_get_time(row, 4)?;
    let content_preview: String = row.get::<_, Option<String>>(5)?.unwrap_or_default();
    Ok(MessageDTO {
        id,
        session_id,
        role,
        data_size,
        time_created,
        content: if content_preview.is_empty() {
            None
        } else {
            Some(content_preview)
        },
    })
}

// ─── Commands ─────────────────────────────────────────────────────────────

/// messages:list — paginated message list for a session.
///
/// Frontend calls: `invokeSafe('messages_list', { sessionId, page, pageSize })`
/// Tauri maps snake_case params to camelCase automatically.
#[tauri::command]
pub async fn messages_list(
    app: AppHandle,
    session_id: String,
    page: Option<i64>,
    page_size: Option<i64>,
) -> IpcResult<MessageListResult> {
    let db = app.state::<DbState>().clone_inner();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = match db::get_db(&db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };

        let page = page.unwrap_or(1).max(1);
        let page_size = page_size.unwrap_or(50).max(1);
        let offset = (page - 1) * page_size;

        // Count total
        let total: i64 = match conn.query_row(
            "SELECT COUNT(*) as cnt FROM message WHERE session_id = ?",
            rusqlite::params![&session_id],
            |row| row.get(0),
        ) {
            Ok(t) => t,
            Err(e) => return IpcResult::err(e.to_string()),
        };

        // Query messages — SQL copied verbatim from messages.ts
        let sql = r#"SELECT id, session_id, json_extract(data, '$.role') as role, LENGTH(data) as data_size, time_created,
                COALESCE(
                  (SELECT GROUP_CONCAT(json_extract(p.data, '$.text'), char(10) || char(10))
                   FROM part p
                   WHERE p.message_id = message.id AND json_extract(p.data, '$.type') = 'text'
                   ORDER BY p.id ASC),
                  json_extract(data, '$.content'),
                  json_extract(data, '$.text'),
                  ''
                ) as content_preview
        FROM message
        WHERE session_id = ?
        ORDER BY time_created ASC
        LIMIT ? OFFSET ?"#;

        let mut stmt = match conn.prepare(sql) {
            Ok(s) => s,
            Err(e) => return IpcResult::err(e.to_string()),
        };

        let rows = match stmt.query_map(rusqlite::params![&session_id, page_size, offset], map_message_row) {
            Ok(r) => r,
            Err(e) => return IpcResult::err(e.to_string()),
        };

        let mut messages = Vec::new();
        for row in rows {
            match row {
                Ok(m) => messages.push(m),
                Err(e) => return IpcResult::err(e.to_string()),
            }
        }

        IpcResult::ok(MessageListResult {
            data: messages,
            total,
            page,
            page_size,
        })
    })
    .await
    .unwrap_or_else(|e| IpcResult::err(format!("thread error: {}", e)))
}

/// messages:detail — single message with parsed parts.
///
/// Frontend calls: `invokeSafe('messages_detail', messageId)`
/// ipc.ts wraps single string arg as `{ value: messageId }`.
#[tauri::command]
pub async fn messages_detail(
    app: AppHandle,
    value: String,
) -> IpcResult<Option<MessageDetailDTO>> {
    let db = app.state::<DbState>().clone_inner();
    tauri::async_runtime::spawn_blocking(move || {
        let message_id = value;

        let conn = match db::get_db(&db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };

        // Get message — select specific columns (schema: id, session_id, data, time_created)
        let row = match conn.query_row(
            "SELECT id, session_id, data, time_created FROM message WHERE id = ?",
            rusqlite::params![&message_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    row_get_time(row, 3)?,
                ))
            },
        ) {
            Ok(r) => r,
            Err(rusqlite::Error::QueryReturnedNoRows) => return IpcResult::ok(None),
            Err(e) => return IpcResult::err(e.to_string()),
        };

        let (id, session_id, data_str, time_created) = row;

        // Parse content and role from data JSON
        let content;
        let mut role = "user".to_string();

        match serde_json::from_str::<serde_json::Value>(&data_str) {
            Ok(parsed) => {
                if parsed.is_string() {
                    content = parsed.as_str().unwrap_or("").to_string();
                } else {
                    // Object, array, number, etc.
                    if let Some(r) = parsed.get("role").and_then(|v| v.as_str()) {
                        role = r.to_string();
                    }
                    if let Some(c) = parsed.get("content") {
                        content = if let Some(s) = c.as_str() {
                            s.to_string()
                        } else {
                            serde_json::to_string_pretty(c).unwrap_or_default()
                        };
                    } else {
                        content = serde_json::to_string_pretty(&parsed).unwrap_or_default();
                    }
                }
            }
            Err(_) => {
                // Parse failed — use raw data string
                content = data_str.clone();
            }
        }

        let data_size = data_str.len() as i64;

        // Get parts — schema: id, message_id, session_id, data
        let mut stmt = match conn.prepare(
            "SELECT id, message_id, session_id, data FROM part WHERE message_id = ? ORDER BY id ASC",
        ) {
            Ok(s) => s,
            Err(e) => return IpcResult::err(e.to_string()),
        };

        let part_rows = match stmt.query_map(rusqlite::params![&message_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?.unwrap_or_default(),
            ))
        }) {
            Ok(r) => r,
            Err(e) => return IpcResult::err(e.to_string()),
        };

        let mut parts = Vec::new();
        for row in part_rows {
            match row {
                Ok((p_id, p_msg_id, p_sess_id, p_data)) => {
                    parts.push(parse_part_data(&p_id, &p_msg_id, &p_sess_id, &p_data));
                }
                Err(e) => return IpcResult::err(e.to_string()),
            }
        }

        IpcResult::ok(Some(MessageDetailDTO {
            id,
            session_id,
            role,
            data_size,
            time_created,
            content,
            parts,
        }))
    })
    .await
    .unwrap_or_else(|e| IpcResult::err(format!("thread error: {}", e)))
}

/// messages:list-by-parent — query messages across parent + child sessions.
///
/// Frontend calls: `invokeSafe('messages_list_by_parent', { parentSessionId, childSessionIds, page, pageSize })`
#[tauri::command]
pub async fn messages_list_by_parent(
    app: AppHandle,
    parent_session_id: Option<String>,
    child_session_ids: Option<Vec<String>>,
    page: Option<i64>,
    page_size: Option<i64>,
) -> IpcResult<MessageListResult> {
    let db = app.state::<DbState>().clone_inner();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = match db::get_db(&db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };

        let page = page.unwrap_or(1).max(1);
        let page_size = page_size.unwrap_or(50).max(1);
        let offset = (page - 1) * page_size;

        // Collect session IDs
        let mut session_ids: Vec<String> = Vec::new();
        if let Some(parent) = &parent_session_id {
            session_ids.push(parent.clone());
        }
        if let Some(children) = &child_session_ids {
            session_ids.extend(children.iter().cloned());
        }

        if session_ids.is_empty() {
            return IpcResult::ok(MessageListResult {
                data: Vec::new(),
                total: 0,
                page,
                page_size,
            });
        }

        // Build placeholders for IN clause
        let placeholders: String = session_ids
            .iter()
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(",");

        // Count total
        let count_sql = format!(
            "SELECT COUNT(*) as cnt FROM message WHERE session_id IN ({})",
            placeholders
        );
        let count_params: Vec<&dyn rusqlite::types::ToSql> = session_ids
            .iter()
            .map(|s| s as &dyn rusqlite::types::ToSql)
            .collect();
        let total: i64 = match conn.query_row(&count_sql, count_params.as_slice(), |row| row.get(0)) {
            Ok(t) => t,
            Err(e) => return IpcResult::err(e.to_string()),
        };

        // Query messages — SQL copied verbatim from messages.ts
        let query_sql = format!(
            r#"SELECT id, session_id, json_extract(data, '$.role') as role, LENGTH(data) as data_size, time_created,
                  COALESCE(
                    (SELECT GROUP_CONCAT(json_extract(p.data, '$.text'), char(10) || char(10))
                     FROM part p
                     WHERE p.message_id = message.id AND json_extract(p.data, '$.type') = 'text'
                     ORDER BY p.id ASC),
                    json_extract(data, '$.content'),
                    json_extract(data, '$.text'),
                    ''
                  ) as content_preview
           FROM message
           WHERE session_id IN ({})
           ORDER BY time_created ASC
           LIMIT ? OFFSET ?"#,
            placeholders
        );

        let mut stmt = match conn.prepare(&query_sql) {
            Ok(s) => s,
            Err(e) => return IpcResult::err(e.to_string()),
        };

        // Build params: session_ids + page_size + offset
        let mut query_params: Vec<&dyn rusqlite::types::ToSql> = session_ids
            .iter()
            .map(|s| s as &dyn rusqlite::types::ToSql)
            .collect();
        query_params.push(&page_size);
        query_params.push(&offset);

        let rows = match stmt.query_map(query_params.as_slice(), map_message_row) {
            Ok(r) => r,
            Err(e) => return IpcResult::err(e.to_string()),
        };

        let mut messages = Vec::new();
        for row in rows {
            match row {
                Ok(m) => messages.push(m),
                Err(e) => return IpcResult::err(e.to_string()),
            }
        }

        IpcResult::ok(MessageListResult {
            data: messages,
            total,
            page,
            page_size,
        })
    })
    .await
    .unwrap_or_else(|e| IpcResult::err(format!("thread error: {}", e)))
}

/// messages:search — LIKE full-text search on message content.
///
/// Frontend calls: `invokeSafe('messages_search', keyword)`
/// ipc.ts wraps single string arg as `{ value: keyword }`.
#[tauri::command]
pub async fn messages_search(
    app: AppHandle,
    value: String,
) -> IpcResult<Vec<SearchResult>> {
    let db = app.state::<DbState>().clone_inner();
    tauri::async_runtime::spawn_blocking(move || {
        let keyword = value;

        let conn = match db::get_db(&db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };

        if keyword.trim().is_empty() {
            return IpcResult::ok(Vec::new());
        }

        // SQL copied verbatim from messages.ts
        let sql = r#"
        SELECT m.id, m.session_id,
               json_extract(m.data, '$.content') as content,
               s.title as session_title,
               m.time_created
        FROM message m
        JOIN session s ON m.session_id = s.id
        WHERE json_extract(m.data, '$.content') LIKE ?
        ORDER BY m.time_created DESC
        LIMIT 100
    "#;

        let pattern = format!("%{}%", keyword);

        let mut stmt = match conn.prepare(sql) {
            Ok(s) => s,
            Err(e) => return IpcResult::err(e.to_string()),
        };

        let rows = match stmt.query_map(rusqlite::params![&pattern], |row| {
            let id: String = row.get(0)?;
            let session_id: String = row.get(1)?;
            let content: String = row.get::<_, Option<String>>(2)?.unwrap_or_default();
            let session_title: String = row.get::<_, Option<String>>(3)?.unwrap_or_default();
            let time_created = row_get_time(row, 4)?;
            Ok(SearchResult {
                id,
                session_id,
                content,
                session_title,
                time_created,
            })
        }) {
            Ok(r) => r,
            Err(e) => return IpcResult::err(e.to_string()),
        };

        let mut results = Vec::new();
        for row in rows {
            match row {
                Ok(r) => results.push(r),
                Err(e) => return IpcResult::err(e.to_string()),
            }
        }

        IpcResult::ok(results)
    })
    .await
    .unwrap_or_else(|e| IpcResult::err(format!("thread error: {}", e)))
}
