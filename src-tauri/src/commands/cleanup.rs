use rusqlite::ToSql;
use tauri::{AppHandle, Manager};

use crate::db::{self, DbState};
use crate::models::dto::{CleanupFilter, CleanupPreviewDTO, CleanupResultDTO, IpcResult, SessionDTO};

// ─── Filter construction from spread fields ────────────────────────────────
//
// 前端 Cleanup.tsx 直接传 CleanupFilter 对象作为 payload，ipc.ts 把它作为
// payload 字段直接传递。Tauri 自动 camelCase → snake_case 转换后匹配到下面
// 各命名参数。我们在命令入口处把它们重新组装成 CleanupFilter，复用既有逻辑。
fn build_filter(
    strategy: String,
    days: Option<i64>,
    size_m_b: Option<i64>,
    project_id: Option<String>,
    custom_where: Option<String>,
    excluded_session_ids: Option<Vec<String>>,
) -> CleanupFilter {
    CleanupFilter {
        strategy,
        days,
        size_mb: size_m_b,
        project_id,
        custom_where,
        excluded_session_ids,
    }
}

// ─── SQL Injection Protection ──────────────────────────────────────────────
// Mirrors electron/ipc/cleanup.ts DANGEROUS_PATTERNS + ALLOWED_PATTERN.
// Since regex is not in Cargo.toml, we use manual string matching.

/// Validate a custom WHERE clause to prevent SQL injection.
/// Returns false if any dangerous pattern is found or if the clause
/// contains characters outside the allowed set.
fn validate_custom_where(clause: &str) -> bool {
    // DANGEROUS_PATTERNS: ; -- /* and keywords DROP DELETE INSERT UPDATE ALTER
    if clause.contains(';') || clause.contains("--") || clause.contains("/*") {
        return false;
    }
    let upper = clause.to_uppercase();
    for keyword in &["DROP", "DELETE", "INSERT", "UPDATE", "ALTER"] {
        if contains_word(&upper, keyword) {
            return false;
        }
    }
    // ALLOWED_PATTERN: /^(?:[\s\w.'"(),%0-9]|AND|OR|LIKE|IN|NOT|IS|NULL|=|!=|>=|<=|<>|>|<)+$/i
    is_allowed_pattern(clause)
}

/// Check if text contains a keyword with word boundaries (case-insensitive).
fn contains_word(text: &str, keyword: &str) -> bool {
    let bytes = text.as_bytes();
    let kw = keyword.as_bytes();
    let kw_len = kw.len();
    if kw_len == 0 || bytes.len() < kw_len {
        return false;
    }
    for i in 0..=(bytes.len() - kw_len) {
        if &bytes[i..i + kw_len] == kw {
            let before_ok = i == 0 || !bytes[i - 1].is_ascii_alphanumeric();
            let after_idx = i + kw_len;
            let after_ok = after_idx >= bytes.len() || !bytes[after_idx].is_ascii_alphanumeric();
            if before_ok && after_ok {
                return true;
            }
        }
    }
    false
}

/// Check if the clause matches the ALLOWED_PATTERN:
/// only [\s\w.'"(),%0-9] chars and keywords AND OR LIKE IN NOT IS NULL
/// and operators = != >= <= <> > < are permitted.
fn is_allowed_pattern(clause: &str) -> bool {
    let bytes = clause.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i] as char;

        // Single-char allowed: \s \w . ' " ( ) , % 0-9
        // (\w = [A-Za-z0-9_])
        if c.is_ascii_whitespace()
            || c.is_ascii_alphanumeric()
            || c == '_'
            || c == '.'
            || c == '\''
            || c == '"'
            || c == '('
            || c == ')'
            || c == ','
            || c == '%'
        {
            i += 1;
            continue;
        }

        // Operators: = != >= <= <> > <
        if c == '=' || c == '>' || c == '<' {
            i += 1;
            continue;
        }
        if c == '!' && i + 1 < bytes.len() && bytes[i + 1] as char == '=' {
            i += 2;
            continue;
        }
        if (c == '>' || c == '<') && i + 1 < bytes.len() && bytes[i + 1] as char == '=' {
            i += 2;
            continue;
        }
        if c == '<' && i + 1 < bytes.len() && bytes[i + 1] as char == '>' {
            i += 2;
            continue;
        }

        // Keywords (case-insensitive): AND OR LIKE IN NOT IS NULL
        let rest = &clause[i..];
        let upper_rest = rest.to_uppercase();
        let mut matched = false;
        for kw in &["AND", "OR", "LIKE", "IN", "NOT", "IS", "NULL"] {
            if upper_rest.starts_with(kw) {
                let kw_len = kw.len();
                let after_idx = i + kw_len;
                // Word boundary: next char must not be alphanumeric
                if after_idx >= bytes.len() || !bytes[after_idx].is_ascii_alphanumeric() {
                    i += kw_len;
                    matched = true;
                    break;
                }
            }
        }
        if matched {
            continue;
        }

        return false;
    }
    true
}

// ─── WHERE Clause Builder ──────────────────────────────────────────────────

/// Build the WHERE clause for cleanup queries based on the filter strategy.
/// Returns (where_sql, params) where params is a list of bound values.
fn build_cleanup_where_clause(
    filter: &CleanupFilter,
) -> Result<(String, Vec<Box<dyn ToSql>>), String> {
    let mut conditions: Vec<String> = Vec::new();
    let mut params: Vec<Box<dyn ToSql>> = Vec::new();

    match filter.strategy.as_str() {
        "time" => {
            let days = filter.days.unwrap_or(30);
            let cutoff = chrono::Utc::now().timestamp_millis() - days * 24 * 60 * 60 * 1000;
            conditions.push("s.time_updated < ?".to_string());
            params.push(Box::new(cutoff));
        }
        "size" => {
            let size_bytes = filter.size_mb.unwrap_or(100) * 1024 * 1024;
            conditions.push("COALESCE(part_size.total, 0) > ?".to_string());
            params.push(Box::new(size_bytes));
        }
        "project" => {
            if let Some(ref project_id) = filter.project_id {
                conditions.push("s.project_id = ?".to_string());
                params.push(Box::new(project_id.clone()));
            }
        }
        "custom" => {
            if let Some(ref custom_where) = filter.custom_where {
                if !validate_custom_where(custom_where) {
                    return Err("Invalid custom WHERE clause".into());
                }
                conditions.push(custom_where.clone());
            }
        }
        _ => {}
    }

    // Exclude specified session IDs
    if let Some(ref excluded) = filter.excluded_session_ids {
        if !excluded.is_empty() {
            let placeholders = excluded.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            conditions.push(format!("s.id NOT IN ({})", placeholders));
            for id in excluded {
                params.push(Box::new(id.clone()));
            }
        }
    }

    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };

    Ok((where_clause, params))
}

// ─── Row Mappers ───────────────────────────────────────────────────────────

/// Read a time column that may be stored as integer (ms) or ISO string.
fn read_time_col(row: &rusqlite::Row, name: &str) -> i64 {
    if let Ok(v) = row.get::<_, i64>(name) {
        return v;
    }
    if let Ok(s) = row.get::<_, String>(name) {
        if let Ok(n) = s.parse::<i64>() {
            return n;
        }
        if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&s) {
            return dt.timestamp_millis();
        }
    }
    0
}

/// Map a rusqlite Row to a SessionDTO.
fn map_session_row(row: &rusqlite::Row) -> rusqlite::Result<SessionDTO> {
    Ok(SessionDTO {
        id: row.get("id")?,
        title: row.get::<_, Option<String>>("title")?.unwrap_or_default(),
        directory: row.get::<_, Option<String>>("directory")?,
        model: row.get::<_, Option<String>>("model")?,
        agent: row.get::<_, Option<String>>("agent")?,
        project_id: row.get::<_, Option<String>>("project_id")?,
        msg_count: row.get("msg_count").unwrap_or(0),
        total_tokens: row.get("total_tokens").unwrap_or(0),
        data_size: row.get("data_size").unwrap_or(0),
        tokens_input: row.get("tokens_input").unwrap_or(0),
        tokens_output: row.get("tokens_output").unwrap_or(0),
        tokens_reasoning: row.get("tokens_reasoning").unwrap_or(0),
        tokens_cache_read: row.get("tokens_cache_read").unwrap_or(0),
        tokens_cache_write: row.get("tokens_cache_write").unwrap_or(0),
        time_created: read_time_col(row, "time_created"),
        time_updated: read_time_col(row, "time_updated"),
        cost: row.get::<_, Option<f64>>("cost")?,
        child_count: None,
    })
}

// ─── Commands ──────────────────────────────────────────────────────────────

/// cleanup:preview — preview sessions matching the cleanup filter.
///
/// 前端调用：`invokeSafe('cleanup:preview', filter)` — filter 是对象，
/// ipc.ts 把它作为 payload 字段直接传递，Tauri 自动 camelCase → snake_case
/// 转换后匹配到下面的命名参数。
#[tauri::command]
pub async fn cleanup_preview(
    app: AppHandle,
    strategy: String,
    days: Option<i64>,
    size_m_b: Option<i64>,
    project_id: Option<String>,
    custom_where: Option<String>,
    excluded_session_ids: Option<Vec<String>>,
) -> IpcResult<CleanupPreviewDTO> {
    let db = app.state::<DbState>().clone_inner();
    tauri::async_runtime::spawn_blocking(move || {
        let filter = build_filter(strategy, days, size_m_b, project_id, custom_where, excluded_session_ids);
        let (where_clause, params) = match build_cleanup_where_clause(&filter) {
            Ok(v) => v,
            Err(e) => return IpcResult::err(e),
        };

        let conn = match db::get_db(&db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };

        let sql = format!(
            "SELECT s.*,
           COALESCE(msg_cnt.cnt, 0) as msg_count,
           (COALESCE(s.tokens_input, 0) + COALESCE(s.tokens_output, 0) + COALESCE(s.tokens_reasoning, 0)) as total_tokens,
           COALESCE(part_size.total, 0) as data_size
         FROM session s
         LEFT JOIN (SELECT session_id, COUNT(*) as cnt FROM message GROUP BY session_id) msg_cnt ON s.id = msg_cnt.session_id
         LEFT JOIN (SELECT session_id, SUM(LENGTH(data)) as total FROM part GROUP BY session_id) part_size ON s.id = part_size.session_id
         {}",
            where_clause
        );

        let params_refs: Vec<&dyn ToSql> = params.iter().map(|p| &**p).collect();

        let sessions: Vec<SessionDTO> = {
            let mut stmt = match conn.prepare(&sql) {
                Ok(s) => s,
                Err(e) => return IpcResult::err(e.to_string()),
            };
            let rows = match stmt.query_map(params_refs.as_slice(), map_session_row) {
                Ok(r) => r,
                Err(e) => return IpcResult::err(e.to_string()),
            };
            rows.filter_map(|r| r.ok()).collect()
        };

        if sessions.is_empty() {
            return IpcResult::ok(CleanupPreviewDTO {
                session_count: 0,
                message_count: 0,
                part_count: 0,
                estimated_size: 0,
                sessions: Vec::new(),
            });
        }

        let session_ids: Vec<String> = sessions.iter().map(|s| s.id.clone()).collect();
        let placeholders = session_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let id_params: Vec<&dyn ToSql> = session_ids.iter().map(|s| s as &dyn ToSql).collect();

        let message_count: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) as cnt FROM message WHERE session_id IN ({})", placeholders),
                id_params.as_slice(),
                |row| row.get(0),
            )
            .unwrap_or(0);

        let part_count: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) as cnt FROM part WHERE session_id IN ({})", placeholders),
                id_params.as_slice(),
                |row| row.get(0),
            )
            .unwrap_or(0);

        let estimated_size: i64 = conn
            .query_row(
                &format!(
                    "SELECT COALESCE(SUM(LENGTH(data)), 0) as total FROM part WHERE session_id IN ({})",
                    placeholders
                ),
                id_params.as_slice(),
                |row| row.get(0),
            )
            .unwrap_or(0);

        IpcResult::ok(CleanupPreviewDTO {
            session_count: sessions.len() as i64,
            message_count,
            part_count,
            estimated_size,
            sessions,
        })
    })
    .await
    .unwrap_or_else(|e| IpcResult::err(format!("thread error: {}", e)))
}

/// cleanup:execute — delete sessions matching the filter, then VACUUM.
///
/// 前端调用：`invokeSafe('cleanup:execute', filter)` — filter 是对象，
/// ipc.ts 把它作为 payload 字段直接传递，Tauri 自动 camelCase → snake_case
/// 转换后匹配到下面的命名参数。
#[tauri::command]
pub async fn cleanup_execute(
    app: AppHandle,
    strategy: String,
    days: Option<i64>,
    size_m_b: Option<i64>,
    project_id: Option<String>,
    custom_where: Option<String>,
    excluded_session_ids: Option<Vec<String>>,
) -> IpcResult<CleanupResultDTO> {
    let db = app.state::<DbState>().clone_inner();
    tauri::async_runtime::spawn_blocking(move || {
        let filter = build_filter(strategy, days, size_m_b, project_id, custom_where, excluded_session_ids);
        let (where_clause, params) = match build_cleanup_where_clause(&filter) {
            Ok(v) => v,
            Err(e) => return IpcResult::err(e),
        };

        let conn = match db::get_db(&db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };

        // Get matching session IDs
        let sql = format!("SELECT id FROM session s {}", where_clause);
        let params_refs: Vec<&dyn ToSql> = params.iter().map(|p| &**p).collect();

        let session_ids: Vec<String> = {
            let mut stmt = match conn.prepare(&sql) {
                Ok(s) => s,
                Err(e) => return IpcResult::err(e.to_string()),
            };
            let rows = match stmt.query_map(params_refs.as_slice(), |row| row.get::<_, String>(0)) {
                Ok(r) => r,
                Err(e) => return IpcResult::err(e.to_string()),
            };
            rows.filter_map(|r| r.ok()).collect()
        };

        if session_ids.is_empty() {
            return IpcResult::ok(CleanupResultDTO {
                deleted_sessions: 0,
                deleted_messages: 0,
                deleted_parts: 0,
                freed_bytes: 0,
                vacuum_before: 0,
                vacuum_after: 0,
            });
        }

        let placeholders = session_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let id_params: Vec<&dyn ToSql> = session_ids.iter().map(|s| s as &dyn ToSql).collect();

        // Get size before deletion
        let size_before: i64 = conn
            .query_row(
                &format!(
                    "SELECT COALESCE(SUM(LENGTH(data)), 0) as total FROM part WHERE session_id IN ({})",
                    placeholders
                ),
                id_params.as_slice(),
                |row| row.get(0),
            )
            .unwrap_or(0);

        // Delete in transaction: parts → messages → sessions (respect foreign keys)
        if let Err(e) = conn.execute_batch("BEGIN TRANSACTION") {
            return IpcResult::err(e.to_string());
        }

        let deleted_parts = match conn.execute(
            &format!("DELETE FROM part WHERE session_id IN ({})", placeholders),
            id_params.as_slice(),
        ) {
            Ok(n) => n as i64,
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                return IpcResult::err(e.to_string());
            }
        };

        let deleted_messages = match conn.execute(
            &format!("DELETE FROM message WHERE session_id IN ({})", placeholders),
            id_params.as_slice(),
        ) {
            Ok(n) => n as i64,
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                return IpcResult::err(e.to_string());
            }
        };

        let deleted_sessions = match conn.execute(
            &format!("DELETE FROM session WHERE id IN ({})", placeholders),
            id_params.as_slice(),
        ) {
            Ok(n) => n as i64,
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                return IpcResult::err(e.to_string());
            }
        };

        if let Err(e) = conn.execute_batch("COMMIT") {
            return IpcResult::err(e.to_string());
        }
        crate::commands::fork_stats::invalidate_cache();

        // VACUUM to reclaim space (must be outside a transaction)
        let current_path = match conn.path() {
            Some(p) => p.to_string(),
            None => return IpcResult::err("No database path"),
        };
        let vacuum_before = std::fs::metadata(&current_path)
            .ok()
            .map(|m| m.len() as i64)
            .unwrap_or(0);

        if let Err(e) = conn.execute_batch("VACUUM") {
            return IpcResult::err(e.to_string());
        }

        let vacuum_after = std::fs::metadata(&current_path)
            .ok()
            .map(|m| m.len() as i64)
            .unwrap_or(0);

        IpcResult::ok(CleanupResultDTO {
            deleted_sessions,
            deleted_messages,
            deleted_parts,
            freed_bytes: size_before,
            vacuum_before,
            vacuum_after,
        })
    })
    .await
    .unwrap_or_else(|e| IpcResult::err(format!("thread error: {}", e)))
}
