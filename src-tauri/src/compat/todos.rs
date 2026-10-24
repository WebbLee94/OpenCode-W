//! v2 待办推导：从 `todowrite` 工具调用还原 `TodoDTO`。
//!
//! v2 没有 `todo` 表，待办写在 assistant 消息内容块的
//! `state.input.todos`（个别实现写在 `state.output.todos`）。取**最后一次**
//! `todowrite` 调用，因为它是该会话的最终待办快照。
//!
//! 字段容错（TASK-016）：
//! - `priority` 缺失或非法 → `medium`；
//! - `status` 非法 → `pending`；
//! - 没有 `content` 的条目丢弃（渲染层无法展示空行）。

use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;

use crate::models::dto::TodoDTO;

use super::v2_session_title;

/// 合法状态值，与前端 `TODO_STATUS_*` 及 v1 `todo.status` 取值一致。
const TODO_STATUSES: [&str; 4] = ["pending", "in_progress", "completed", "cancelled"];
/// 合法优先级。
const TODO_PRIORITIES: [&str; 3] = ["high", "medium", "low"];

/// 最后一次 `todowrite` 调用（`seq` 是会话内单调序号，`c.key` 定位块内顺序）。
const LAST_TODOWRITE_SQL: &str = r#"
SELECT sm.time_created, sm.time_updated, c.value
FROM main.session_message AS sm,
     json_each(sm.data, '$.content') AS c
WHERE sm.session_id = ?1
  AND json_extract(c.value, '$.type') = 'tool'
  AND json_extract(c.value, '$.name') = 'todowrite'
ORDER BY sm.time_created DESC, sm.seq DESC, c.key DESC
LIMIT 1
"#;

/// 从 v2 会话推导待办；返回顺序为 `(session_id, position)`，与 v1 SQL 一致。
pub fn list_v2(conn: &Connection, session_ids: &[String]) -> Result<Vec<TodoDTO>, String> {
    let mut todos = Vec::new();

    for session_id in session_ids {
        let title = v2_session_title(conn, session_id)
            .map_err(|e| e.to_string())?
            .unwrap_or_default();

        let row = conn
            .query_row(LAST_TODOWRITE_SQL, [session_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .optional()
            .map_err(|e| e.to_string())?;

        let Some((time_created, time_updated, block)) = row else {
            continue;
        };
        let block: Value = serde_json::from_str(&block).unwrap_or(Value::Null);

        for (position, todo) in extract_todos(&block).into_iter().enumerate() {
            todos.push(TodoDTO {
                session_id: session_id.clone(),
                position: position as i64,
                content: todo.content,
                status: normalize_status(&todo.status),
                priority: normalize_priority(&todo.priority),
                time_created,
                time_updated,
                session_title: title.clone(),
            });
        }
    }

    todos.sort_by(|left, right| {
        left.session_id
            .cmp(&right.session_id)
            .then(left.position.cmp(&right.position))
    });

    Ok(todos)
}

struct RawTodo {
    content: String,
    status: String,
    priority: String,
}

/// `state.input.todos` 优先，缺失时退回 `state.output.todos`。
fn extract_todos(block: &Value) -> Vec<RawTodo> {
    let items = block
        .pointer("/state/input/todos")
        .or_else(|| block.pointer("/state/output/todos"))
        .and_then(Value::as_array);

    let Some(items) = items else {
        return Vec::new();
    };

    items
        .iter()
        .filter_map(|item| {
            let content = item.get("content").and_then(Value::as_str)?;
            if content.is_empty() {
                return None;
            }
            Some(RawTodo {
                content: content.to_string(),
                status: item
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                priority: item
                    .get("priority")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            })
        })
        .collect()
}

fn normalize_status(status: &str) -> String {
    if TODO_STATUSES.contains(&status) {
        status.to_string()
    } else {
        String::from("pending")
    }
}

fn normalize_priority(priority: &str) -> String {
    if TODO_PRIORITIES.contains(&priority) {
        priority.to_string()
    } else {
        String::from("medium")
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::list_v2;
    use crate::compat::test_support::{
        insert_v2_message, insert_v2_session, open_env, v2_mixed,
    };

    fn todowrite(todos: serde_json::Value) -> String {
        json!({
            "content": [
                {"type": "reasoning", "text": "整理任务"},
                {
                    "type": "tool",
                    "id": "call_todo",
                    "name": "todowrite",
                    "state": {"status": "completed", "input": {"todos": todos}, "content": []}
                }
            ]
        })
        .to_string()
    }

    #[test]
    fn last_todowrite_call_wins_and_fields_are_normalized() {
        let conn = v2_mixed();
        insert_v2_session(&conn, "ses_todo", None);
        insert_v2_message(
            &conn,
            "msg_old",
            "ses_todo",
            "assistant",
            0,
            100,
            &todowrite(json!([{"content": "旧任务", "status": "pending", "priority": "low"}])),
        );
        insert_v2_message(
            &conn,
            "msg_new",
            "ses_todo",
            "assistant",
            1,
            200,
            &todowrite(json!([
                {"content": "写代码", "status": "in_progress", "priority": "high"},
                {"content": "缺优先级", "status": "completed"},
                {"content": "非法状态", "status": "doing", "priority": "urgent"},
                {"content": "", "status": "pending"}
            ])),
        );
        open_env(&conn);

        let todos = list_v2(&conn, &["ses_todo".to_string()]).expect("todos derive");

        assert_eq!(todos.len(), 3, "空 content 被丢弃");
        assert_eq!(todos[0].content, "写代码");
        assert_eq!(todos[0].status, "in_progress");
        assert_eq!(todos[0].priority, "high");
        assert_eq!(todos[0].position, 0);
        assert_eq!(todos[1].priority, "medium", "priority 缺失填 medium");
        assert_eq!(todos[2].status, "pending", "非法 status 降级 pending");
        assert_eq!(todos[2].priority, "medium", "非法 priority 降级 medium");
        assert_eq!(todos[0].session_title, "slug-ses_todo", "title 为空回退 slug");
        assert_eq!(todos[0].time_created, 200, "取最后一次调用的消息时间");
    }

    #[test]
    fn session_without_todowrite_has_no_todos() {
        let conn = v2_mixed();
        insert_v2_session(&conn, "ses_plain", Some("普通会话"));
        insert_v2_message(&conn, "msg_plain", "ses_plain", "user", 0, 10, r#"{"text":"hi"}"#);
        open_env(&conn);

        assert!(list_v2(&conn, &["ses_plain".to_string()])
            .expect("todos derive")
            .is_empty());
    }

    #[test]
    fn output_todos_are_used_when_input_is_missing() {
        let conn = v2_mixed();
        insert_v2_session(&conn, "ses_out", Some("输出待办"));
        let data = json!({
            "content": [{
                "type": "tool",
                "id": "call_out",
                "name": "todowrite",
                "state": {
                    "status": "completed",
                    "output": {"todos": [{"content": "输出里的任务", "status": "pending", "priority": "low"}]}
                }
            }]
        });
        insert_v2_message(&conn, "msg_out", "ses_out", "assistant", 0, 10, &data.to_string());
        open_env(&conn);

        let todos = list_v2(&conn, &["ses_out".to_string()]).expect("todos derive");
        assert_eq!(todos.len(), 1);
        assert_eq!(todos[0].content, "输出里的任务");
        assert_eq!(todos[0].priority, "low");
    }
}
