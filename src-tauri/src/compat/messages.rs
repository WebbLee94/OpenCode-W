//! v2 消息读取：方言解析 + `session_message` 分页。
//!
//! 三条硬约束（实施计划 TASK-009 ~ TASK-014）：
//!
//! 1. **v2-only 收口**：消息只读 `session_message`。迁移后留在旧表里的副本
//!    （同 id 冻结行 / 尾消息 / legacy-only 会话）不再是 OpenCode-W 的读对象
//!    ——v1 → v2 迁移由 OpenCode 自己负责。
//! 2. **类型默认安全**：`session_message.type` 只把 user / assistant / system /
//!    synthetic / compaction 当展示行，其余（idle / model-switched /
//!    agent-switched / 未来新增类型）只计入统计，不参与列表分页（LIMIT/OFFSET
//!    与 total 都只看可见行）；`CASE` 一律带 `ELSE 'system'` 兜底，不 panic
//!    （Q-03 / E-15）。
//! 3. **v1 零改动**：库是 v1 或会话只存在于旧表时返回 `Ok(None)`，由调用方继续
//!    执行原有 SQL。

use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;

use crate::commands::messages::{MessageDetailDTO, MessageListResult};
use crate::models::dto::MessageDTO;

use super::{json_array, parts, v2_session_ids_in, Dialect, Env};

/// 展示层可见的 v2 消息类型（其余只计入统计，不参与列表分页）。
/// 生产路径的隐藏逻辑由 SQL 的 `visible` 列完成，这里的白名单供单测断言口径。
#[cfg(test)]
const VISIBLE_TYPES: [&str; 5] = ["user", "assistant", "system", "synthetic", "compaction"];

/// v2 消息分页主体。参数：?1 会话 id（JSON 数组）、?4 LIMIT、?5 OFFSET。
///
/// `role` 的 `CASE` 必须带 `ELSE 'system'`：未知类型不得让查询失败或 panic。
const V2_PAGE_SELECT: &str = r#"
SELECT sm.id AS id,
       sm.session_id AS session_id,
       CASE sm.type
         WHEN 'user' THEN 'user'
         WHEN 'assistant' THEN 'assistant'
         WHEN 'system' THEN 'system'
         WHEN 'synthetic' THEN 'system'
         WHEN 'compaction' THEN 'system'
         ELSE 'system'
       END AS role,
       LENGTH(sm.data) AS data_size,
       sm.time_created AS time_created,
       COALESCE(
         (SELECT GROUP_CONCAT(substr(json_extract(c.value, '$.text'), 1, 200), char(10) || char(10))
          FROM json_each(sm.data, '$.content') AS c
          WHERE json_extract(c.value, '$.type') = 'text'),
         json_extract(sm.data, '$.text'),
         ''
       ) AS preview,
       CASE sm.type
         WHEN 'user' THEN 1
         WHEN 'assistant' THEN 1
         WHEN 'system' THEN 1
         WHEN 'synthetic' THEN 1
         WHEN 'compaction' THEN 1
         ELSE 0
       END AS visible
FROM main.session_message AS sm
WHERE sm.session_id IN (SELECT value FROM json_each(?1))
"#;

// 已迁移会话的旧表尾消息与 legacy-only 会话合并已随 v2-only 收口取消
// （v2 模式不再读 `main.message` / `main.part`）。

/// 单会话消息分页。
///
/// 返回 `Ok(None)` 表示「不是 v2 方言」——调用方继续走原有 v1 SQL。
pub fn list(
    conn: &Connection,
    env: &Env,
    session_id: &str,
    page: i64,
    page_size: i64,
) -> Result<Option<MessageListResult>, String> {
    if !env.is_v2() || super::resolve_dialect(conn, session_id).map_err(|e| e.to_string())? != Dialect::V2
    {
        return Ok(None);
    }

    let v2_ids = vec![session_id.to_string()];
    let request = PageRequest { v2_ids: &v2_ids };

    Ok(Some(page_result(conn, &request, page, page_size)?))
}

/// 父会话 + 子会话的消息分页（混合方言时按会话分别取数后归并）。
///
/// 返回 `Ok(None)` 表示所有会话都是 legacy 方言，调用方沿用原有 v1 SQL。
pub fn list_by_parent(
    conn: &Connection,
    env: &Env,
    session_ids: &[String],
    page: i64,
    page_size: i64,
) -> Result<Option<MessageListResult>, String> {
    if !env.is_v2() || session_ids.is_empty() {
        return Ok(None);
    }

    let v2_set = v2_session_ids_in(conn, session_ids).map_err(|e| e.to_string())?;
    if v2_set.is_empty() {
        return Ok(None);
    }
    let v2_ids: Vec<String> = session_ids
        .iter()
        .filter(|id| v2_set.contains(*id))
        .cloned()
        .collect();

    let request = PageRequest { v2_ids: &v2_ids };

    Ok(Some(page_result(conn, &request, page, page_size)?))
}

/// 单条 v2 消息详情（含内容块与合成 step-finish）。
///
/// 返回 `Ok(None)` 表示 v2 表里没有这个 id（可能是旧表尾消息或已删除），
/// 调用方决定是否回退到 v1 读取。
pub fn detail(conn: &Connection, message_id: &str) -> Result<Option<MessageDetailDTO>, String> {
    let row = conn
        .query_row(
            "SELECT session_id, type, data, time_created \
             FROM main.session_message WHERE id = ?1",
            [message_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let Some((session_id, message_type, data_str, time_created)) = row else {
        return Ok(None);
    };

    let data: Value = serde_json::from_str(&data_str).unwrap_or(Value::Null);

    Ok(Some(MessageDetailDTO {
        id: message_id.to_string(),
        session_id: session_id.clone(),
        role: role_for_type(&message_type).to_string(),
        data_size: data_str.len() as i64,
        time_created,
        content: parts::message_text(&data),
        parts: parts::map_message(message_id, &session_id, &message_type, &data),
    }))
}

/// v2 消息类型 → 展示角色。未知类型折叠为 `system`（与 SQL 的 `CASE` 一致）。
pub fn role_for_type(message_type: &str) -> &'static str {
    match message_type {
        "user" => "user",
        "assistant" => "assistant",
        _ => "system",
    }
}

/// 该 v2 消息类型是否应在展示层出现（其余类型只计入统计）。
#[cfg(test)]
pub fn is_visible_type(message_type: &str) -> bool {
    VISIBLE_TYPES.contains(&message_type)
}

struct PageRequest<'a> {
    v2_ids: &'a [String],
}

fn page_result(
    conn: &Connection,
    request: &PageRequest<'_>,
    page: i64,
    page_size: i64,
) -> Result<MessageListResult, String> {
    let page = page.max(1);
    let page_size = page_size.clamp(1, 200);
    let offset = (page - 1) * page_size;

    let total = count_rows(conn, request)?;
    let rows = fetch_page(conn, request, page_size, offset)?;

    // 分页 SQL 已按 `visible = 1` 过滤，这里只作防御性兜底：
    // 即使将来有人误改 SQL，隐藏类型也不会泄漏到展示层。
    let data: Vec<MessageDTO> = rows
        .into_iter()
        .filter(|(_, visible)| *visible)
        .map(|(dto, _)| dto)
        .collect();

    Ok(MessageListResult {
        data,
        total,
        page,
        page_size,
    })
}

fn count_rows(conn: &Connection, request: &PageRequest<'_>) -> Result<i64, String> {
    if request.v2_ids.is_empty() {
        return Ok(0);
    }
    conn.query_row(
        // 白名单而非黑名单：未来新增的未知类型默认隐藏、不参与分页计数。
        "SELECT COUNT(*) FROM main.session_message \
         WHERE session_id IN (SELECT value FROM json_each(?1)) \
           AND type IN ('user', 'assistant', 'system', 'synthetic', 'compaction')",
        [json_array(request.v2_ids)],
        |row| row.get::<_, i64>(0),
    )
    .map_err(|e| e.to_string())
}

fn fetch_page(
    conn: &Connection,
    request: &PageRequest<'_>,
    limit: i64,
    offset: i64,
) -> Result<Vec<(MessageDTO, bool)>, String> {
    if request.v2_ids.is_empty() {
        return Ok(Vec::new());
    }

    let sql = format!(
        "SELECT id, session_id, role, data_size, time_created, preview, visible FROM (\n\
         {V2_PAGE_SELECT}\
         \n) WHERE visible = 1\nORDER BY time_created ASC, id ASC LIMIT ?2 OFFSET ?3"
    );

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            rusqlite::params![json_array(request.v2_ids), limit, offset],
            |row| {
                let preview: String = row.get::<_, Option<String>>(5)?.unwrap_or_default();
                let dto = MessageDTO {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    role: row.get(2)?,
                    data_size: row.get(3)?,
                    time_created: row.get(4)?,
                    content: if preview.is_empty() {
                        None
                    } else {
                        Some(preview)
                    },
                };
                let visible: i64 = row.get(6)?;
                Ok((dto, visible != 0))
            },
        )
        .map_err(|e| e.to_string())?;

    let mut messages = Vec::new();
    for row in rows {
        messages.push(row.map_err(|e| e.to_string())?);
    }
    Ok(messages)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{detail, is_visible_type, list, list_by_parent, role_for_type};
    use crate::compat::test_support::{
        insert_legacy_message, insert_legacy_part, insert_legacy_session, insert_v2_message,
        insert_v2_session, open_env, v2_mixed,
    };
    use crate::compat::{env, v2_share};

    fn assistant_data(text: &str, tokens: (i64, i64, i64, i64, i64), cost: f64) -> String {
        json!({
            "content": [{"type": "text", "text": text}],
            "finish": "stop",
            "tokens": {
                "input": tokens.0, "output": tokens.1, "reasoning": tokens.2,
                "cache": {"read": tokens.3, "write": tokens.4}
            },
            "cost": cost
        })
        .to_string()
    }

    /// v2 会话 4 条消息（含 idle / model-switched / 未知类型）+ 2 条旧表尾消息，
    /// 其中 1 条旧表消息与 v2 同 id（必须去重）。
    fn fixture() -> (rusqlite::Connection, crate::schema::SchemaInfo) {
        let conn = v2_mixed();
        insert_v2_session(&conn, "ses_both", Some("迁移会话"));
        insert_legacy_session(&conn, "ses_both");

        insert_v2_message(&conn, "msg_00", "ses_both", "user", 0, 100, r#"{"text":"迁移前提问"}"#);
        insert_v2_message(
            &conn,
            "msg_01",
            "ses_both",
            "assistant",
            1,
            110,
            &assistant_data("迁移前回答", (10, 2, 1, 3, 4), 0.5),
        );
        insert_v2_message(&conn, "msg_02", "ses_both", "idle", 2, 120, r#"{"outcome":"failed"}"#);
        insert_v2_message(
            &conn,
            "msg_03",
            "ses_both",
            "model-switched",
            3,
            130,
            r#"{"model":{"id":"next"}}"#,
        );
        insert_v2_message(&conn, "msg_04", "ses_both", "future-type", 4, 140, r#"{}"#);
        insert_v2_message(&conn, "msg_05", "ses_both", "assistant", 5, 150, &assistant_data("v2 新回答", (20, 5, 0, 0, 0), 0.25));

        // 旧表：1 条与 v2 同 id（去重）、2 条尾消息
        insert_legacy_message(&conn, "msg_01", "ses_both", 110, "assistant");
        insert_legacy_part(&conn, "p_dup", "msg_01", "ses_both", r#"{"type":"text","text":"旧表重复行"}"#);
        insert_legacy_message(&conn, "msg_tail_a", "ses_both", 160, "assistant");
        insert_legacy_part(
            &conn,
            "p_tail_a",
            "msg_tail_a",
            "ses_both",
            r#"{"type":"text","text":"尾消息 A"}"#,
        );
        insert_legacy_message(&conn, "msg_tail_b", "ses_both", 170, "user");
        insert_legacy_part(
            &conn,
            "p_tail_b",
            "msg_tail_b",
            "ses_both",
            r#"{"type":"text","text":"尾消息 B"}"#,
        );

        let info = open_env(&conn);
        (conn, info)
    }

    #[test]
    fn mixed_legacy_copies_are_not_merged_into_v2_pages() {
        let (conn, info) = fixture();
        let compat = env(&conn, Some(&info));

        let result = list(&conn, &compat, "ses_both", 1, 50)
            .expect("v2 list runs")
            .expect("ses_both 是 v2 会话");

        // v2-only 收口：total = 3 条可见 v2 消息；旧表副本（同 id 行 + 尾消息）不合并。
        assert_eq!(result.total, 3);

        let ids: Vec<&str> = result.data.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["msg_00", "msg_01", "msg_05"]);
        assert_eq!(result.data[1].role, "assistant");
    }

    #[test]
    fn hidden_message_types_are_counted_but_not_returned() {
        let (conn, info) = fixture();
        let compat = env(&conn, Some(&info));

        let result = list(&conn, &compat, "ses_both", 1, 50)
            .expect("v2 list runs")
            .expect("v2 会话");

        let returned = result.data.iter().map(|m| m.id.as_str()).collect::<Vec<_>>();
        for hidden in ["msg_02", "msg_03", "msg_04"] {
            assert!(!returned.contains(&hidden), "{hidden} 必须隐藏");
        }
        assert!(result.total > 0, "可见消息仍有总数");
        assert_eq!(
            result.total,
            returned.len() as i64,
            "隐藏类型不计入列表 total"
        );

        assert!(!is_visible_type("idle"));
        assert!(!is_visible_type("agent-switched"));
        assert!(!is_visible_type("unknown-future"));
        assert!(is_visible_type("synthetic"));
        assert_eq!(role_for_type("agent-switched"), "system");
        assert_eq!(role_for_type("synthetic"), "system");
    }

    /// 3 条可见 v2 消息，分页槽位只对 v2 行生效；旧表副本不参与分页。
    #[test]
    fn pagination_is_stable_across_v2_rows() {
        let (conn, info) = fixture();
        let compat = env(&conn, Some(&info));

        let first = list(&conn, &compat, "ses_both", 1, 2)
            .expect("page 1")
            .expect("v2 会话");
        let second = list(&conn, &compat, "ses_both", 2, 2)
            .expect("page 2")
            .expect("v2 会话");
        let third = list(&conn, &compat, "ses_both", 3, 2)
            .expect("page 3")
            .expect("v2 会话");

        for page in [&first, &second] {
            assert_eq!(page.total, 3, "total 只数可见行（隐藏类型不占槽位）");
        }
        // 隐藏类型不参与分页：3 条可见行按 2/1 连续翻页，没有空白页。
        assert_eq!(
            first.data.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["msg_00", "msg_01"]
        );
        assert_eq!(
            second.data.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["msg_05"]
        );
        assert!(third.data.is_empty(), "越界页自然为空");
    }

    #[test]
    fn hidden_types_do_not_consume_page_slots() {
        let conn = v2_mixed();
        insert_v2_session(&conn, "ses_paged", Some("分页会话"));
        insert_legacy_session(&conn, "ses_paged");

        // 20 条 v2 消息，其中 3 条隐藏类型（idle / model-switched / 未知）。
        for seq in 0..20_i64 {
            let (kind, payload) = match seq {
                4 => ("idle", r#"{"outcome":"failed"}"#.to_string()),
                11 => ("model-switched", r#"{"model":"x"}"#.to_string()),
                18 => ("unknown-future", r#"{"raw":true}"#.to_string()),
                _ if seq % 2 == 0 => ("user", r#"{"text":"提问"}"#.to_string()),
                _ => (
                    "assistant",
                    r#"{"content":[{"type":"text","text":"回答"}]}"#.to_string(),
                ),
            };
            insert_v2_message(
                &conn,
                &format!("msg_{seq:02}"),
                "ses_paged",
                kind,
                seq,
                100 + seq,
                &payload,
            );
        }
        // 迁移后旧客户端追加的 2 条尾消息（v2-only：不再合并进列表）。
        insert_legacy_message(&conn, "tail_00", "ses_paged", 200, "user");
        insert_legacy_message(&conn, "tail_01", "ses_paged", 201, "user");

        let info = open_env(&conn);
        let compat = env(&conn, Some(&info));

        let first = list(&conn, &compat, "ses_paged", 1, 10)
            .expect("page 1")
            .expect("v2 会话");
        let second = list(&conn, &compat, "ses_paged", 2, 10)
            .expect("page 2")
            .expect("v2 会话");

        // 17 条可见 v2 消息（3 条隐藏不计）；尾消息不再合并。
        assert_eq!(first.total, 17);
        assert_eq!(second.total, 17);
        assert_eq!(first.data.len(), 10);
        assert_eq!(second.data.len(), 7, "第二页必须是 7 条，而不是空白页");
        assert!(
            first.data.iter().chain(second.data.iter()).all(|m| !m.id.starts_with("tail_")),
            "旧表尾消息不再进入消息列表"
        );

        let mut ids: Vec<&str> = first
            .data
            .iter()
            .chain(second.data.iter())
            .map(|m| m.id.as_str())
            .collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 17, "两页无重复、无遗漏");
        for hidden in ["msg_04", "msg_11", "msg_18"] {
            assert!(!ids.contains(&hidden), "{hidden} 必须隐藏且不占槽位");
        }
    }

    #[test]
    fn legacy_only_session_is_delegated_to_the_v1_path() {
        let (conn, info) = fixture();
        insert_legacy_session(&conn, "ses_legacy_only");
        insert_legacy_message(&conn, "legacy_msg", "ses_legacy_only", 500, "user");
        let compat = env(&conn, Some(&info));

        assert!(list(&conn, &compat, "ses_legacy_only", 1, 50)
            .expect("list runs")
            .is_none());
        assert!(list(&conn, &compat, "ses_missing", 1, 50)
            .expect("list runs")
            .is_none());
    }

    #[test]
    fn parent_list_merges_v2_sessions_and_skips_legacy_sessions() {
        let (conn, info) = fixture();
        insert_v2_session(&conn, "ses_child_v2", Some("子会话"));
        insert_v2_message(&conn, "child_msg", "ses_child_v2", "user", 0, 115, r#"{"text":"子会话提问"}"#);
        insert_legacy_session(&conn, "ses_child_legacy");
        insert_legacy_message(&conn, "child_legacy_msg", "ses_child_legacy", 118, "user");
        let compat = env(&conn, Some(&info));

        let sessions = vec![
            "ses_both".to_string(),
            "ses_child_v2".to_string(),
            "ses_child_legacy".to_string(),
        ];
        let result = list_by_parent(&conn, &compat, &sessions, 1, 50)
            .expect("list runs")
            .expect("存在 v2 会话时由 compat 处理");

        // v2-only 收口：3 条可见父消息 + 1 条 v2 子消息；legacy 子会话不合并。
        assert_eq!(result.total, 4);
        let ids: Vec<&str> = result.data.iter().map(|m| m.id.as_str()).collect();
        assert!(ids.contains(&"child_msg"));
        assert!(!ids.contains(&"child_legacy_msg"), "legacy 子会话正文不再读取");
        assert_eq!(
            ids,
            vec!["msg_00", "msg_01", "child_msg", "msg_05"],
            "跨会话按 time_created 归并"
        );
    }

    #[test]
    fn all_legacy_parent_list_is_delegated_to_the_v1_path() {
        let (conn, info) = fixture();
        let compat = env(&conn, Some(&info));
        let sessions = vec!["ses_legacy_only".to_string()];
        assert!(list_by_parent(&conn, &compat, &sessions, 1, 50)
            .expect("list runs")
            .is_none());
    }

    #[test]
    fn v1_database_is_never_routed_to_v2_reads() {
        let conn = v2_mixed();
        conn.execute_batch("DROP TABLE session_message; DROP TABLE session_v2;")
            .expect("v2 tables drop");
        let info = open_env(&conn);
        let compat = env(&conn, Some(&info));

        assert!(!compat.is_v2());
        assert!(list(&conn, &compat, "any", 1, 50).expect("list runs").is_none());
        assert!(list_by_parent(&conn, &compat, &["any".to_string()], 1, 50)
            .expect("list runs")
            .is_none());
    }

    #[test]
    fn detail_maps_content_blocks_and_step_finish() {
        let (conn, info) = fixture();
        let compat = env(&conn, Some(&info));
        assert_eq!(compat.mode, crate::schema::SchemaMode::V2Mixed);

        let assistant_detail = detail(&conn, "msg_01")
            .expect("detail runs")
            .expect("v2 消息存在");
        assert_eq!(assistant_detail.session_id, "ses_both");
        assert_eq!(assistant_detail.role, "assistant");
        assert_eq!(assistant_detail.content, "迁移前回答");
        assert_eq!(
            assistant_detail.parts.len(),
            2,
            "1 个 text 块 + 合成 step-finish"
        );
        assert_eq!(assistant_detail.parts[0].id, "msg_01:000001");
        assert_eq!(assistant_detail.parts[1].id, "msg_01:step-finish");
        assert_eq!(
            assistant_detail.parts[1].tokens.as_ref().and_then(|t| t.total),
            Some(20)
        );

        // key 与 v1 共享 id 的旧表行不会覆盖 v2 结果
        let user = detail(&conn, "msg_00")
            .expect("detail runs")
            .expect("v2 user 消息存在");
        assert_eq!(user.role, "user");
        assert_eq!(user.parts.len(), 1);
        assert_eq!(user.parts[0].part_type, "text");

        assert!(detail(&conn, "msg_tail_a").expect("detail runs").is_none());
    }

    #[test]
    fn share_is_unavailable_for_unshared_v2_session() {
        let (conn, info) = fixture();
        let compat = env(&conn, Some(&info));
        assert_eq!(compat.mode, crate::schema::SchemaMode::V2Mixed);
        assert!(v2_share(&conn, "ses_both").expect("share runs").is_none());
    }
}
