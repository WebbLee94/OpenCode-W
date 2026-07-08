//! Todos commands — migrated from electron/ipc/todos.ts
//!
//! Implements 1 Tauri command:
//!   - todos_by_parent
//!
//! Frontend IPC wrapping rules (see src/lib/ipc.ts):
//!   - 1 object arg → payload = object itself → Rust uses spread fields

use rusqlite::Row;
use tauri::{AppHandle, Manager};

use crate::db::{self, DbState};
use crate::models::dto::{IpcResult, TodoDTO};

// ─── Row mapper ───────────────────────────────────────────────────────────

/// Map a todo row to TodoDTO. Mirrors the SELECT in todos.ts.
///
/// TS type uses snake_case field names — keep as-is.
fn map_todo_row(row: &Row) -> rusqlite::Result<TodoDTO> {
    Ok(TodoDTO {
        session_id: row.get("session_id")?,
        position: row.get("position")?,
        content: row.get("content")?,
        status: row.get("status")?,
        priority: row.get("priority")?,
        time_created: row.get("time_created")?,
        time_updated: row.get("time_updated")?,
        session_title: row.get("session_title")?,
    })
}

// ─── Commands ─────────────────────────────────────────────────────────────

/// todos:by-parent — merge parent + child sessions' todos.
///
/// Frontend calls: `invokeSafe('todos:by-parent', { parentSessionId, childSessionIds })`
/// Tauri maps camelCase keys to snake_case params automatically.
///
/// When `child_session_ids` is empty or None, only the parent's todos are queried.
#[tauri::command]
pub async fn todos_by_parent(
    app: AppHandle,
    parent_session_id: String,
    child_session_ids: Option<Vec<String>>,
) -> IpcResult<Vec<TodoDTO>> {
    let db = app.state::<DbState>().clone_inner();
    tauri::async_runtime::spawn_blocking(move || {
        // Build deduplicated ID list (parent + children)
        let mut all_ids: Vec<String> = Vec::new();
        all_ids.push(parent_session_id);
        if let Some(child) = child_session_ids {
            for id in child {
                if !all_ids.contains(&id) {
                    all_ids.push(id);
                }
            }
        }

        if all_ids.is_empty() {
            return IpcResult::ok(Vec::new());
        }

        let lock = match db::get_db(&db) {
            Ok(l) => l,
            Err(e) => return IpcResult::err(e),
        };
        let conn = match lock.as_ref() {
            Some(c) => c,
            None => return IpcResult::err("No database open"),
        };

        // Build placeholders for IN (?) clause
        let placeholders: Vec<String> = all_ids.iter().map(|_| "?".to_string()).collect();
        let placeholders = placeholders.join(",");
        let sql = format!(
            "SELECT t.*, s.title as session_title \
             FROM todo t \
             JOIN session s ON t.session_id = s.id \
             WHERE t.session_id IN ({}) \
             ORDER BY t.session_id ASC, t.position ASC",
            placeholders
        );

        let mut stmt = match conn.prepare(&sql) {
            Ok(s) => s,
            Err(e) => return IpcResult::err(e.to_string()),
        };

        // Bind params
        let params: Vec<&dyn rusqlite::ToSql> = all_ids
            .iter()
            .map(|id| id as &dyn rusqlite::ToSql)
            .collect();

        let rows = match stmt.query_map(params.as_slice(), map_todo_row) {
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
