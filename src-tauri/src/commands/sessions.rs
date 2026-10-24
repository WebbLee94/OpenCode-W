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

use rusqlite::{Connection, Row, ToSql};
use serde::Serialize;
use sha1::{Digest, Sha1};
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::Path;
use tauri::{AppHandle, Manager};

use crate::db::{self, DbState};
use crate::commands::fork_stats;
use crate::compat;
use crate::compat::write;
use crate::models::dto::{
    CleanupSideDTO, IpcResult, SessionDTO, SessionDetailDTO, SessionShareDTO, SkillUsage,
    TokenStats, ToolRanking,
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
///
/// v2 / 混合库额外返回两侧明细（`v2` / `legacy`），让调用方看清删掉了
/// 「v2 数据」与「旧版副本」各多少；v1 库为 `None` 且不序列化。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDeleteResult {
    pub deleted: bool,
    pub deleted_parts: i64,
    pub deleted_messages: i64,
    pub deleted_sessions: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub v2: Option<CleanupSideDTO>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legacy: Option<CleanupSideDTO>,
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
///   tokens_cache_read, tokens_cache_write,
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
        tokens_cache_read: row.get("tokens_cache_read")?,
        tokens_cache_write: row.get("tokens_cache_write")?,
        time_created,
        time_updated,
        cost: row.get("cost")?,
        child_count: None,    // populated by batch query
        // 会话列表不返回父子归属（清理预览才需要），保持缺省。
        parent_id: None,
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
        conditions.push("s.time_created >= ?".to_string());
        params.push(Box::new(crate::commands::analytics::date_to_epoch_ms(sd, true)));
    }
    if let Some(ed) = end_date {
        conditions.push("s.time_created <= ?".to_string());
        params.push(Box::new(crate::commands::analytics::date_to_epoch_ms(ed, false)));
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

// ─── Statistics helpers（按方言取数） ─────────────────────────────────────

/// 批量统计结果：(每会话消息数, 每会话内容体积)。
type MessageStats = (HashMap<String, i64>, HashMap<String, i64>);

/// 子会话计数。`session` 视图在 v1 / v2 / 混合库都可用，因此不需要分支。
fn child_counts(conn: &Connection, ids: &[String]) -> Result<HashMap<String, i64>, String> {
    let mut map = HashMap::new();
    if ids.is_empty() {
        return Ok(map);
    }
    let mut stmt = conn
        .prepare(
            "SELECT parent_id, COUNT(*) FROM session \
             WHERE parent_id IN (SELECT value FROM json_each(?1)) \
             GROUP BY parent_id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([compat::json_array(ids)], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (session_id, count) = row.map_err(|e| e.to_string())?;
        map.insert(session_id, count);
    }
    Ok(map)
}

/// 旧表口径的 msg_count / data_size（v1 语义，逐字沿用原聚合规则）：
/// 消息数排除 fork 归因命中的重复消息；体积排除重复 part。
fn legacy_message_stats(
    conn: &Connection,
    ids: &[String],
    message_json: &str,
    part_json: &str,
) -> Result<MessageStats, String> {
    let mut messages = HashMap::new();
    let mut parts = HashMap::new();
    if ids.is_empty() {
        return Ok((messages, parts));
    }
    let id_json = compat::json_array(ids);

    let mut stmt = conn
        .prepare(
            "SELECT session_id, COUNT(*) FROM message \
             WHERE session_id IN (SELECT value FROM json_each(?1)) \
               AND id NOT IN (SELECT value FROM json_each(?2)) \
             GROUP BY session_id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![&id_json, message_json], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (session_id, count) = row.map_err(|e| e.to_string())?;
        messages.insert(session_id, count);
    }

    let mut stmt = conn
        .prepare(
            "SELECT session_id, COALESCE(SUM(LENGTH(data)), 0) FROM part \
             WHERE session_id IN (SELECT value FROM json_each(?1)) \
               AND id NOT IN (SELECT value FROM json_each(?2)) \
             GROUP BY session_id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![&id_json, part_json], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (session_id, size) = row.map_err(|e| e.to_string())?;
        parts.insert(session_id, size);
    }

    Ok((messages, parts))
}

/// v2 口径的 msg_count / data_size：`session_message` 行数与 `LENGTH(data)` 之和。
///
/// v2 没有 `part` 行，体积只能按消息 JSON 长度近似。
/// v2-only 收口：旧表尾消息不再合并（迁移留给 OpenCode 自己负责）。
fn v2_message_stats(
    conn: &Connection,
    ids: &[String],
    message_json: &str,
) -> Result<MessageStats, String> {
    let mut messages = HashMap::new();
    let mut parts = HashMap::new();
    if ids.is_empty() {
        return Ok((messages, parts));
    }
    let id_json = compat::json_array(ids);

    let mut stmt = conn
        .prepare(
            "SELECT session_id, COUNT(*), COALESCE(SUM(LENGTH(data)), 0) \
             FROM session_message \
             WHERE session_id IN (SELECT value FROM json_each(?1)) \
               AND id NOT IN (SELECT value FROM json_each(?2)) \
             GROUP BY session_id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![&id_json, message_json], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (session_id, count, size) = row.map_err(|e| e.to_string())?;
        messages.insert(session_id.clone(), count);
        parts.insert(session_id, size);
    }

    Ok((messages, parts))
}

/// 按会话方言填充 `msg_count` / `data_size`。
///
/// - v2 会话：`session_message`（v2-only，不合并旧表尾消息）；
/// - v1 库：与 1.3.5 完全一致（同一份聚合规则，仅参数化方式变化）。
/// - v2-mixed 库的 legacy-only 会话不在列表范围，自然不会走到旧表聚合。
fn fill_message_stats(
    conn: &Connection,
    env: &compat::Env,
    data: &mut [SessionDTO],
    message_json: &str,
    part_json: &str,
) -> Result<(), String> {
    if data.is_empty() {
        return Ok(());
    }
    let ids: Vec<String> = data.iter().map(|dto| dto.id.clone()).collect();

    let v2_set: BTreeSet<String> = if env.is_v2() {
        compat::v2_session_ids_in(conn, &ids).map_err(|e| e.to_string())?
    } else {
        BTreeSet::new()
    };

    let (mut msg_map, mut part_map) = (HashMap::new(), HashMap::new());
    if !v2_set.is_empty() {
        let v2_ids: Vec<String> = ids
            .iter()
            .filter(|id| v2_set.contains(*id))
            .cloned()
            .collect();
        let (messages, parts) = v2_message_stats(conn, &v2_ids, message_json)?;
        msg_map.extend(messages);
        part_map.extend(parts);
    }

    let legacy_ids: Vec<String> = ids
        .iter()
        .filter(|id| !v2_set.contains(*id))
        .cloned()
        .collect();
    // v2-fresh 库没有旧表，不能引用 message / part。
    if !legacy_ids.is_empty() && env.has_legacy_tables {
        let (messages, parts) = legacy_message_stats(conn, &legacy_ids, message_json, part_json)?;
        msg_map.extend(messages);
        part_map.extend(parts);
    }

    for dto in data.iter_mut() {
        dto.msg_count = msg_map.get(&dto.id).copied().unwrap_or(0);
        dto.data_size = part_map.get(&dto.id).copied().unwrap_or(0);
    }
    Ok(())
}

/// 单个 v2 会话的 msg_count / data_size（v2-only：不再合并旧表尾消息）。
fn v2_session_stats(
    conn: &Connection,
    session_id: &str,
    message_json: &str,
) -> Result<(i64, i64), String> {
    conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(LENGTH(data)), 0) FROM session_message \
         WHERE session_id = ?1 AND id NOT IN (SELECT value FROM json_each(?2))",
        rusqlite::params![session_id, message_json],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
    )
    .map_err(|e| e.to_string())
}

/// 单会话 v2 Token / cost 汇总（来自 assistant 消息，排除 fork 归因命中的消息）。
type TokenTotals = (i64, i64, i64, i64, i64, f64);

fn v2_token_totals(
    conn: &Connection,
    session_id: &str,
    message_json: &str,
) -> Result<TokenTotals, String> {
    conn.query_row(
        "SELECT \
           COALESCE(SUM(json_extract(data, '$.tokens.input')), 0) as inputTokens, \
           COALESCE(SUM(json_extract(data, '$.tokens.output')), 0) as outputTokens, \
           COALESCE(SUM(json_extract(data, '$.tokens.reasoning')), 0) as reasoningTokens, \
           COALESCE(SUM(json_extract(data, '$.tokens.cache.read')), 0) as cacheRead, \
           COALESCE(SUM(json_extract(data, '$.tokens.cache.write')), 0) as cacheWrite, \
           COALESCE(SUM(json_extract(data, '$.cost')), 0) as estimatedCost \
         FROM session_message \
         WHERE session_id = ? AND type = 'assistant' \
           AND id NOT IN (SELECT value FROM json_each(?))",
        rusqlite::params![session_id, message_json],
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
    )
    .map_err(|e| e.to_string())
}

/// v2 工具排行：`content[].type='tool'` 的 `name` 计数。
fn v2_tool_ranking(
    conn: &Connection,
    session_id: &str,
    message_json: &str,
) -> Result<Vec<ToolRanking>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT json_extract(c.value, '$.name') as toolName, COUNT(*) as count \
             FROM session_message sm, json_each(sm.data, '$.content') AS c \
             WHERE sm.session_id = ? AND json_extract(c.value, '$.type') = 'tool' \
               AND json_extract(c.value, '$.name') IS NOT NULL \
               AND sm.id NOT IN (SELECT value FROM json_each(?)) \
             GROUP BY toolName ORDER BY count DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![session_id, message_json], |r| {
            Ok(ToolRanking {
                tool_name: r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                count: r.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut ranking = Vec::new();
    for row in rows {
        ranking.push(row.map_err(|e| e.to_string())?);
    }
    Ok(ranking)
}

/// v2 技能排行：`content[].name='skill'` 的技能名计数。
///
/// 口径与仪表盘 `stats_v2::skill_usage` 一致：优先非空 `state.input.name`，
/// 退回非空 `state.input.id`（新版 OpenCode 只写 id），两者都缺失记
/// `unknown`，避免详情页与仪表盘出现两套数字。
fn v2_skill_ranking(
    conn: &Connection,
    session_id: &str,
    message_json: &str,
) -> Result<Vec<SkillUsage>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT COALESCE(NULLIF(json_extract(c.value, '$.state.input.name'), ''), \
                             NULLIF(json_extract(c.value, '$.state.input.id'), '')) as skillName, \
                    COUNT(*) as count \
             FROM session_message sm, json_each(sm.data, '$.content') AS c \
             WHERE sm.session_id = ? AND json_extract(c.value, '$.type') = 'tool' \
               AND json_extract(c.value, '$.name') = 'skill' \
               AND sm.id NOT IN (SELECT value FROM json_each(?)) \
             GROUP BY skillName ORDER BY count DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![session_id, message_json], |r| {
            Ok(SkillUsage {
                skill_name: r
                    .get::<_, Option<String>>(0)?
                    .unwrap_or_else(|| String::from("unknown")),
                count: r.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut ranking = Vec::new();
    for row in rows {
        ranking.push(row.map_err(|e| e.to_string())?);
    }
    Ok(ranking)
}

/// 旧表工具排行（v1 语义，逐字沿用原 SQL）。
fn legacy_tool_ranking(
    conn: &Connection,
    session_id: &str,
    part_json: &str,
) -> Result<Vec<ToolRanking>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT json_extract(data, '$.tool') as toolName, COUNT(*) as count \
             FROM part \
             WHERE session_id = ? AND json_extract(data, '$.type') = 'tool' \
               AND json_extract(data, '$.tool') IS NOT NULL \
               AND id NOT IN (SELECT value FROM json_each(?)) \
             GROUP BY toolName ORDER BY count DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![session_id, part_json], |r| {
            Ok(ToolRanking {
                tool_name: r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                count: r.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut ranking = Vec::new();
    for row in rows {
        ranking.push(row.map_err(|e| e.to_string())?);
    }
    Ok(ranking)
}

/// 旧表技能排行（v1 语义，逐字沿用原 SQL）。
fn legacy_skill_ranking(
    conn: &Connection,
    session_id: &str,
    part_json: &str,
) -> Result<Vec<SkillUsage>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT json_extract(data, '$.state.input.name') as skillName, COUNT(*) as count \
             FROM part \
             WHERE session_id = ? AND json_extract(data, '$.type') = 'tool' \
               AND json_extract(data, '$.tool') = 'skill' \
               AND json_extract(data, '$.state.input.name') IS NOT NULL \
               AND id NOT IN (SELECT value FROM json_each(?)) \
             GROUP BY skillName ORDER BY count DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![session_id, part_json], |r| {
            Ok(SkillUsage {
                skill_name: r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                count: r.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut ranking = Vec::new();
    for row in rows {
        ranking.push(row.map_err(|e| e.to_string())?);
    }
    Ok(ranking)
}

/// 会话是否使用 v2 方言。v1 库直接返回 false，调用方继续走原 SQL。
fn is_v2_session(conn: &Connection, env: &compat::Env, session_id: &str) -> Result<bool, String> {
    if !env.is_v2() {
        return Ok(false);
    }
    Ok(compat::resolve_dialect(conn, session_id).map_err(|e| e.to_string())? == compat::Dialect::V2)
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
    let state = app.state::<DbState>();
    let schema = state.schema();
    let db = state.clone_inner();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = match db::get_db(&db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };
        let env = compat::env(&conn, schema.as_ref());
        let set = fork_stats::dedup(&conn).unwrap_or_default();
        let session_json = set.session_ids_json();
        let message_json = set.message_ids_json();
        let part_json = set.part_ids_json();

        let page = page.unwrap_or(1).max(1);
        let page_size = page_size.unwrap_or(50).clamp(1, 200);
        let offset = (page - 1) * page_size;
        let sort_by = sort_by.unwrap_or_else(|| "time_updated".to_string());
        let sort_order = sort_order.unwrap_or_else(|| "desc".to_string());

        // Build WHERE clause using extracted helper
        let (mut where_clause, mut params) = build_session_where(
            &conn, &search, &project_id, &start_date, &end_date, &parent_filter,
        );
        where_clause.push_str(if where_clause.is_empty() {
            "WHERE s.id NOT IN (SELECT value FROM json_each(?))"
        } else {
            " AND s.id NOT IN (SELECT value FROM json_each(?))"
        });
        params.push(Box::new(session_json));

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
             (COALESCE(s.tokens_input, 0) + COALESCE(s.tokens_output, 0) + COALESCE(s.tokens_reasoning, 0) + COALESCE(s.tokens_cache_read, 0) + COALESCE(s.tokens_cache_write, 0)) as total_tokens \
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

        // Batch-fetch childCount, msg_count, and data_size for all returned sessions.
        // msg_count / data_size 按会话方言取数：v2 读 session_message（+旧表尾消息），
        // 混合库里的 legacy-only 会话与 v1 库沿用原聚合口径。
        if !data.is_empty() {
            let ids: Vec<String> = data.iter().map(|d| d.id.clone()).collect();
            let child_map = match child_counts(&conn, &ids) {
                Ok(map) => map,
                Err(e) => return IpcResult::err(e),
            };
            if let Err(e) = fill_message_stats(
                &conn,
                &env,
                &mut data,
                &message_json,
                &part_json,
            ) {
                return IpcResult::err(e);
            }
            for dto in data.iter_mut() {
                dto.child_count = child_map.get(&dto.id).copied();
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
    let state = app.state::<DbState>();
    let schema = state.schema();
    let db = state.clone_inner();
    tauri::async_runtime::spawn_blocking(move || {
        let session_id = value;

        let conn = match db::get_db(&db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };
        let env = compat::env(&conn, schema.as_ref());
        let v2 = match is_v2_session(&conn, &env, &session_id) {
            Ok(v2) => v2,
            Err(e) => return IpcResult::err(e),
        };
        let set = fork_stats::dedup(&conn).unwrap_or_default();
        let message_json = set.message_ids_json();
        let part_json = set.part_ids_json();

        // v2 会话的 msg_count / data_size 来自 session_message（v2-only），
        // 因此基查询不能再引用 part 表（v2-fresh 里根本没有该表）。
        // Get session base info — scalar subqueries scoped to this session replace
        // full-table GROUP BY joins (the former query aggregated every message/part).
        // v1 SQL 逐字保留；只有 v2 方言 / 无旧表的库换成 0 占位，随后按方言补齐。
        let sql = if v2 || !env.has_legacy_tables {
            "SELECT s.id, s.title, s.directory, s.model, s.agent, s.project_id, \
             COALESCE(s.tokens_input, 0) as tokens_input, \
             COALESCE(s.tokens_output, 0) as tokens_output, \
             COALESCE(s.tokens_reasoning, 0) as tokens_reasoning, \
             COALESCE(s.tokens_cache_read, 0) as tokens_cache_read, \
             COALESCE(s.tokens_cache_write, 0) as tokens_cache_write, \
             s.cost, s.time_created, s.time_updated, \
             0 as msg_count, \
             (COALESCE(s.tokens_input, 0) + COALESCE(s.tokens_output, 0) + COALESCE(s.tokens_reasoning, 0) + COALESCE(s.tokens_cache_read, 0) + COALESCE(s.tokens_cache_write, 0)) as total_tokens, \
             0 as data_size, \
             0 as childCount \
             FROM session s \
             WHERE s.id = ?3"
        } else {
            "SELECT s.id, s.title, s.directory, s.model, s.agent, s.project_id, \
             COALESCE(s.tokens_input, 0) as tokens_input, \
             COALESCE(s.tokens_output, 0) as tokens_output, \
             COALESCE(s.tokens_reasoning, 0) as tokens_reasoning, \
             COALESCE(s.tokens_cache_read, 0) as tokens_cache_read, \
             COALESCE(s.tokens_cache_write, 0) as tokens_cache_write, \
             s.cost, s.time_created, s.time_updated, \
             (SELECT COUNT(*) FROM message WHERE session_id = ?3 AND id NOT IN (SELECT value FROM json_each(?1))) as msg_count, \
             (COALESCE(s.tokens_input, 0) + COALESCE(s.tokens_output, 0) + COALESCE(s.tokens_reasoning, 0) + COALESCE(s.tokens_cache_read, 0) + COALESCE(s.tokens_cache_write, 0)) as total_tokens, \
             (SELECT COALESCE(SUM(LENGTH(data)), 0) FROM part WHERE session_id = ?3 AND id NOT IN (SELECT value FROM json_each(?2))) as data_size, \
             0 as childCount \
             FROM session s \
             WHERE s.id = ?3"
        };
        let mut session = match conn.query_row(
            sql,
            rusqlite::params![&message_json, &part_json, &session_id],
            map_session_row,
        ) {
            Ok(s) => s,
            Err(rusqlite::Error::QueryReturnedNoRows) => return IpcResult::ok(None),
            Err(e) => return IpcResult::err(e.to_string()),
        };

        if v2 {
            let (msg_count, data_size) = match v2_session_stats(
                &conn,
                &session_id,
                &message_json,
            ) {
                Ok(stats) => stats,
                Err(e) => return IpcResult::err(e),
            };
            session.msg_count = msg_count;
            session.data_size = data_size;
        }

        // Token stats — v2 取 assistant 消息上的 tokens / cost；v1 取 part 的 step-finish。
        let token_stats_row = if v2 {
            match v2_token_totals(&conn, &session_id, &message_json) {
                Ok(totals) => totals,
                Err(e) => return IpcResult::err(e),
            }
        } else if env.has_legacy_tables {
            match conn.query_row(
                "SELECT \
                   COALESCE(SUM(json_extract(data, '$.tokens.input')), 0) as inputTokens, \
                   COALESCE(SUM(json_extract(data, '$.tokens.output')), 0) as outputTokens, \
                   COALESCE(SUM(json_extract(data, '$.tokens.reasoning')), 0) as reasoningTokens, \
                   COALESCE(SUM(json_extract(data, '$.tokens.cache.read')), 0) as cacheRead, \
                   COALESCE(SUM(json_extract(data, '$.tokens.cache.write')), 0) as cacheWrite, \
                   COALESCE(SUM(json_extract(data, '$.cost')), 0) as estimatedCost \
                 FROM part \
                 WHERE session_id = ? AND json_extract(data, '$.type') = 'step-finish' \
                   AND id NOT IN (SELECT value FROM json_each(?))",
                rusqlite::params![&session_id, &part_json],
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
            }
        } else {
            (0, 0, 0, 0, 0, 0.0)
        };
        let (input_tokens, output_tokens, reasoning_tokens, cache_read, cache_write, estimated_cost) =
            token_stats_row;
        let total_attempts = (cache_read + input_tokens) as f64;
        let cache_hit_rate = if total_attempts > 0.0 {
            let rate = (cache_read as f64 / total_attempts) * 100.0;
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
            cache_hit_rate,
        };

        // Tool ranking — v2 读 content[] 的 name，v1 读 part.data.tool。
        let tool_ranking = if v2 {
            match v2_tool_ranking(&conn, &session_id, &message_json) {
                Ok(ranking) => ranking,
                Err(e) => return IpcResult::err(e),
            }
        } else if env.has_legacy_tables {
            match legacy_tool_ranking(&conn, &session_id, &part_json) {
                Ok(ranking) => ranking,
                Err(e) => return IpcResult::err(e),
            }
        } else {
            Vec::new()
        };

        // Skill ranking — v2 读 content[].state.input.name，v1 读 part.data.state.input.name。
        let skill_ranking = if v2 {
            match v2_skill_ranking(&conn, &session_id, &message_json) {
                Ok(ranking) => ranking,
                Err(e) => return IpcResult::err(e),
            }
        } else if env.has_legacy_tables {
            match legacy_skill_ranking(&conn, &session_id, &part_json) {
                Ok(ranking) => ranking,
                Err(e) => return IpcResult::err(e),
            }
        } else {
            Vec::new()
        };
 
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
    let state = app.state::<DbState>();
    if let Err(e) = db::ensure_writable(&state) {
        return IpcResult::err(e);
    }
    let state = state.inner().clone();
    let db = state.clone_inner();
    tauri::async_runtime::spawn_blocking(move || {
        let session_id = value;

        let conn = match db::get_db(&db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };

        // 实时迁移闸门：缓存可能是开库时的旧值（OpenCode 之后才启动迁移）。
        if let Err(e) = db::ensure_writable_conn(&conn) {
            return IpcResult::err(e);
        }

        match delete_session(&conn, &session_id) {
            Ok(result) => {
                // 写后一致性：失效分叉归因缓存并刷新 schema 计数与尾消息 id。
                // 刷新失败不影响已经生效的写入，只记日志（下次 database:info 会重探）。
                fork_stats::invalidate_cache();
                if let Err(error) = state.refresh_schema_counts(&conn) {
                    log::warn!("刷新 schema 计数失败：{}", error);
                }
                IpcResult::ok(result)
            }
            Err(e) => IpcResult::err(e),
        }
    })
    .await
    .unwrap_or_else(|e| IpcResult::err(format!("thread error: {}", e)))
}

/// 删除一个会话及其消息 / parts（含子会话）。
///
/// v1 / v2 / 混合库共用 [`write::delete_sessions`]：方言判断与表存在性检查
/// 都在删除之前完成，因此不会出现「旧表行删了一半才撞上视图」的半成品状态。
/// 计数口径：v2 侧 = `session_v2` / `session_message`，旧版侧 = `session` /
/// `message` / `part`；同 id 消息只在 v2 侧计一次。
fn delete_session(
    conn: &Connection,
    session_id: &str,
) -> Result<SessionDeleteResult, String> {
    let outcome = write::delete_sessions(conn, &[session_id.to_string()])?;

    Ok(SessionDeleteResult {
        deleted: outcome.sessions > 0,
        deleted_parts: outcome.parts(),
        deleted_messages: outcome.messages(),
        deleted_sessions: outcome.sessions,
        v2: v2_side(&outcome),
        legacy: legacy_side(&outcome),
    })
}

/// v2 侧删除明细（v1 库没有 v2 表，返回 `None`）。
fn v2_side(outcome: &write::DeleteOutcome) -> Option<CleanupSideDTO> {
    if outcome.v2_session_rows == 0 && outcome.v2_message_rows == 0 {
        return None;
    }
    Some(outcome.v2_side())
}

/// 旧版副本侧删除明细（没有旧表时返回 `None`）。
fn legacy_side(outcome: &write::DeleteOutcome) -> Option<CleanupSideDTO> {
    if outcome.legacy_session_rows == 0
        && outcome.legacy_message_rows == 0
        && outcome.legacy_part_rows == 0
    {
        return None;
    }
    Some(outcome.legacy_side())
}

/// session-share:get — get share info for a session.
///
/// Frontend calls: `invokeSafe('session-share:get', sessionId)`
/// ipc.ts wraps single string arg as `{ value: sessionId }`.
#[tauri::command]
pub async fn session_share_get(app: AppHandle, value: String) -> IpcResult<Option<SessionShareDTO>> {
    let state = app.state::<DbState>();
    let schema = state.schema();
    let db = state.clone_inner();
    tauri::async_runtime::spawn_blocking(move || {
        let session_id = value;

        let conn = match db::get_db(&db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };

        let env = compat::env(&conn, schema.as_ref());
        let v2 = match is_v2_session(&conn, &env, &session_id) {
            Ok(v2) => v2,
            Err(e) => return IpcResult::err(e),
        };
        // v2 没有 session_share 表：分享信息只有 session_v2.share_url，
        // id / secret 返回 null（前端 SessionShareDTO 已允许可空）。
        if v2 {
            return match compat::v2_share(&conn, &session_id) {
                Ok(share) => IpcResult::ok(share),
                Err(e) => IpcResult::err(e.to_string()),
            };
        }
        // v2-fresh 库没有旧分享表，直接视为未分享。
        if !compat::has_legacy_share_table(&conn) {
            return IpcResult::ok(None);
        }

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
    let state = app.state::<DbState>();
    if let Err(e) = db::ensure_writable(&state) {
        return IpcResult::err(e);
    }
    let state = state.inner().clone();
    let db = state.clone_inner();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = match db::get_db(&db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };

        // 实时迁移闸门：缓存可能是开库时的旧值（OpenCode 之后才启动迁移）。
        if let Err(e) = db::ensure_writable_conn(&conn) {
            return IpcResult::err(e);
        }

        match rename_session(&conn, &session_id, &title) {
            Ok(renamed) => {
                // 写后一致性：失效分叉归因缓存并刷新 schema 计数与尾消息 id。
                // 刷新失败不影响已经生效的写入，只记日志（下次 database:info 会重探）。
                fork_stats::invalidate_cache();
                if let Err(error) = state.refresh_schema_counts(&conn) {
                    log::warn!("刷新 schema 计数失败：{}", error);
                }
                IpcResult::ok(renamed)
            }
            Err(e) => IpcResult::err(e),
        }
    })
    .await
    .unwrap_or_else(|e| IpcResult::err(format!("thread error: {}", e)))
}

/// 重命名会话。
///
/// v2 会话写 `main.session_v2`（同时更新 `time_updated`），写前校验会话存在；
/// 旧表会话（含混合库里的 legacy-only）写 `main.session`，与 1.3.5 行为一致。
///
/// 注意：v2 模式下 `session` 是 TEMP VIEW，直接 `UPDATE session` 会报
/// `cannot modify session because it is a view`，因此必须写 `main.` 前缀。
fn rename_session(
    conn: &Connection,
    session_id: &str,
    title: &str,
) -> Result<bool, String> {
    write::rename_session(conn, session_id, title)
}

/// sessions:children — list child sessions of a parent.
///
/// Frontend calls: `invokeSafe('sessions:children', activeSessionId)`
/// ipc.ts wraps single string arg as `{ value: activeSessionId }`.
#[tauri::command]
pub async fn sessions_children(app: AppHandle, value: String) -> IpcResult<Vec<SessionDTO>> {
    let state = app.state::<DbState>();
    let schema = state.schema();
    let db = state.clone_inner();
    tauri::async_runtime::spawn_blocking(move || {
        let session_id = value;

        let conn = match db::get_db(&db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };

        if !check_parent_column(&conn) {
            return IpcResult::ok(Vec::new());
        }

        let env = compat::env(&conn, schema.as_ref());
        // v2-fresh 没有 part 表：msg_count / data_size 先占位，取回行后按方言批量补齐。
        let sql = if env.is_v2() {
            "SELECT s.id, s.title, s.directory, s.model, s.agent, s.project_id, \
             COALESCE(s.tokens_input, 0) as tokens_input, \
             COALESCE(s.tokens_output, 0) as tokens_output, \
             COALESCE(s.tokens_reasoning, 0) as tokens_reasoning, \
             COALESCE(s.tokens_cache_read, 0) as tokens_cache_read, \
             COALESCE(s.tokens_cache_write, 0) as tokens_cache_write, \
             s.cost, s.time_created, s.time_updated, \
             0 as msg_count, \
             (COALESCE(s.tokens_input, 0) + COALESCE(s.tokens_output, 0) + COALESCE(s.tokens_reasoning, 0) + COALESCE(s.tokens_cache_read, 0) + COALESCE(s.tokens_cache_write, 0)) as total_tokens, \
             0 as data_size, \
             0 as childCount \
             FROM session s \
             WHERE s.parent_id = ? \
             ORDER BY s.time_created ASC"
        } else {
            "SELECT s.id, s.title, s.directory, s.model, s.agent, s.project_id, \
             COALESCE(s.tokens_input, 0) as tokens_input, \
             COALESCE(s.tokens_output, 0) as tokens_output, \
             COALESCE(s.tokens_reasoning, 0) as tokens_reasoning, \
             COALESCE(s.tokens_cache_read, 0) as tokens_cache_read, \
             COALESCE(s.tokens_cache_write, 0) as tokens_cache_write, \
             s.cost, s.time_created, s.time_updated, \
             (SELECT COUNT(*) FROM message WHERE session_id = s.id) as msg_count, \
             (COALESCE(s.tokens_input, 0) + COALESCE(s.tokens_output, 0) + COALESCE(s.tokens_reasoning, 0) + COALESCE(s.tokens_cache_read, 0) + COALESCE(s.tokens_cache_write, 0)) as total_tokens, \
             (SELECT COALESCE(SUM(LENGTH(data)), 0) FROM part WHERE session_id = s.id) as data_size, \
             0 as childCount \
             FROM session s \
             WHERE s.parent_id = ? \
             ORDER BY s.time_created ASC"
        };
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

        // children 统计历来不套 fork 归因排除，这里保持一致（传空数组）。
        let no_exclusions = "[]";
        if env.is_v2() && !result.is_empty() {
            if let Err(e) = fill_message_stats(
                &conn,
                &env,
                &mut result,
                no_exclusions,
                no_exclusions,
            ) {
                return IpcResult::err(e);
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
    let state = app.state::<DbState>();
    if let Err(e) = db::ensure_writable(&state) {
        return IpcResult::err(e);
    }
    let state = state.inner().clone();
    let db = state.clone_inner();
    tauri::async_runtime::spawn_blocking(move || {
        if session_ids.is_empty() {
            return IpcResult::ok(SessionMoveResult { migrated: 0 });
        }

        let conn = match db::get_db(&db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };

        // 实时迁移闸门：缓存可能是开库时的旧值（OpenCode 之后才启动迁移）。
        if let Err(e) = db::ensure_writable_conn(&conn) {
            return IpcResult::err(e);
        }

        match move_sessions(&conn, &session_ids, &directory) {
            Ok(migrated) => {
                // 写后一致性：失效分叉归因缓存并刷新 schema 计数与尾消息 id。
                // 刷新失败不影响已经生效的写入，只记日志（下次 database:info 会重探）。
                fork_stats::invalidate_cache();
                if let Err(error) = state.refresh_schema_counts(&conn) {
                    log::warn!("刷新 schema 计数失败：{}", error);
                }
                IpcResult::ok(SessionMoveResult { migrated })
            }
            Err(e) => IpcResult::err(e),
        }
    })
    .await
    .unwrap_or_else(|e| IpcResult::err(format!("thread error: {}", e)))
}

/// 移动会话到新目录。
///
/// 先查/建 `project`，再更新会话，两步必须在同一事务里：否则 UPDATE
/// 失败时会留下一个孤立的 project 行。
///
/// v2 会话写 `main.session_v2`，旧表会话（含混合库里的 legacy-only）写
/// `main.session`——v2 模式下 `session` 是 TEMP VIEW，直接写会报
/// `cannot modify session because it is a view`。仅根会话（`parent_id IS NULL`）
/// 会被移动。
fn move_sessions(
    conn: &Connection,
    session_ids: &[String],
    directory: &str,
) -> Result<i64, String> {
    // Resolve directory (path::resolve equivalent)
    let n = fs::canonicalize(directory)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| directory.to_string());
    let p = compute_project_id(&n);

    write::move_sessions(conn, session_ids, &n, &p)
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

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use rusqlite::Connection;

    use super::{
        delete_session, fill_message_stats, move_sessions, rename_session, v2_session_stats,
        v2_skill_ranking, v2_token_totals, v2_tool_ranking,
    };
    use crate::compat;
    use crate::models::dto::SessionDTO;
    use crate::schema::{SchemaInfo, SchemaMode};

    /// 同一进程内并行的测试可能拿到同一纳秒时间戳，目录名必须唯一，
    /// 否则两个夹具会互相覆盖（夹具内容串台会让断言随机失败）。
    static FIXTURE_COUNTER: AtomicU64 = AtomicU64::new(0);

    /// 夹具先复制到临时目录：`test-data/*.db` 被 .gitignore 忽略，不能就地写入。
    struct TempFixture {
        dir: PathBuf,
    }

    impl Drop for TempFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    /// 夹具缺失时的处置策略。
    ///
    /// CI（GitHub Actions 注入 `CI=true`）里夹具缺失必须失败：否则测试会静默
    /// 跳过，日志看起来仍是「全部通过」（假绿）。本地保留 `[skip]`，方便没有
    /// 夹具时继续开发。口径与 `schema::fixture_tests` 一致。
    fn missing_fixture(file: &str) -> Option<String> {
        if std::env::var_os("CI").is_some() {
            Some(format!(
                "夹具缺失，检查 Generate test fixtures 步骤：缺少 test-data/{file}（本地可先执行 `npm run generate-fixture` 或 `npm run generate-fixture:v2`）"
            ))
        } else {
            None
        }
    }

    fn fixture(file: &str) -> Option<(TempFixture, Connection, SchemaInfo)> {
        let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../test-data")
            .join(file);
        if !source.is_file() {
            if let Some(error) = missing_fixture(file) {
                panic!("{error}");
            }
            eprintln!(
                "[skip] 缺少夹具 {file}：先执行 `npm run generate-fixture` 或 `npm run generate-fixture:v2`"
            );
            return None;
        }
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time is after the Unix epoch")
            .as_nanos();
        let counter = FIXTURE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "ocw-session-stats-it-{}-{counter}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("temp dir is created");
        let path = dir.join("fixture.db");
        fs::copy(&source, &path).expect("fixture is copied");
        let conn = Connection::open(&path).expect("fixture opens");
        let info = compat::test_support::open_env(&conn);
        Some((TempFixture { dir }, conn, info))
    }

    fn dto(id: &str) -> SessionDTO {
        SessionDTO {
            id: id.to_string(),
            title: String::new(),
            directory: None,
            model: None,
            agent: None,
            project_id: None,
            msg_count: 0,
            total_tokens: 0,
            data_size: 0,
            tokens_input: 0,
            tokens_output: 0,
            tokens_reasoning: 0,
            tokens_cache_read: 0,
            tokens_cache_write: 0,
            time_created: 0,
            time_updated: 0,
            cost: None,
            child_count: None,
            parent_id: None,
        }
    }

    fn mixed_ids() -> Vec<String> {
        [
            "ses_fresh_v2only_0001",
            "ses_fresh_v2only_0002",
            "ses_mixed_v2only_0101",
            "ses_mixed_v2only_0102",
            "ses_mixed_both_0201",
            "ses_mixed_both_0202",
            "ses_mixed_legacy_0301",
        ]
        .into_iter()
        .map(String::from)
        .collect()
    }

    /// v2-only 收口验收：msg_count / data_size 只来自 `session_message`；
    /// 旧表尾消息与 legacy-only 会话不再计入（旧表数据留在原处）。
    #[test]
    fn v2_mixed_fixture_counts_v2_message_rows_only() {
        let Some((_guard, conn, info)) = fixture("v2-mixed.db") else {
            return;
        };
        assert_eq!(info.mode, SchemaMode::V2Mixed);
        let env = compat::env(&conn, Some(&info));
        assert!(env.is_v2());

        // 列表口径：只有 v2 视图里的会话被统计。
        let listed = mixed_ids()
            .into_iter()
            .filter(|id| id != "ses_mixed_legacy_0301")
            .collect::<Vec<_>>();
        let mut data: Vec<SessionDTO> = listed.iter().map(|id| dto(id)).collect();
        fill_message_stats(&conn, &env, &mut data, "[]", "[]").expect("stats fill");

        let stat = |data: &[SessionDTO], id: &str| -> (i64, i64) {
            let dto = data.iter().find(|dto| dto.id == id).expect("fixture session exists");
            (dto.msg_count, dto.data_size)
        };
        let (msg_count, data_size) = stat(&data, "ses_mixed_both_0201");
        assert_eq!(msg_count, 4, "只用 v2 行，尾消息不计");
        assert_eq!(stat(&data, "ses_mixed_both_0202").0, 2, "只用 v2 行");
        assert_eq!(
            data.iter().map(|dto| dto.msg_count).sum::<i64>(),
            20,
            "20 条 session_message，尾消息与 legacy-only 不计入"
        );
        assert!(data_size > 0, "v2 体积按消息 JSON 长度统计");
    }

    #[test]
    fn v2_detail_stats_use_session_message_rows_only() {
        let Some((_guard, conn, _info)) = fixture("v2-mixed.db") else {
            return;
        };

        let (msg_count, data_size) =
            v2_session_stats(&conn, "ses_mixed_both_0201", "[]").expect("stats");
        assert_eq!(msg_count, 4, "v2-only：尾消息不计入 msg_count");
        assert!(data_size > 0, "体积按消息 JSON 长度统计");

        let (msg_count, _) = v2_session_stats(&conn, "ses_mixed_v2only_0101", "[]")
            .expect("stats");
        assert_eq!(msg_count, 2);
    }

    #[test]
    fn v2_detail_tokens_tools_and_skills_come_from_assistant_content() {
        let Some((_guard, conn, info)) = fixture("v2-mixed.db") else {
            return;
        };
        let _env = compat::env(&conn, Some(&info));

        let (input, output, reasoning, cache_read, cache_write, cost) =
            v2_token_totals(&conn, "ses_mixed_both_0201", "[]").expect("token totals");
        assert_eq!(
            (input, output, reasoning, cache_read, cache_write),
            (6500, 1100, 420, 3200, 510),
            "两条 assistant 消息的 tokens 求和（含 cache 嵌套结构）"
        );
        assert!((cost - 0.0079).abs() < 1e-9);

        let tools = v2_tool_ranking(&conn, "ses_mixed_both_0201", "[]").expect("tool ranking");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].tool_name, "shell");
        assert_eq!(tools[0].count, 1);

        assert!(
            v2_skill_ranking(&conn, "ses_mixed_both_0201", "[]")
                .expect("skill ranking")
                .is_empty(),
            "夹具里没有 skill 调用"
        );
    }

    /// 向夹具会话插入一条覆盖四种技能块形态的 assistant 消息：
    /// name / id / 空 name + id / 无 input（call id only）。
    fn insert_skill_form_blocks(conn: &Connection, session_id: &str) {
        crate::compat::test_support::insert_v2_message(
            conn,
            "msg_skill_forms",
            session_id,
            "assistant",
            99,
            900,
            r#"{"content":[
                {"type":"tool","name":"skill","id":"call_1","state":{"status":"completed","input":{"name":"brainstorming"}}},
                {"type":"tool","name":"skill","id":"call_2","state":{"status":"completed","input":{"id":"huashu-nuwa"}}},
                {"type":"tool","name":"skill","id":"call_3","state":{"status":"completed","input":{"name":"","id":"pdf"}}},
                {"type":"tool","name":"skill","id":"call_4","state":{"status":"completed"}}
            ]}"#,
        );
    }

    /// 会话详情技能排行必须与仪表盘同口径：name → id → unknown。
    #[test]
    fn v2_skill_ranking_supports_id_and_marks_missing_input_as_unknown() {
        let Some((_guard, conn, _info)) = fixture("v2-mixed.db") else {
            return;
        };
        insert_skill_form_blocks(&conn, "ses_mixed_both_0201");

        let ranking = v2_skill_ranking(&conn, "ses_mixed_both_0201", "[]").expect("skill ranking");
        let counts: BTreeMap<String, i64> = ranking
            .iter()
            .map(|item| (item.skill_name.clone(), item.count))
            .collect();
        assert_eq!(counts.get("brainstorming"), Some(&1), "name 形态");
        assert_eq!(counts.get("huashu-nuwa"), Some(&1), "只写 id 的新版形态");
        assert_eq!(counts.get("pdf"), Some(&1), "空 name 必须退回 id");
        assert_eq!(counts.get("unknown"), Some(&1), "无 input 时记 unknown");
        assert_eq!(counts.len(), 4, "四种形态各一行，不得漏块");
    }

    /// 同一份数据：会话详情与仪表盘 `stats_v2::skill_usage` 的结果必须一致，
    /// 避免两页数字互相矛盾（P1-1 口径漂移）。
    #[test]
    fn v2_skill_ranking_matches_stats_v2_skill_usage_on_the_same_data() {
        let Some((_guard, conn, _info)) = fixture("v2-mixed.db") else {
            return;
        };
        insert_skill_form_blocks(&conn, "ses_mixed_both_0201");

        let detail = v2_skill_ranking(&conn, "ses_mixed_both_0201", "[]").expect("skill ranking");
        let dashboard =
            crate::commands::analytics::stats_v2::skill_usage(&conn, None, "[]")
                .expect("skill usage runs");

        let detail_counts: BTreeMap<String, i64> = detail
            .iter()
            .map(|item| (item.skill_name.clone(), item.count))
            .collect();
        let dashboard_counts: BTreeMap<String, i64> = dashboard
            .iter()
            .map(|item| (item.skill_name.clone(), item.count))
            .collect();
        // 夹具其余会话没有 skill 调用：仪表盘全库计数应等于该会话的详情计数。
        assert_eq!(
            detail_counts, dashboard_counts,
            "详情页与仪表盘的技能排行必须逐条一致"
        );
    }

    /// v1 夹具逐会话对照原 SQL：消息数与内容体积必须完全一致。
    #[test]
    fn v1_fixture_stats_match_the_legacy_sql() {
        let Some((_guard, conn, info)) = fixture("test.db") else {
            return;
        };
        assert_eq!(info.mode, SchemaMode::V1);
        let env = compat::env(&conn, Some(&info));
        assert!(!env.is_v2());

        let mut stmt = conn
            .prepare("SELECT id FROM session ORDER BY id")
            .expect("session ids query");
        let ids: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .expect("session ids")
            .collect::<rusqlite::Result<Vec<String>>>()
            .expect("session ids read");
        assert_eq!(ids.len(), 5);

        let mut data: Vec<SessionDTO> = ids.iter().map(|id| dto(id)).collect();
        fill_message_stats(&conn, &env, &mut data, "[]", "[]").expect("stats fill");

        for dto in &data {
            let expected_messages: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM message WHERE session_id = ?1",
                    [&dto.id],
                    |row| row.get(0),
                )
                .expect("legacy message count");
            let expected_size: i64 = conn
                .query_row(
                    "SELECT COALESCE(SUM(LENGTH(data)), 0) FROM part WHERE session_id = ?1",
                    [&dto.id],
                    |row| row.get(0),
                )
                .expect("legacy part size");
            assert_eq!(dto.msg_count, expected_messages, "session {}", dto.id);
            assert_eq!(dto.data_size, expected_size, "session {}", dto.id);
        }
        assert_eq!(
            data.iter().map(|dto| dto.msg_count).sum::<i64>(),
            20,
            "v1 夹具共 20 条消息"
        );
    }

    /// v2 下移动必须写到 `session_v2`，project 行与更新同事务、不留孤儿。
    #[test]
    fn move_updates_v2_session_and_creates_the_project_row() {
        let Some((_guard, conn, _info)) = fixture("v2-mixed.db") else {
            return;
        };

        let migrated = move_sessions(&conn, &["ses_mixed_both_0201".to_string()], "/tmp/moved")
            .expect("v2 移动必须成功");
        assert_eq!(migrated, 1, "只有根会话会被移动");

        let (directory, project_id): (String, String) = conn
            .query_row(
                "SELECT directory, project_id FROM main.session_v2 WHERE id = 'ses_mixed_both_0201'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("session_v2 row reads");
        assert_eq!(directory, "/tmp/moved");
        assert!(!project_id.is_empty(), "project_id 必须被写入");

        let project_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM main.project WHERE id = ?1",
                [&project_id],
                |row| row.get(0),
            )
            .expect("project count");
        assert_eq!(project_count, 1, "project 行必须存在，不能是孤儿");

        // 子会话不移动（仅根会话）。
        let child_directory: String = conn
            .query_row(
                "SELECT directory FROM main.session_v2 WHERE id = 'ses_mixed_v2only_0102'",
                [],
                |row| row.get(0),
            )
            .expect("child session reads");
        assert_eq!(child_directory, "/Users/dev/fixture-mixed");
    }

    /// 事务性：UPDATE 失败时 project 行必须回滚，不能留下孤儿记录。
    #[test]
    fn move_rolls_back_project_row_when_update_fails() {        let conn = Connection::open_in_memory().expect("in-memory database opens");
        conn.execute_batch(crate::schema::fixtures::v1_schema())
            .expect("v1 schema applies");
        conn.execute_batch(
            "CREATE TABLE project (
                id TEXT PRIMARY KEY,
                worktree TEXT NOT NULL,
                name TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL,
                sandboxes TEXT NOT NULL,
                commands TEXT NOT NULL
            );
            INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
            VALUES ('ses_v1', 'proj', 'slug', '/tmp/old', '会话', '1.3.5', 1, 2);
            CREATE TRIGGER fail_session_update BEFORE UPDATE ON session
            BEGIN SELECT RAISE(ABORT, 'boom'); END;",
        )
        .expect("fixtures apply");

        let error = move_sessions(&conn, &["ses_v1".to_string()], "/tmp/moved")
            .expect_err("更新失败必须返回错误");
        assert!(error.contains("boom"), "{error}");
        let project_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM project", [], |row| row.get(0))
            .expect("project count");
        assert_eq!(project_count, 0, "失败后 project 行必须回滚");
    }

    /// v2-only 收口：删除只清 v2 行，旧表冻结副本不再触碰（保持原处）。
    #[test]
    fn delete_removes_v2_rows_only_and_leaves_legacy_copies_frozen() {
        let Some((_guard, conn, _info)) = fixture("v2-mixed.db") else {
            return;
        };
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .expect("foreign keys enable");

        let count = |conn: &Connection, sql: &str| -> i64 {
            conn.query_row(sql, [], |row| row.get(0)).expect("row count")
        };
        let legacy_messages_before = count(
            &conn,
            "SELECT COUNT(*) FROM main.message WHERE session_id = 'ses_mixed_both_0201'",
        );
        let legacy_parts_before = count(
            &conn,
            "SELECT COUNT(*) FROM main.part WHERE session_id = 'ses_mixed_both_0201'",
        );

        let result = delete_session(&conn, "ses_mixed_both_0201").expect("删除必须成功");
        assert!(result.deleted);
        assert_eq!(result.deleted_sessions, 1);

        let v2 = result.v2.as_ref().expect("v2 侧明细");
        assert_eq!(v2.session_count, 1);
        assert_eq!(v2.message_count, 4, "4 条 session_message");
        assert_eq!(v2.part_count, 4, "v2 无 part 表：内容块数按消息行数统计");

        assert!(result.legacy.is_none(), "v2-only：不做 legacy 双删，无旧版副本明细");

        assert_eq!(result.deleted_messages, 4, "只用 v2 行计数");
        assert_eq!(result.deleted_parts, 4, "只用 v2 行计数");

        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM main.session_v2 WHERE id = 'ses_mixed_both_0201'"
            ),
            0
        );
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM main.session_message WHERE session_id = 'ses_mixed_both_0201'"
            ),
            0
        );
        // 旧表冻结副本原样保留。
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM main.session WHERE id = 'ses_mixed_both_0201'"
            ),
            1
        );
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM main.message WHERE session_id = 'ses_mixed_both_0201'"
            ),
            legacy_messages_before
        );
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM main.part WHERE session_id = 'ses_mixed_both_0201'"
            ),
            legacy_parts_before
        );

        // 外键校验：不得留下孤儿 session_message。
        let violations: i64 = count(&conn, "SELECT COUNT(*) FROM pragma_foreign_key_check");
        assert_eq!(violations, 0, "删除后不得有外键残留");
    }

    /// 删除后重新探测：v2 会话不得「复活」。
    #[test]
    fn delete_does_not_resurrect_the_session() {
        let Some((_guard, conn, _info)) = fixture("v2-mixed.db") else {
            return;
        };

        delete_session(&conn, "ses_mixed_both_0201").expect("删除必须成功");

        // 重新探测（等价于重开应用）：会话不在视图里。
        let refreshed = crate::schema::detect(&conn).expect("重新探测");
        assert_eq!(refreshed.v2_session_count, 5, "少了一个 v2 会话");
        assert!(refreshed.has_legacy_tables);

        let rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM session WHERE id = 'ses_mixed_both_0201'",
                [],
                |row| row.get(0),
            )
            .expect("view query");
        assert_eq!(rows, 0, "会话视图里不得再出现");
    }

    /// v2 删除会递归子会话（v2 树），避免留下 parent_id 悬空的孤儿会话。
    #[test]
    fn delete_removes_v2_children_together_with_the_parent() {
        let Some((_guard, conn, _info)) = fixture("v2-mixed.db") else {
            return;
        };

        let result = delete_session(&conn, "ses_mixed_v2only_0101").expect("删除必须成功");
        assert_eq!(result.deleted_sessions, 2, "父会话 + v2 子会话");

        let remaining: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM main.session_v2
                 WHERE id IN ('ses_mixed_v2only_0101', 'ses_mixed_v2only_0102')",
                [],
                |row| row.get(0),
            )
            .expect("row count");
        assert_eq!(remaining, 0, "v2 递归：子会话必须一并删除");

        let messages: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM main.session_message
                 WHERE session_id IN ('ses_mixed_v2only_0101', 'ses_mixed_v2only_0102')",
                [],
                |row| row.get(0),
            )
            .expect("row count");
        assert_eq!(messages, 0, "子会话的消息也不能留下");
    }

    /// v1 删除保持 1.3.5 语义：只删所选会话，不连带删子会话。
    #[test]
    fn delete_keeps_v1_children_untouched() {
        let Some((_guard, conn, _info)) = fixture("test.db") else {
            return;
        };

        let result = delete_session(&conn, "96c5a5bc-4237-4b07-ac06-a7efab9cf637")
            .expect("删除必须成功");
        assert_eq!(result.deleted_sessions, 1, "v1 只删所选会话");

        let children: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM main.session
                 WHERE parent_id = '96c5a5bc-4237-4b07-ac06-a7efab9cf637'",
                [],
                |row| row.get(0),
            )
            .expect("row count");
        assert_eq!(children, 2, "v1 不递归：子会话必须保留");
    }

    /// v2 下重命名写 `session_v2`，旧表冻结副本不动。
    #[test]
    fn rename_updates_session_v2_title_and_keeps_the_legacy_copy_frozen() {
        let Some((_guard, conn, _info)) = fixture("v2-mixed.db") else {
            return;
        };

        assert!(rename_session(&conn, "ses_mixed_both_0201", "新标题").expect("重命名必须成功"));

        let title: String = conn
            .query_row(
                "SELECT title FROM main.session_v2 WHERE id = 'ses_mixed_both_0201'",
                [],
                |row| row.get(0),
            )
            .expect("title reads");
        assert_eq!(title, "新标题");

        let legacy_title: String = conn
            .query_row(
                "SELECT title FROM main.session WHERE id = 'ses_mixed_both_0201'",
                [],
                |row| row.get(0),
            )
            .expect("legacy title reads");
        assert_eq!(legacy_title, "v2-mixed 会话 3（旧表副本）", "旧表副本是冻结残留");
    }

    /// 混合库里的 legacy-only 会话改写 `main.session`（不是同名视图）。
    #[test]
    fn rename_updates_the_legacy_row_for_legacy_only_sessions() {
        let Some((_guard, conn, _info)) = fixture("v2-mixed.db") else {
            return;
        };

        assert!(rename_session(&conn, "ses_mixed_legacy_0301", "旧会话改名").expect("重命名必须成功"));

        let title: String = conn
            .query_row(
                "SELECT title FROM main.session WHERE id = 'ses_mixed_legacy_0301'",
                [],
                |row| row.get(0),
            )
            .expect("title reads");
        assert_eq!(title, "旧会话改名");
    }

    /// v1 行为逐字不变：重命名照样返回 true，不做存在性校验。
    #[test]
    fn rename_keeps_the_v1_behaviour() {
        let Some((_guard, conn, _info)) = fixture("test.db") else {
            return;
        };

        assert!(rename_session(&conn, "96c5a5bc-4237-4b07-ac06-a7efab9cf637", "v1 新标题")
            .expect("重命名必须成功"));
        let title: String = conn
            .query_row(
                "SELECT title FROM main.session WHERE id = '96c5a5bc-4237-4b07-ac06-a7efab9cf637'",
                [],
                |row| row.get(0),
            )
            .expect("title reads");
        assert_eq!(title, "v1 新标题");

        assert!(
            rename_session(&conn, "不存在的会话", "标题").expect("v1 不校验存在性"),
            "v1 保持返回 true"
        );
    }
}
