//! Sessions commands — migrated from electron/ipc/sessions.ts
//!
//! Implements 8 Tauri commands:
//!   - sessions_list, sessions_detail, sessions_projects, sessions_delete
//!   - session_share_get, sessions_rename, sessions_children, sessions_move
//!
//! Frontend IPC wrapping rules (see src/lib/ipc.ts):
//!   - 0 args        → no payload
//!   - 1 scalar arg  → payload = { value: arg }  → Rust uses `value: String`
//!   - 1 object arg  → payload = object itself    → Rust uses spread fields
//!   - 2+ args       → payload = { args: [...] }  → not used by sessions

use rusqlite::{Row, ToSql};
use serde::Serialize;
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use tauri::{AppHandle, Manager};

use crate::db::{self, DbState};
use crate::models::dto::{
    IpcResult, SessionDTO, SessionDetailDTO, SessionShareDTO, SkillUsage, TokenStats, ToolRanking,
};

// ─── Output / helper types ────────────────────────────────────────────────

/// Result of sessions_list — mirrors the Paginated<SessionDTO> shape
/// but the TS code returns a literal `{ data, total, page, pageSize }` object.
#[derive(Debug, Clone, Serialize)]
pub struct SessionListResult {
    pub data: Vec<SessionDTO>,
    pub total: i64,
    pub page: i64,
    #[serde(rename = "pageSize")]
    pub page_size: i64,
}

/// Result of sessions_delete — Electron returns `{ deleted, deletedParts, deletedMessages, deletedSessions }`.
/// Frontend only checks `.success` on the wrapper, but we keep the shape for parity.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDeleteResult {
    pub deleted: bool,
    pub deleted_parts: i64,
    pub deleted_messages: i64,
    pub deleted_sessions: i64,
}

/// Result of sessions_move.
#[derive(Debug, Clone, Serialize)]
pub struct SessionMoveResult {
    pub migrated: i64,
}

// Payload for sessions_rename — frontend sends `{ sessionId, title }`.
// Tauri maps camelCase keys to snake_case params automatically,
// so we use spread fields rather than a wrapper struct.
// (No struct needed — see sessions_rename signature.)
// ─── Row mappers ──────────────────────────────────────────────────────────

/// Map a session row to SessionDTO. Mirrors mapSessionRow in sessions.ts.
///
/// Column set expected (in order):
///   id, title, directory, model, agent, project_id,
///   total_tokens,
///   tokens_input, tokens_output, tokens_reasoning,
///   time_created, time_updated, cost
///
/// msg_count, data_size, child_count are set to 0 here and populated
/// by batch queries in sessions_list.
fn map_session_row(row: &Row) -> rusqlite::Result<SessionDTO> {
    let time_created: i64 = row.get("time_created")?;
    let time_updated: i64 = row.get("time_updated")?;
    Ok(SessionDTO {
        id: row.get("id")?,
        title: row.get::<_, Option<String>>("title")?.unwrap_or_default(),
        directory: row.get("directory")?,
        model: row.get("model")?,
        agent: row.get("agent")?,
        project_id: row.get("project_id")?,
        msg_count: 0,         // populated by batch query
        total_tokens: row.get("total_tokens")?,
        data_size: 0,         // populated by batch query
        tokens_input: row.get("tokens_input")?,
        tokens_output: row.get("tokens_output")?,
        tokens_reasoning: row.get("tokens_reasoning")?,
        time_created,
        time_updated,
        cost: row.get("cost")?,
        child_count: None,    // populated by batch query
    })
}

// ─── WHERE clause builder ─────────────────────────────────────────────────

/// Build WHERE clause and parameters for session list queries.
/// Extracted from sessions_list so both COUNT and data queries share the same logic.
fn build_session_where(
    conn: &rusqlite::Connection,
    search: &Option<String>,
    project_id: &Option<String>,
    start_date: &Option<String>,
    end_date: &Option<String>,
    parent_filter: &Option<String>,
) -> (String, Vec<Box<dyn ToSql>>) {
    let mut conditions: Vec<String> = Vec::new();
    let mut params: Vec<Box<dyn ToSql>> = Vec::new();

    if let Some(s) = search {
        conditions.push("(s.title LIKE ? OR s.id LIKE ?)".to_string());
        params.push(Box::new(format!("%{}%", s)));
        params.push(Box::new(format!("%{}%", s)));
    }
    if let Some(p) = project_id {
        conditions.push("s.directory = ?".to_string());
        params.push(Box::new(p.clone()));
    }
    if let Some(sd) = start_date {
        conditions.push("date(s.time_created / 1000, 'unixepoch') >= ?".to_string());
        params.push(Box::new(sd.clone()));
    }
    if let Some(ed) = end_date {
        conditions.push("date(s.time_created / 1000, 'unixepoch') <= ?".to_string());
        params.push(Box::new(ed.clone()));
    }

    if check_parent_column(conn) {
        match parent_filter.as_deref() {
            Some("children") => conditions.push("s.parent_id IS NOT NULL".to_string()),
            None | Some("root") => conditions.push("s.parent_id IS NULL".to_string()),
            Some("all") => {}
            _ => conditions.push("s.parent_id IS NULL".to_string()),
        }
    }

    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };

    (where_clause, params)
}

// ─── Parent column detection ──────────────────────────────────────────────

/// Check whether the session table has a parent_id column.
/// Cached for the lifetime of the process via a OnceLock.
fn check_parent_column(conn: &rusqlite::Connection) -> bool {
    use std::sync::OnceLock;
    static FLAG: OnceLock<bool> = OnceLock::new();
    if let Some(v) = FLAG.get() {
        return *v;
    }
    let has = match conn.prepare("PRAGMA table_info(session)") {
        Ok(mut stmt) => {
            let rows = match stmt.query_map([], |r| r.get::<_, String>(1)) {
                Ok(rs) => rs,
                Err(_) => return false,
            };
            let mut found = false;
            for name in rows.flatten() {
                if name == "parent_id" {
                    found = true;
                    break;
                }
            }
            found
        }
        Err(_) => false,
    };
    let _ = FLAG.set(has);
    has
}

// ─── Commands ─────────────────────────────────────────────────────────────

/// sessions:list — paginated session list.
///
/// Frontend calls: `invokeSafe('sessions:list', filter)`
/// Tauri auto-maps camelCase keys to snake_case params.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn sessions_list(
    app: AppHandle,
    search: Option<String>,
    project_id: Option<String>,
    sort_by: Option<String>,
    sort_order: Option<String>,
    page: Option<i64>,
    page_size: Option<i64>,
    start_date: Option<String>,
    end_date: Option<String>,
    parent_filter: Option<String>,
) -> IpcResult<SessionListResult> {
    let db = app.state::<DbState>().clone_inner();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = match db::get_db(&db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };

        let page = page.unwrap_or(1).max(1);
        let page_size = page_size.unwrap_or(50).clamp(1, 200);
        let offset = (page - 1) * page_size;
        let sort_by = sort_by.unwrap_or_else(|| "time_updated".to_string());
        let sort_order = sort_order.unwrap_or_else(|| "desc".to_string());

        // Build WHERE clause using extracted helper
        let (where_clause, params) = build_session_where(
            &conn, &search, &project_id, &start_date, &end_date, &parent_filter,
        );

        // Validate sort column (SQL injection prevention)
        let allowed_sort_columns = [
            "time_created",
            "time_updated",
            "title",
            "cost",
            "tokens_input",
            "tokens_output",
            "total_tokens",
        ];
        let safe_sort_by = if allowed_sort_columns.contains(&sort_by.as_str()) {
            sort_by.as_str()
        } else {
            "time_updated"
        };
        let safe_sort_order = if sort_order == "asc" { "ASC" } else { "DESC" };
        // total_tokens is still a computed expression in SQL (no s. prefix);
        // msg_count, data_size, childCount are batch-fetched, so not sortable via SQL.
        let computed_columns = ["total_tokens"];
        let order_expr = if computed_columns.contains(&safe_sort_by) {
            safe_sort_by.to_string()
        } else {
            format!("s.{}", safe_sort_by)
        };

        // Count total
        let count_sql = format!("SELECT COUNT(*) as cnt FROM session s {}", where_clause);
        let param_refs: Vec<&dyn ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let total: i64 = match conn.query_row(&count_sql, param_refs.as_slice(), |r| r.get(0)) {
            Ok(t) => t,
            Err(e) => return IpcResult::err(e.to_string()),
        };

        // Query rows — simple SELECT without heavy subqueries
        // msg_count, data_size, childCount are fetched via batch queries below.
        let list_sql = format!(
            "SELECT s.id, s.title, s.directory, s.model, s.agent, s.project_id, \
             COALESCE(s.tokens_input, 0) as tokens_input, \
             COALESCE(s.tokens_output, 0) as tokens_output, \
             COALESCE(s.tokens_reasoning, 0) as tokens_reasoning, \
             COALESCE(s.tokens_cache_read, 0) as tokens_cache_read, \
             COALESCE(s.tokens_cache_write, 0) as tokens_cache_write, \
             s.cost, s.time_created, s.time_updated, \
             (COALESCE(s.tokens_input, 0) + COALESCE(s.tokens_output, 0) + COALESCE(s.tokens_reasoning, 0)) as total_tokens \
             FROM session s \
             {} ORDER BY {} {} LIMIT ? OFFSET ?",
            where_clause, order_expr, safe_sort_order
        );

        let mut all_params: Vec<Box<dyn ToSql>> = params;
        all_params.push(Box::new(page_size));
        all_params.push(Box::new(offset));
        let param_refs: Vec<&dyn ToSql> = all_params.iter().map(|p| p.as_ref()).collect();

        let mut stmt = match conn.prepare(&list_sql) {
            Ok(s) => s,
            Err(e) => return IpcResult::err(e.to_string()),
        };
        let rows = match stmt.query_map(param_refs.as_slice(), map_session_row) {
            Ok(r) => r,
            Err(e) => return IpcResult::err(e.to_string()),
        };
        let mut data = Vec::new();
        for r in rows {
            match r {
                Ok(dto) => data.push(dto),
                Err(e) => return IpcResult::err(e.to_string()),
            }
        }

        // Batch-fetch childCount, msg_count, and data_size for all returned sessions
        if !data.is_empty() {
            let ids: Vec<String> = data.iter().map(|d| d.id.clone()).collect();
            let id_placeholders: Vec<String> = ids.iter().map(|_| "?".to_string()).collect();
            let id_list = id_placeholders.join(",");

            // childCount: how many children each session has
            let child_sql = format!(
                "SELECT parent_id, COUNT(*) FROM session WHERE parent_id IN ({}) GROUP BY parent_id",
                id_list
            );
            let child_map: HashMap<String, i64> = {
                let mut stmt = match conn.prepare(&child_sql) {
                    Ok(s) => s,
                    Err(e) => return IpcResult::err(e.to_string()),
                };
                let id_params: Vec<&dyn ToSql> = ids.iter().map(|id| id as &dyn ToSql).collect();
                let rows = match stmt.query_map(id_params.as_slice(), |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
                }) {
                    Ok(r) => r,
                    Err(e) => return IpcResult::err(e.to_string()),
                };
                rows.filter_map(|r| r.ok()).collect()
            };
            for dto in data.iter_mut() {
                dto.child_count = child_map.get(&dto.id).copied();
            }

            // msg_count: messages per session (via IN clause, not full table scan)
            let msg_sql = format!(
                "SELECT session_id, COUNT(*) FROM message WHERE session_id IN ({}) GROUP BY session_id",
                id_list
            );
            let msg_map: HashMap<String, i64> = {
                let mut stmt = match conn.prepare(&msg_sql) {
                    Ok(s) => s,
                    Err(e) => return IpcResult::err(e.to_string()),
                };
                let id_params: Vec<&dyn ToSql> = ids.iter().map(|id| id as &dyn ToSql).collect();
                let rows = match stmt.query_map(id_params.as_slice(), |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
                }) {
                    Ok(r) => r,
                    Err(e) => return IpcResult::err(e.to_string()),
                };
                rows.filter_map(|r| r.ok()).collect()
            };
            for dto in data.iter_mut() {
                dto.msg_count = msg_map.get(&dto.id).copied().unwrap_or(0);
            }

            // data_size: total part data per session (via IN clause)
            let part_sql = format!(
                "SELECT session_id, COALESCE(SUM(LENGTH(data)), 0) FROM part WHERE session_id IN ({}) GROUP BY session_id",
                id_list
            );
            let part_map: HashMap<String, i64> = {
                let mut stmt = match conn.prepare(&part_sql) {
                    Ok(s) => s,
                    Err(e) => return IpcResult::err(e.to_string()),
                };
                let id_params: Vec<&dyn ToSql> = ids.iter().map(|id| id as &dyn ToSql).collect();
                let rows = match stmt.query_map(id_params.as_slice(), |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
                }) {
                    Ok(r) => r,
                    Err(e) => return IpcResult::err(e.to_string()),
                };
                rows.filter_map(|r| r.ok()).collect()
            };
            for dto in data.iter_mut() {
                dto.data_size = part_map.get(&dto.id).copied().unwrap_or(0);
            }
        }

        IpcResult::ok(SessionListResult {
            data,
            total,
            page,
            page_size,
        })
    })
    .await
    .unwrap_or_else(|e| IpcResult::err(format!("thread error: {}", e)))
}

/// sessions:detail — full session detail with token stats, tool ranking, skill list.
///
/// Frontend calls: `invokeSafe('sessions:detail', sessionId)`
/// ipc.ts wraps single string arg as `{ value: sessionId }`.
#[tauri::command]
pub async fn sessions_detail(app: AppHandle, value: String) -> IpcResult<Option<SessionDetailDTO>> {
    let db = app.state::<DbState>().clone_inner();
    tauri::async_runtime::spawn_blocking(move || {
        let session_id = value;

        let conn = match db::get_db(&db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };

        // Get session base info
        let sql = "SELECT s.id, s.title, s.directory, s.model, s.agent, s.project_id, \
                   COALESCE(s.tokens_input, 0) as tokens_input, \
                   COALESCE(s.tokens_output, 0) as tokens_output, \
                   COALESCE(s.tokens_reasoning, 0) as tokens_reasoning, \
                   COALESCE(s.tokens_cache_read, 0) as tokens_cache_read, \
                   COALESCE(s.tokens_cache_write, 0) as tokens_cache_write, \
                   s.cost, s.time_created, s.time_updated, \
                   COALESCE(msg_cnt.cnt, 0) as msg_count, \
                   (COALESCE(s.tokens_input, 0) + COALESCE(s.tokens_output, 0) + COALESCE(s.tokens_reasoning, 0)) as total_tokens, \
                   COALESCE(part_size.total, 0) as data_size, \
                   0 as childCount \
                   FROM session s \
                   LEFT JOIN (SELECT session_id, COUNT(*) as cnt FROM message GROUP BY session_id) msg_cnt ON s.id = msg_cnt.session_id \
                   LEFT JOIN (SELECT session_id, SUM(LENGTH(data)) as total FROM part GROUP BY session_id) part_size ON s.id = part_size.session_id \
                   WHERE s.id = ?";
        let session = match conn.query_row(sql, rusqlite::params![&session_id], map_session_row) {
            Ok(s) => s,
            Err(rusqlite::Error::QueryReturnedNoRows) => return IpcResult::ok(None),
            Err(e) => return IpcResult::err(e.to_string()),
        };

        // Token stats — from part table step-finish (real per-call usage)
        let token_stats_row = match conn.query_row(
            "SELECT \
               COALESCE(SUM(json_extract(data, '$.tokens.input')), 0) as inputTokens, \
               COALESCE(SUM(json_extract(data, '$.tokens.output')), 0) as outputTokens, \
               COALESCE(SUM(json_extract(data, '$.tokens.reasoning')), 0) as reasoningTokens, \
               COALESCE(SUM(json_extract(data, '$.tokens.cache.read')), 0) as cacheRead, \
               COALESCE(SUM(json_extract(data, '$.tokens.cache.write')), 0) as cacheWrite, \
               COALESCE(SUM(json_extract(data, '$.cost')), 0) as estimatedCost \
             FROM part \
             WHERE session_id = ? AND json_extract(data, '$.type') = 'step-finish'",
            rusqlite::params![&session_id],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, f64>(5)?,
                ))
            },
        ) {
            Ok(r) => r,
            Err(e) => return IpcResult::err(e.to_string()),
        };
        let (input_tokens, output_tokens, reasoning_tokens, cache_read, cache_write, estimated_cost) =
            token_stats_row;
        let total_tokens = input_tokens + output_tokens + reasoning_tokens;
        let cache_reuse_rate = if total_tokens > 0 {
            let rate = (cache_read as f64 / total_tokens as f64) * 100.0;
            (rate * 100.0).round() / 100.0
        } else {
            0.0
        };

        let token_stats = TokenStats {
            input_tokens,
            output_tokens,
            reasoning_tokens,
            cache_read,
            cache_write,
            estimated_cost,
            cache_reuse_rate,
        };

        // Tool ranking
        let mut stmt = match conn.prepare(
            "SELECT json_extract(data, '$.tool') as toolName, COUNT(*) as count \
             FROM part \
             WHERE session_id = ? AND json_extract(data, '$.type') = 'tool' \
               AND json_extract(data, '$.tool') IS NOT NULL \
             GROUP BY toolName ORDER BY count DESC",
        ) {
            Ok(s) => s,
            Err(e) => return IpcResult::err(e.to_string()),
        };
        let tool_rows = match stmt.query_map(rusqlite::params![&session_id], |r| {
            Ok(ToolRanking {
                tool_name: r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                count: r.get(1)?,
            })
        }) {
            Ok(r) => r,
            Err(e) => return IpcResult::err(e.to_string()),
        };
        let mut tool_ranking = Vec::new();
        for r in tool_rows {
            match r {
                Ok(t) => tool_ranking.push(t),
                Err(e) => return IpcResult::err(e.to_string()),
            }
        }

        // Skill ranking
        let mut stmt = match conn.prepare(
            "SELECT json_extract(data, '$.state.input.name') as skillName, COUNT(*) as count \
             FROM part \
             WHERE session_id = ? AND json_extract(data, '$.type') = 'tool' \
               AND json_extract(data, '$.tool') = 'skill' \
               AND json_extract(data, '$.state.input.name') IS NOT NULL \
             GROUP BY skillName ORDER BY count DESC",
        ) {
            Ok(s) => s,
            Err(e) => return IpcResult::err(e.to_string()),
        };
        let skill_rows = match stmt.query_map(rusqlite::params![&session_id], |r| {
            Ok(SkillUsage {
                skill_name: r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                count: r.get(1)?,
            })
        }) {
            Ok(r) => r,
            Err(e) => return IpcResult::err(e.to_string()),
        };
        let mut skill_ranking = Vec::new();
        for r in skill_rows {
            match r {
                Ok(s) => skill_ranking.push(s),
                Err(e) => return IpcResult::err(e.to_string()),
            }
        }
 
         let detail = SessionDetailDTO {
             session,
             token_stats,
             tool_ranking,
             skill_ranking,
         };

        IpcResult::ok(Some(detail))
    })
    .await
    .unwrap_or_else(|e| IpcResult::err(format!("thread error: {}", e)))
}

/// sessions:projects — list distinct project directories.
#[tauri::command]
pub async fn sessions_projects(app: AppHandle) -> IpcResult<Vec<String>> {
    let db = app.state::<DbState>().clone_inner();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = match db::get_db(&db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };

        let mut stmt = match conn.prepare(
            "SELECT DISTINCT directory FROM session WHERE directory IS NOT NULL AND directory != '' ORDER BY directory",
        ) {
            Ok(s) => s,
            Err(e) => return IpcResult::err(e.to_string()),
        };
        let rows = match stmt.query_map([], |r| r.get::<_, String>(0)) {
            Ok(r) => r,
            Err(e) => return IpcResult::err(e.to_string()),
        };
        let mut result = Vec::new();
        for r in rows {
            match r {
                Ok(s) => result.push(s),
                Err(e) => return IpcResult::err(e.to_string()),
            }
        }
        IpcResult::ok(result)
    })
    .await
    .unwrap_or_else(|e| IpcResult::err(format!("thread error: {}", e)))
}

/// sessions:delete — delete a session and its messages/parts.
///
/// Frontend calls: `invokeSafe('sessions:delete', id)`
/// ipc.ts wraps single string arg as `{ value: id }`.
#[tauri::command]
pub async fn sessions_delete(app: AppHandle, value: String) -> IpcResult<SessionDeleteResult> {
    let db = app.state::<DbState>().clone_inner();
    tauri::async_runtime::spawn_blocking(move || {
        let session_id = value;

        let conn = match db::get_db(&db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };

        // Use a transaction — Electron used 3 separate run() calls; we keep the
        // same logical order but wrap in a transaction for atomicity.
        if conn.execute_batch("BEGIN TRANSACTION").is_err() {
            return IpcResult::err("Failed to begin transaction");
        }

        let part_changes = match conn.execute(
            "DELETE FROM part WHERE session_id = ?",
            rusqlite::params![&session_id],
        ) {
            Ok(n) => n as i64,
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                return IpcResult::err(e.to_string());
            }
        };
        let msg_changes = match conn.execute(
            "DELETE FROM message WHERE session_id = ?",
            rusqlite::params![&session_id],
        ) {
            Ok(n) => n as i64,
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                return IpcResult::err(e.to_string());
            }
        };
        let sess_changes = match conn.execute(
            "DELETE FROM session WHERE id = ?",
            rusqlite::params![&session_id],
        ) {
            Ok(n) => n as i64,
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                return IpcResult::err(e.to_string());
            }
        };

        if conn.execute_batch("COMMIT").is_err() {
            let _ = conn.execute_batch("ROLLBACK");
            return IpcResult::err("Failed to commit transaction");
        }

        IpcResult::ok(SessionDeleteResult {
            deleted: sess_changes > 0,
            deleted_parts: part_changes,
            deleted_messages: msg_changes,
            deleted_sessions: sess_changes,
        })
    })
    .await
    .unwrap_or_else(|e| IpcResult::err(format!("thread error: {}", e)))
}

/// session-share:get — get share info for a session.
///
/// Frontend calls: `invokeSafe('session-share:get', sessionId)`
/// ipc.ts wraps single string arg as `{ value: sessionId }`.
#[tauri::command]
pub async fn session_share_get(app: AppHandle, value: String) -> IpcResult<Option<SessionShareDTO>> {
    let db = app.state::<DbState>().clone_inner();
    tauri::async_runtime::spawn_blocking(move || {
        let session_id = value;

        let conn = match db::get_db(&db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };

        // TS type uses snake_case field names (session_id, time_created) — keep as-is.
        let row = conn
            .query_row(
                "SELECT session_id, id, secret, url, time_created FROM session_share WHERE session_id = ?",
                rusqlite::params![&session_id],
                |r| {
                    Ok(SessionShareDTO {
                        session_id: r.get(0)?,
                        id: r.get(1)?,
                        secret: r.get(2)?,
                        url: r.get(3)?,
                        time_created: r.get(4)?,
                    })
                },
            )
            .ok();

        IpcResult::ok(row)
    })
    .await
    .unwrap_or_else(|e| IpcResult::err(format!("thread error: {}", e)))
}

/// sessions:rename — update a session's title.
///
/// Frontend calls: `invokeSafe('sessions:rename', { sessionId, title })`
/// Tauri maps camelCase keys to snake_case params automatically.
#[tauri::command]
pub async fn sessions_rename(
    app: AppHandle,
    session_id: String,
    title: String,
) -> IpcResult<bool> {
    let db = app.state::<DbState>().clone_inner();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = match db::get_db(&db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };

        match conn.execute(
            "UPDATE session SET title = ? WHERE id = ?",
            rusqlite::params![&title, &session_id],
        ) {
            Ok(_) => IpcResult::ok(true),
            Err(e) => IpcResult::err(e.to_string()),
        }
    })
    .await
    .unwrap_or_else(|e| IpcResult::err(format!("thread error: {}", e)))
}

/// sessions:children — list child sessions of a parent.
///
/// Frontend calls: `invokeSafe('sessions:children', activeSessionId)`
/// ipc.ts wraps single string arg as `{ value: activeSessionId }`.
#[tauri::command]
pub async fn sessions_children(app: AppHandle, value: String) -> IpcResult<Vec<SessionDTO>> {
    let db = app.state::<DbState>().clone_inner();
    tauri::async_runtime::spawn_blocking(move || {
        let session_id = value;

        let conn = match db::get_db(&db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };

        if !check_parent_column(&conn) {
            return IpcResult::ok(Vec::new());
        }

        let sql = "SELECT s.id, s.title, s.directory, s.model, s.agent, s.project_id, \
                   COALESCE(s.tokens_input, 0) as tokens_input, \
                   COALESCE(s.tokens_output, 0) as tokens_output, \
                   COALESCE(s.tokens_reasoning, 0) as tokens_reasoning, \
                   COALESCE(s.tokens_cache_read, 0) as tokens_cache_read, \
                   COALESCE(s.tokens_cache_write, 0) as tokens_cache_write, \
                   s.cost, s.time_created, s.time_updated, \
                   COALESCE(msg_cnt.cnt, 0) as msg_count, \
                   (COALESCE(s.tokens_input, 0) + COALESCE(s.tokens_output, 0) + COALESCE(s.tokens_reasoning, 0)) as total_tokens, \
                   COALESCE(part_size.total, 0) as data_size, \
                   0 as childCount \
                   FROM session s \
                   LEFT JOIN (SELECT session_id, COUNT(*) as cnt FROM message GROUP BY session_id) msg_cnt ON s.id = msg_cnt.session_id \
                   LEFT JOIN (SELECT session_id, SUM(LENGTH(data)) as total FROM part GROUP BY session_id) part_size ON s.id = part_size.session_id \
                   WHERE s.parent_id = ? \
                   ORDER BY s.time_created ASC";
        let mut stmt = match conn.prepare(sql) {
            Ok(s) => s,
            Err(e) => return IpcResult::err(e.to_string()),
        };
        let rows = match stmt.query_map(rusqlite::params![&session_id], map_session_row) {
            Ok(r) => r,
            Err(e) => return IpcResult::err(e.to_string()),
        };
        let mut result = Vec::new();
        for r in rows {
            match r {
                Ok(dto) => result.push(dto),
                Err(e) => return IpcResult::err(e.to_string()),
            }
        }
        IpcResult::ok(result)
    })
    .await
    .unwrap_or_else(|e| IpcResult::err(format!("thread error: {}", e)))
}

/// sessions:move — migrate sessions to a new directory.
///
/// Frontend calls: `invokeSafe('sessions:move', { sessionIds, directory })`
/// Tauri maps camelCase keys to snake_case params automatically.
#[tauri::command]
pub async fn sessions_move(
    app: AppHandle,
    session_ids: Vec<String>,
    directory: String,
) -> IpcResult<SessionMoveResult> {
    let db = app.state::<DbState>().clone_inner();
    tauri::async_runtime::spawn_blocking(move || {
        if session_ids.is_empty() {
            return IpcResult::ok(SessionMoveResult { migrated: 0 });
        }

        let conn = match db::get_db(&db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };

        // Resolve directory (path::resolve equivalent)
        let n = fs::canonicalize(&directory)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| directory.clone());

        let p = compute_project_id(&n);

        // Ensure project row exists before updating session.project_id (FK constraint)
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM project WHERE id = ?",
                rusqlite::params![&p],
                |r| r.get(0),
            )
            .ok();

        if existing.is_none() {
            let now = chrono::Utc::now().timestamp_millis();
            let name = Path::new(&n)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| n.clone());
            if let Err(e) = conn.execute(
                "INSERT INTO project (id, worktree, name, time_created, time_updated, sandboxes, commands) VALUES (?, ?, ?, ?, ?, ?, ?)",
                rusqlite::params![&p, &n, &name, now, now, "[]", "[]"],
            ) {
                return IpcResult::err(e.to_string());
            }
        }

        // Build placeholders for IN clause
        let placeholders: Vec<String> = session_ids.iter().map(|_| "?".to_string()).collect();
        let placeholders = placeholders.join(",");
        let sql = format!(
            "UPDATE session SET directory = ?, project_id = ? WHERE id IN ({}) AND parent_id IS NULL",
            placeholders
        );

        let mut params: Vec<Box<dyn ToSql>> = Vec::new();
        params.push(Box::new(n.clone()));
        params.push(Box::new(p.clone()));
        for id in &session_ids {
            params.push(Box::new(id.clone()));
        }
        let param_refs: Vec<&dyn ToSql> = params.iter().map(|p| p.as_ref()).collect();

        match conn.execute(&sql, param_refs.as_slice()) {
            Ok(n) => IpcResult::ok(SessionMoveResult { migrated: n as i64 }),
            Err(e) => IpcResult::err(e.to_string()),
        }
    })
    .await
    .unwrap_or_else(|e| IpcResult::err(format!("thread error: {}", e)))
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/// Compute a project ID from a directory path.
///
/// Mirrors electron/ipc/sessions.ts::computeProjectId:
///   1. Try to read .git/HEAD
///   2. If it starts with "ref:", read the referenced file (e.g. .git/refs/heads/main)
///   3. Otherwise use the HEAD content directly
///   4. On any failure, fall back to sha1(dir)
fn compute_project_id(dir: &str) -> String {
    let head_path = Path::new(dir).join(".git").join("HEAD");
    if let Ok(c) = fs::read_to_string(&head_path) {
        let c = c.trim();
        if c.starts_with("ref:") {
            let ref_name = c[5..].trim();
            let ref_path = Path::new(dir).join(".git").join(ref_name);
            if let Ok(ref_content) = fs::read_to_string(&ref_path) {
                return ref_content.trim().to_string();
            }
        }
        return c.to_string();
    }
    // Fallback: sha1(dir)
    let mut hasher = Sha1::new();
    hasher.update(dir.as_bytes());
    hex::encode(hasher.finalize())
}
