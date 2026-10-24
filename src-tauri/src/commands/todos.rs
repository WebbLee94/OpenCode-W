//! Todos commands — migrated from electron/ipc/todos.ts
//!
//! Implements 1 Tauri command:
//!   - todos_by_parent
//!
//! Frontend IPC wrapping rules (see src/lib/ipc.ts):
//!   - 1 object arg → payload = object itself → Rust uses spread fields
//!
//! v1 库从 `todo` 表读取；v2 形态（fresh / mixed）没有待办表，待办由
//! assistant 消息里的 `todowrite` 工具调用推导（见 `compat::todos`）。

use rusqlite::Row;
use tauri::{AppHandle, Manager};

use crate::compat;
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

/// 旧表待办查询（SQL 与 1.3.5 逐字一致，仅参数化方式不变）。
fn legacy_todos(
    conn: &rusqlite::Connection,
    session_ids: &[String],
) -> Result<Vec<TodoDTO>, String> {
    if session_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders: Vec<String> = session_ids.iter().map(|_| "?".to_string()).collect();
    let placeholders = placeholders.join(",");
    let sql = format!(
        "SELECT t.*, s.title as session_title \
         FROM todo t \
         JOIN session s ON t.session_id = s.id \
         WHERE t.session_id IN ({}) \
         ORDER BY t.session_id ASC, t.position ASC",
        placeholders
    );

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let params: Vec<&dyn rusqlite::ToSql> = session_ids
        .iter()
        .map(|id| id as &dyn rusqlite::ToSql)
        .collect();
    let rows = stmt
        .query_map(params.as_slice(), map_todo_row)
        .map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for row in rows {
        result.push(row.map_err(|e| e.to_string())?);
    }
    Ok(result)
}

/// v2 待办由 `todowrite` 推导；旧 `todo` 表只在纯 v1 库读取。
fn collect_todos(
    conn: &rusqlite::Connection,
    env: &compat::Env,
    session_ids: &[String],
) -> Result<Vec<TodoDTO>, String> {
    let mut result = Vec::new();

    // v2 会话：从最后一次 todowrite 调用推导。
    let v2_set = if env.is_v2() {
        compat::v2_session_ids_in(conn, session_ids).map_err(|e| e.to_string())?
    } else {
        std::collections::BTreeSet::new()
    };
    if !v2_set.is_empty() {
        let v2_ids: Vec<String> = session_ids
            .iter()
            .filter(|id| v2_set.contains(*id))
            .cloned()
            .collect();
        result.extend(compat::todos::list_v2(conn, &v2_ids)?);
    }

    // v2-only 收口：v2 形态不再读旧 `todo` 表（迁移留给 OpenCode）；
    // 只在纯 v1 库沿用旧表查询。
    let legacy_ids: Vec<String> = session_ids
        .iter()
        .filter(|id| !v2_set.contains(*id) && !env.is_v2())
        .cloned()
        .collect();
    if !legacy_ids.is_empty() && !env.is_v2() {
        result.extend(legacy_todos(conn, &legacy_ids)?);
    }

    result.sort_by(|left, right| {
        left.session_id
            .cmp(&right.session_id)
            .then(left.position.cmp(&right.position))
    });
    Ok(result)
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
    let state = app.state::<DbState>();
    let schema = state.schema();
    let db = state.clone_inner();
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

        let conn = match db::get_db(&db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };

        let env = compat::env(&conn, schema.as_ref());
        let result = match collect_todos(&conn, &env, &all_ids) {
            Ok(todos) => todos,
            Err(e) => return IpcResult::err(e),
        };

        IpcResult::ok(result)
    })
    .await
    .unwrap_or_else(|e| IpcResult::err(format!("thread error: {}", e)))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::collect_todos;
    use crate::compat::test_support::{
        insert_legacy_session, insert_v2_message, insert_v2_session, open_env, v2_mixed,
    };
    use crate::compat::env;

    /// v2-only 收口：混合库只从 v2 消息推导待办；
    /// 旧 `todo` 表与 legacy-only 会话不再是 OpenCode-W 的读对象。
    #[test]
    fn mixed_database_derives_v2_todos_only() {
        let conn = v2_mixed();
        conn.execute_batch(
            "CREATE TABLE main.todo (
                session_id TEXT NOT NULL,
                position INTEGER NOT NULL,
                content TEXT NOT NULL,
                status TEXT NOT NULL,
                priority TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL
            );",
        )
        .expect("legacy todo table creates");

        insert_v2_session(&conn, "ses_v2_todo", Some("v2 待办会话"));
        let todowrite = json!({
            "content": [{
                "type": "tool",
                "id": "call_todo",
                "name": "todowrite",
                "state": {
                    "status": "completed",
                    "input": {"todos": [{"content": "v2 任务", "status": "in_progress", "priority": "high"}]}
                }
            }]
        })
        .to_string();
        insert_v2_message(&conn, "msg_v2_todo", "ses_v2_todo", "assistant", 0, 10, &todowrite);

        insert_legacy_session(&conn, "ses_old_todo");
        conn.execute(
            "INSERT INTO main.todo (session_id, position, content, status, priority, time_created, time_updated)
             VALUES ('ses_old_todo', 0, '旧任务', 'pending', 'low', 1, 1)",
            [],
        )
        .expect("legacy todo inserts");

        let info = open_env(&conn);
        let compat = env(&conn, Some(&info));
        let todos = collect_todos(
            &conn,
            &compat,
            &["ses_v2_todo".to_string(), "ses_old_todo".to_string()],
        )
        .expect("todos collect");

        assert_eq!(todos.len(), 1, "legacy todo 行不再读取");
        assert_eq!(todos[0].session_id, "ses_v2_todo");
        assert_eq!(todos[0].content, "v2 任务");
        assert_eq!(todos[0].status, "in_progress");
        assert_eq!(todos[0].priority, "high");
    }

    #[test]
    fn v2_fresh_database_without_todo_table_returns_only_derived_todos() {
        let conn = v2_mixed();
        conn.execute_batch("DROP TABLE message; DROP TABLE part; DROP TABLE session;")
            .expect("legacy tables drop");
        insert_v2_session(&conn, "ses_v2_only", Some("v2"));
        let todowrite = json!({
            "content": [{
                "type": "tool",
                "id": "call_todo",
                "name": "todowrite",
                "state": {
                    "status": "completed",
                    "input": {"todos": [{"content": "唯一任务", "status": "pending"}]}
                }
            }]
        })
        .to_string();
        insert_v2_message(&conn, "msg_only", "ses_v2_only", "assistant", 0, 10, &todowrite);

        let info = open_env(&conn);
        assert_eq!(info.mode, crate::schema::SchemaMode::V2Fresh);
        let compat = env(&conn, Some(&info));
        let todos =
            collect_todos(&conn, &compat, &["ses_v2_only".to_string()]).expect("todos collect");

        assert_eq!(todos.len(), 1);
        assert_eq!(todos[0].content, "唯一任务");
        assert_eq!(todos[0].priority, "medium", "缺失 priority 填 medium");
    }
}
