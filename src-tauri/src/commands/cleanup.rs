use std::collections::{BTreeSet, HashMap};

use rusqlite::ToSql;
use tauri::{AppHandle, Manager};

use crate::compat::{self, write};
use crate::db::{self, DbState};
use crate::models::dto::{
    CleanupFilter, CleanupPreviewDTO, CleanupResultDTO, CleanupSideDTO, IpcResult, SessionDTO,
};

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
    //   UNION SELECT ATTACH PRAGMA REPLACE（PR-2 安全修复 P2-5）
    if clause.contains(';') || clause.contains("--") || clause.contains("/*") {
        return false;
    }
    let upper = clause.to_uppercase();
    for keyword in &[
        "DROP",
        "DELETE",
        "INSERT",
        "UPDATE",
        "ALTER",
        "UNION",
        "SELECT",
        "ATTACH",
        "PRAGMA",
        "REPLACE",
    ] {
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

/// v1 预览/执行共用的会话聚合 JOIN。
///
/// 「按大小」策略依赖 `part_size.total`，预览与执行必须用同一套 JOIN，
/// 否则执行阶段会选到与预览不同的会话集合。
const V1_SESSION_JOINS: &str = "
           LEFT JOIN (SELECT session_id, COUNT(*) as cnt FROM message GROUP BY session_id) msg_cnt ON s.id = msg_cnt.session_id
           LEFT JOIN (SELECT session_id, SUM(LENGTH(data)) as total FROM part GROUP BY session_id) part_size ON s.id = part_size.session_id";

/// Build the WHERE clause for cleanup queries based on the filter strategy.
/// Returns (where_sql, params) where params is a list of bound values.
///
/// `size_expr` 是「会话体积」的表达式：v1 用 `part_size.total` 别名，
/// v2 用按会话的相关子查询（避免全库聚合）。
///
/// **不含排除集合**：用户取消勾选的会话 id 不能进 SQL 条件。排除必须在
/// 「展开 v2 后代之后」统一扣除，否则「先排除再展开」仍会把被排除会话的
/// 子会话算进来（PR-2 安全修复 P1-1）。统一口径见 [`subtract_excluded`]。
fn build_cleanup_where_clause(
    filter: &CleanupFilter,
    size_expr: Option<&str>,
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
            // v2 路径传 `None`：体积条件在 Rust 侧用同一份聚合结果判定，
            // 避免为了过滤再扫一遍 5.4 GB 的内容数据。
            if let Some(size_expr) = size_expr {
                let size_bytes = filter.size_mb.unwrap_or(100) * 1024 * 1024;
                conditions.push(format!("{} > ?", size_expr));
                params.push(Box::new(size_bytes));
            }
        }
        "project" => {
            // 前端「按项目」下拉的值来自 sessions:projects（DISTINCT directory），
            // 是项目目录而非 project 表的 project_id（后者是 .git HEAD / sha1）。
            // 会话列表（build_session_where）对同名字段同样按 `s.directory` 过滤，
            // 清理预览与执行共用这条 SQL，保证两者命中同一批候选会话。
            if let Some(ref dir) = filter.project_id {
                conditions.push("s.directory = ?".to_string());
                params.push(Box::new(dir.clone()));
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

    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };

    Ok((where_clause, params))
}

/// 用户在预览里取消勾选的会话 id。
fn excluded_ids(filter: &CleanupFilter) -> BTreeSet<String> {
    filter
        .excluded_session_ids
        .iter()
        .flatten()
        .cloned()
        .collect()
}

/// 清理的候选集合、目标集合与子会话集合。
///
/// - `children`：`all` 里的**子会话**（父会话也在 `all` 里）；
/// - `target`：真正会被删除的会话。
struct CleanupTargets {
    children: BTreeSet<String>,
    target: BTreeSet<String>,
}

/// 候选集合内的**子会话** id：父会话也在候选集合里的会话。
///
/// 只有 v2 递归语义下才有意义：删除父会话会连带删掉整棵子树，因此子会话
/// 不能单独取消勾选——只保留子会话就会留下 `parent_id` 悬空的孤儿
/// （会话页只显示根会话，孤儿会凭空消失）。
///
/// v1 不递归（删父不动子），没有孤儿问题 → 恒为空集合。
///
/// 查询走 `main.session_v2`（真实表，参数绑定）：父 id 用 `json_each` 展开，
/// 避免会话多时撞上 SQLite 的变量上限。
fn child_session_ids(
    conn: &rusqlite::Connection,
    candidate_ids: &[String],
) -> Result<BTreeSet<String>, String> {
    if candidate_ids.is_empty() {
        return Ok(BTreeSet::new());
    }
    if !compat::table_exists(conn, "session_v2").map_err(|e| e.to_string())? {
        // v1 库：没有 v2 会话树 → 没有子会话。
        return Ok(BTreeSet::new());
    }
    let ids_json = compat::json_array(candidate_ids);
    let mut stmt = conn
        .prepare(
            "SELECT id FROM main.session_v2
              WHERE parent_id IS NOT NULL
                AND parent_id IN (SELECT value FROM json_each(?1))
                AND id IN (SELECT value FROM json_each(?1))",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([&ids_json], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut children = BTreeSet::new();
    for row in rows {
        children.insert(row.map_err(|e| e.to_string())?);
    }
    Ok(children)
}

/// 由**已算好的命中根会话**解析候选集合、目标集合与子会话集合。
///
/// 目标集合口径（PR-2 安全修复 P2-2）：
/// ```text
/// ALL    = collect_targets(命中 filter 的根会话)
/// CHILD  = ALL 里「父会话也在 ALL 里」的会话
/// 有效排除 = excluded ∩ (ALL − CHILD)      // 只有根会话可以被排除
/// TARGET = ALL − collect_targets(有效排除)   // 排除根 → 扣整棵子树
/// ```
/// - 排除**父会话** → 整棵子树保留（不会出现 `parent_id` 悬空的孤儿）；
/// - 排除**子会话** → 被忽略（子会话随父删除，不能单独保留）。
///
/// v1 不递归：`CHILD` 恒为空、`collect_targets` 不展开，
/// 结果等价于「命中根 − excluded」，1.3.5 语义不变。
///
/// 命中根会话由调用方传入：预览已经算过一次（复用同一份聚合，避免在
/// 14.8 GB 真库上再扫一遍）。
fn resolve_cleanup_targets(
    conn: &rusqlite::Connection,
    filter: &CleanupFilter,
    matched_root_ids: &[String],
) -> Result<CleanupTargets, String> {
    let all = write::collect_targets(conn, matched_root_ids)?;
    let children = child_session_ids(conn, &all.iter().cloned().collect::<Vec<_>>())?;

    // 有效排除：命中的会话里、且不是子会话的那些（子会话不能单独排除）。
    let effective_excluded: BTreeSet<String> = excluded_ids(filter)
        .intersection(&all)
        .filter(|id| !children.contains(*id))
        .cloned()
        .collect();
    // 排除根 → 连同整棵子树一起保留。
    let excluded_subtrees =
        write::collect_targets(conn, &effective_excluded.iter().cloned().collect::<Vec<_>>())?;
    let target: BTreeSet<String> = all.difference(&excluded_subtrees).cloned().collect();

    Ok(CleanupTargets {
        children,
        target,
    })
}

/// v2 侧的会话聚合：一次 `GROUP BY session_id` 顺序扫描拿到「消息行数 + 体积」。
///
/// 禁止按会话的相关子查询：14.8 GB 真库上逐会话随机读页比顺序扫描慢 4~6 倍
/// （真库实测：逐会话 8.4 s / 顺序扫描 15.5 s）。这份聚合同时供预览列表、
/// 「按大小」过滤与分侧明细复用，不再扫第二遍。
///
/// 体积用 `octet_length`（**字节数**）而不是 `length`（字符数）：JSON 正文大多
/// 是 ASCII，两者只差 0.02%（真库 5.4387 B 字符 vs 5.4399 B 字节），但
/// `octet_length` 只需要记录头里的长度、不必读 overflow 页 —— 同一条聚合
/// 真库实测 15.3 s → 0.79 s。前端按 `formatBytes` 展示，字节数才是它的单位。
const V2_MESSAGE_AGG: &str =
    "SELECT session_id, COUNT(*) as cnt, SUM(octet_length(data)) as total \
     FROM main.session_message GROUP BY session_id";

// v2-only 收口：旧表（迁移后的冻结副本，legacy-only / 尾消息）不再是
// OpenCode-W 读或清理的对象，v2 路径的全部统计只来自 `session_message`。

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

/// 读取 `parent_id` 列（列不存在时返回 `None`）。
///
/// - v2 路径：`session` 兼容视图投影的 `parent_id` 来自 `main.session_v2`
///   （旧表独有的会话则来自 `main.session`）；
/// - v1 路径：`main.session.parent_id`；
/// - 极老的库可能根本没有这一列（见 `sessions::check_parent_column`），
///   此时按「根会话」处理，不让整行映射失败。
fn read_parent_id(row: &rusqlite::Row) -> rusqlite::Result<Option<String>> {
    match row.as_ref().column_index("parent_id") {
        Ok(index) => row.get::<_, Option<String>>(index),
        Err(_) => Ok(None),
    }
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
        // 父子归属：前端靠它把「取消父会话」精确到整棵子树。
        parent_id: read_parent_id(row)?,
    })
}

// ─── Commands ──────────────────────────────────────────────────────────────

/// cleanup:preview — preview sessions matching the cleanup filter.
///
/// 前端调用：`invokeSafe('cleanup:preview', filter)` — filter 是对象，
/// ipc.ts 把它作为 payload 字段直接传递，Tauri 自动 camelCase → snake_case
/// 转换后匹配到下面的命名参数。
///
/// v1 预览字段逐字不变；v2 / 混合库额外分列「v2 数据」与「旧版副本」。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn cleanup_preview(
    app: AppHandle,
    strategy: String,
    days: Option<i64>,
    size_m_b: Option<i64>,
    project_id: Option<String>,
    custom_where: Option<String>,
    excluded_session_ids: Option<Vec<String>>,
) -> IpcResult<CleanupPreviewDTO> {
    let state = app.state::<DbState>();
    let schema = state.schema();
    let db = state.clone_inner();
    tauri::async_runtime::spawn_blocking(move || {
        let filter = build_filter(strategy, days, size_m_b, project_id, custom_where, excluded_session_ids);

        let conn = match db::get_db(&db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };

        let env = compat::env(&conn, schema.as_ref());
        let preview = if env.is_v2() {
            build_v2_preview(&conn, &filter)
        } else {
            build_v1_preview(&conn, &filter)
        };

        match preview {
            Ok(preview) => IpcResult::ok(preview),
            Err(e) => IpcResult::err(e),
        }
    })
    .await
    .unwrap_or_else(|e| IpcResult::err(format!("thread error: {}", e)))
}

/// v1 预览：字段与 1.3.5 逐字一致（`session` 视图 + `message` / `part` 聚合）。
///
/// 排除集合在 Rust 侧扣除（v1 不递归，`TARGET = 命中根 − excluded`），
/// 计数只按**剩余会话**统计，因此预览与执行逐项相等。
/// `childSessionIds` 恒为空：v1 删父不动子，没有孤儿问题。
fn build_v1_preview(
    conn: &rusqlite::Connection,
    filter: &CleanupFilter,
) -> Result<CleanupPreviewDTO, String> {
    let (where_clause, params) =
        build_cleanup_where_clause(filter, Some("COALESCE(part_size.total, 0)"))?;

    let sql = format!(
        "SELECT s.*,
           COALESCE(msg_cnt.cnt, 0) as msg_count,
           (COALESCE(s.tokens_input, 0) + COALESCE(s.tokens_output, 0) + COALESCE(s.tokens_reasoning, 0)) as total_tokens,
           COALESCE(part_size.total, 0) as data_size
         FROM session s
         {V1_SESSION_JOINS}
         {}",
        where_clause
    );

    let params_refs: Vec<&dyn ToSql> = params.iter().map(|p| &**p).collect();

    let matched: Vec<SessionDTO> = {
        let mut stmt = match conn.prepare(&sql) {
            Ok(s) => s,
            Err(e) => return Err(e.to_string()),
        };
        let rows = match stmt.query_map(params_refs.as_slice(), map_session_row) {
            Ok(r) => r,
            Err(e) => return Err(e.to_string()),
        };
        rows.filter_map(|r| r.ok()).collect()
    };

    // 目标集合与 v2 路径同一套口径（v1 下 `collect_targets` 不展开）。
    let matched_ids: Vec<String> = matched.iter().map(|session| session.id.clone()).collect();
    let resolved = resolve_cleanup_targets(conn, filter, &matched_ids)?;
    let sessions: Vec<SessionDTO> = matched
        .into_iter()
        .filter(|session| resolved.target.contains(&session.id))
        .collect();

    if sessions.is_empty() {
        return Ok(CleanupPreviewDTO {
            session_count: 0,
            message_count: 0,
            part_count: 0,
            estimated_size: 0,
            sessions: Vec::new(),
            child_session_ids: Vec::new(),
            v2: None,
            legacy: None,
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

    Ok(CleanupPreviewDTO {
        session_count: sessions.len() as i64,
        message_count,
        part_count,
        estimated_size,
        sessions,
        child_session_ids: Vec::new(),
        v2: None,
        legacy: None,
    })
}

/// v2 / 混合库预览：会话数 / 消息数 / 内容块数 / 近似体积（v2-only）。
///
/// - 消息数：`session_message` 行；
/// - 内容块数：**消息行数**（v2 没有 `part` 表，不再解析 JSON，与
///   TASK-006 / 仪表盘 `part_count` 口径一致）；
/// - 体积：`session_message.data` 字节数。
///
/// v2-only 收口（1.4.0）：不再扫旧表聚合「旧版副本」——旧表是迁移后的冻结
/// 残留，legacy-only 会话与尾消息不是 OpenCode-W 的读/清理对象，v2-mixed
/// 与 v2-fresh 预览口径一致。
///
/// 性能（14.8 GB 真库）：聚合**只算一次**——`GROUP BY` 顺序扫描的结果
/// 在 Rust 侧按 session_id 合并给预览列表与体积过滤复用。
/// 绝不能把这些聚合挂进 `session` 视图的 JOIN：那是复合查询，
/// SQLite 会给每个分支各物化一次。
fn build_v2_preview(
    conn: &rusqlite::Connection,
    filter: &CleanupFilter,
) -> Result<CleanupPreviewDTO, String> {
    // ── 1) 聚合：只扫一次 ──
    let v2_agg = v2_message_agg(conn)?;

    // ── 2) 命中集合：体积条件在 Rust 侧判定（复用上面的聚合） ──
    let (where_clause, params) = build_cleanup_where_clause(filter, None)?;
    let params_refs: Vec<&dyn ToSql> = params.iter().map(|p| &**p).collect();
    let candidates = query_v2_sessions(conn, &format!("{V2_SESSION_SELECT} {where_clause}"), &params_refs)?;
    let matched: Vec<V2SessionRow> = candidates
        .into_iter()
        .filter(|row| size_filter_passes(row, filter, &v2_agg))
        .collect();

    if matched.is_empty() {
        return Ok(CleanupPreviewDTO {
            session_count: 0,
            message_count: 0,
            part_count: 0,
            estimated_size: 0,
            sessions: Vec::new(),
            child_session_ids: Vec::new(),
            v2: Some(CleanupSideDTO {
                session_count: 0,
                message_count: 0,
                part_count: 0,
                estimated_size: 0,
            }),
            legacy: None,
        });
    }

    // ── 3) 目标集合 = 命中集合 + v2 子会话 − 用户排除的会话 ──
    //       （与删除共用同一个解析函数，保证「预览 → 确认」删的就是预览里
    //        看到的那些会话；排除根会话会扣掉整棵子树）
    let matched_ids: Vec<String> = matched.iter().map(|row| row.dto.id.clone()).collect();
    let matched_id_set: BTreeSet<String> = matched_ids.iter().cloned().collect();
    let resolved = resolve_cleanup_targets(conn, filter, &matched_ids)?;
    let targets = &resolved.target;

    let mut rows: Vec<V2SessionRow> = matched
        .into_iter()
        .filter(|row| targets.contains(&row.dto.id))
        .collect();
    let extra_ids: Vec<String> = targets
        .iter()
        .filter(|id| !matched_id_set.contains(*id))
        .cloned()
        .collect();
    if !extra_ids.is_empty() {
        let ids_json = compat::json_array(&extra_ids);
        let extra = query_v2_sessions(
            conn,
            &format!("{V2_SESSION_SELECT} WHERE s.id IN (SELECT value FROM json_each(?1))"),
            &[&ids_json],
        )?;
        rows.extend(extra);
    }

    // ── 4) 把聚合结果合并进每一行，并汇总 v2 侧 ──
    let mut sessions: Vec<SessionDTO> = Vec::with_capacity(rows.len());
    let mut v2_messages = 0i64;
    let mut v2_bytes = 0i64;
    for row in rows {
        let v2_entry = v2_agg.get(&row.dto.id);
        let v2_count = v2_entry.map(|entry| entry.0).unwrap_or(0);
        let v2_total = v2_entry.map(|entry| entry.1).unwrap_or(0);

        v2_messages += v2_count;
        v2_bytes += v2_total;

        let mut dto = row.dto;
        dto.msg_count = v2_count;
        dto.data_size = v2_total;
        sessions.push(dto);
    }

    let session_ids: Vec<String> = sessions.iter().map(|dto| dto.id.clone()).collect();
    let ids_json = compat::json_array(&session_ids);

    let v2 = CleanupSideDTO {
        session_count: count_v2_sessions(conn, &ids_json)?,
        message_count: v2_messages,
        // v2 侧没有 part 表：内容块数按消息行数统计（与 TASK-006 / 仪表盘
        // part_count 口径一致），不再解析 JSON。
        part_count: v2_messages,
        estimated_size: v2_bytes,
    };

    Ok(CleanupPreviewDTO {
        session_count: sessions.len() as i64,
        message_count: v2.message_count,
        part_count: v2.part_count,
        estimated_size: v2.estimated_size,
        sessions,
        // 子会话（父会话也在结果里）：前端据此置灰，子会话不能单独取消勾选。
        child_session_ids: resolved
            .children
            .intersection(&resolved.target)
            .cloned()
            .collect(),
        v2: Some(v2),
        legacy: None,
    })
}

/// v2 路径命中的会话 id：与预览共用同一套判定，保证「预览 → 确认」同一批。
///
/// **不含排除集合**：排除在展开后代之后统一扣除（见 [`resolve_target_ids`]）。
///
/// 体积条件在 Rust 侧判定：复用同一份聚合结果，不为过滤再扫一遍 5.4 GB 内容数据。
fn match_v2_session_ids(
    conn: &rusqlite::Connection,
    filter: &CleanupFilter,
) -> Result<Vec<String>, String> {
    let (where_clause, params) = build_cleanup_where_clause(filter, None)?;
    let params_refs: Vec<&dyn ToSql> = params.iter().map(|p| &**p).collect();
    let rows = query_v2_sessions(
        conn,
        &format!("{V2_SESSION_SELECT} {where_clause}"),
        &params_refs,
    )?;
    // 体积条件在 Rust 侧判定：复用同一份聚合结果，不为过滤再扫一遍 5.4 GB 内容数据。
    if filter.strategy != "size" {
        return Ok(rows.into_iter().map(|row| row.dto.id).collect());
    }
    let v2_agg = v2_message_agg(conn)?;
    Ok(rows
        .into_iter()
        .filter(|row| size_filter_passes(row, filter, &v2_agg))
        .map(|row| row.dto.id)
        .collect())
}

/// 命中 filter 的**根会话** id（v1 / v2 通用）。
///
/// - v2 路径：体积条件在 Rust 侧判定（复用同一份聚合结果）；
/// - v1 路径：体积条件在 SQL 里判定（`part_size.total` 别名）。
///
/// 不含排除集合，也不含 v2 后代：这两步都在 [`resolve_target_ids`] 里统一做。
fn match_root_ids(
    conn: &rusqlite::Connection,
    filter: &CleanupFilter,
    env: &compat::Env,
) -> Result<Vec<String>, String> {
    if env.is_v2() {
        return match_v2_session_ids(conn, filter);
    }

    let (where_clause, params) =
        build_cleanup_where_clause(filter, Some("COALESCE(part_size.total, 0)"))?;
    let id_sql = format!(
        "SELECT s.id FROM session s {} {}",
        V1_SESSION_JOINS, where_clause
    );
    let params_refs: Vec<&dyn ToSql> = params.iter().map(|p| &**p).collect();
    let mut stmt = match conn.prepare(&id_sql) {
        Ok(s) => s,
        Err(e) => return Err(e.to_string()),
    };
    let rows = match stmt.query_map(params_refs.as_slice(), |row| row.get::<_, String>(0)) {
        Ok(r) => r,
        Err(e) => return Err(e.to_string()),
    };
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// 目标会话集合（预览与执行共用）。
///
/// 口径见 [`resolve_cleanup_targets`]：`ALL = collect_targets(命中 filter 的
/// 根会话)`、`TARGET = ALL − collect_targets(有效排除)`。
/// - v2：排除根会话 → 扣整棵子树；排除子会话 → 被忽略；
/// - v1：不递归，`TARGET = 命中根 − excluded`（1.3.5 语义不变）。
///
/// 预览返回的行与执行删除的集合都等于 `TARGET`（PR-2 安全修复 P1-1 / P2-2）。
fn resolve_target_ids(
    conn: &rusqlite::Connection,
    filter: &CleanupFilter,
    env: &compat::Env,
) -> Result<Vec<String>, String> {
    let roots = match_root_ids(conn, filter, env)?;
    let targets = resolve_cleanup_targets(conn, filter, &roots)?;
    Ok(targets.target.into_iter().collect())
}

/// 「按大小」策略在 Rust 侧判定：复用同一份聚合结果，不为过滤再扫一遍。
/// v2-only：体积只看 `session_message.data`（v2 没有 `part` 表）。
fn size_filter_passes(
    row: &V2SessionRow,
    filter: &CleanupFilter,
    v2_agg: &HashMap<String, (i64, i64)>,
) -> bool {
    if filter.strategy != "size" {
        return true;
    }
    let threshold = filter.size_mb.unwrap_or(100) * 1024 * 1024;
    let v2_total = v2_agg.get(&row.dto.id).map(|entry| entry.1).unwrap_or(0);
    v2_total > threshold
}

/// v2 侧的每会话聚合：消息行数与体积（一次 `GROUP BY` 顺序扫描）。
fn v2_message_agg(
    conn: &rusqlite::Connection,
) -> Result<HashMap<String, (i64, i64)>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT session_id, cnt, total FROM ({V2_MESSAGE_AGG})"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                (row.get::<_, i64>(1)?, row.get::<_, i64>(2)?),
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut map = HashMap::new();
    for row in rows {
        let (session_id, entry) = row.map_err(|e| e.to_string())?;
        map.insert(session_id, entry);
    }
    Ok(map)
}

/// v2 侧的会话行数（只数存在于 `session_v2` 的命中会话）。
fn count_v2_sessions(conn: &rusqlite::Connection, ids_json: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM main.session_v2 WHERE id IN (SELECT value FROM json_each(?1))",
        [ids_json],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

/// v2 预览的一行：会话本体（消息数与体积在 Rust 侧按聚合结果填充）。
#[derive(Debug, Clone)]
struct V2SessionRow {
    dto: SessionDTO,
}

/// v2 会话查询：只取会话本体，不带聚合 JOIN。
///
/// 聚合单独算一次后在 Rust 侧合并：挂在 `session` 视图的 JOIN 上会被复合查询
/// 的每个分支各物化一次（真库实测 148 s vs 38.7 s）。
const V2_SESSION_SELECT: &str = "SELECT s.*,
           0 as msg_count,
           (COALESCE(s.tokens_input, 0) + COALESCE(s.tokens_output, 0) + COALESCE(s.tokens_reasoning, 0)) as total_tokens,
           0 as data_size
         FROM session s";

fn map_v2_session_row(row: &rusqlite::Row) -> rusqlite::Result<V2SessionRow> {
    Ok(V2SessionRow {
        dto: map_session_row(row)?,
    })
}

/// 执行一条 v2 会话查询。
fn query_v2_sessions(
    conn: &rusqlite::Connection,
    sql: &str,
    params: &[&dyn ToSql],
) -> Result<Vec<V2SessionRow>, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params, map_v2_session_row)
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// cleanup:execute — delete sessions matching the filter, then VACUUM.
///
/// 删除集合 = 命中 filter 的根会话 → 展开 v2 后代 → **扣除用户取消勾选的会话**，
/// 与预览返回的行**完全一致**（PR-2 安全修复 P1-1）。删除走**精确删除**
/// （不二次递归），因此被排除的会话与它的子会话都不会被连带删除。
///
/// 前端调用：`invokeSafe('cleanup:execute', filter)` — filter 是对象，
/// ipc.ts 把它作为 payload 字段直接传递，Tauri 自动 camelCase → snake_case
/// 转换后匹配到下面的命名参数。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn cleanup_execute(
    app: AppHandle,
    strategy: String,
    days: Option<i64>,
    size_m_b: Option<i64>,
    project_id: Option<String>,
    custom_where: Option<String>,
    excluded_session_ids: Option<Vec<String>>,
) -> IpcResult<CleanupResultDTO> {
    let state = app.state::<DbState>();
    if let Err(e) = db::ensure_writable(&state) {
        return IpcResult::err(e);
    }
    let state = state.inner().clone();
    let schema = state.schema();
    let db = state.clone_inner();
    tauri::async_runtime::spawn_blocking(move || {
        let filter = build_filter(strategy, days, size_m_b, project_id, custom_where, excluded_session_ids);

        let conn = match db::get_db(&db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };

        // 实时迁移闸门：缓存可能是开库时的旧值（OpenCode 之后才启动迁移）。
        if let Err(e) = db::ensure_writable_conn(&conn) {
            return IpcResult::err(e);
        }

        let env = compat::env(&conn, schema.as_ref());

        // 目标集合：命中 filter 的根会话 → 展开 v2 后代 → 扣除用户排除的会话。
        // 与预览共用 [`resolve_target_ids`]：删的就是预览里看到的那些会话。
        let session_ids: Vec<String> = match resolve_target_ids(&conn, &filter, &env) {
            Ok(ids) => ids,
            Err(e) => return IpcResult::err(e),
        };

        if session_ids.is_empty() {
            return IpcResult::ok(CleanupResultDTO {
                deleted_sessions: 0,
                deleted_messages: 0,
                deleted_parts: 0,
                freed_bytes: 0,
                vacuum_before: 0,
                vacuum_after: 0,
                vacuum_error: None,
                v2: env.is_v2().then_some(CleanupSideDTO {
                    session_count: 0,
                    message_count: 0,
                    part_count: 0,
                    estimated_size: 0,
                }),
                legacy: legacy_side_if_any(&write::DeleteOutcome::default(), env.is_v2()),
            });
        }

        // **精确删除**：集合已经算好，不再二次递归。
        // 递归删除会把用户取消勾选的会话的子会话一并删掉（P1-1）。
        let outcome = match write::delete_sessions_exact(&conn, &session_ids) {
            Ok(outcome) => outcome,
            Err(e) => return IpcResult::err(e),
        };
        // 写后一致性：刷新失败不影响已经生效的删除，只记日志。
        crate::commands::fork_stats::invalidate_cache();
        if let Err(error) = state.refresh_schema_counts(&conn) {
            log::warn!("刷新 schema 计数失败：{}", error);
        }

        // VACUUM to reclaim space (must be outside a transaction)。
        // 删除事务已提交：VACUUM 失败只降级为空闲空间未回收，不能把成功
        // 的删除报告成失败（否则前端会误以为数据仍在）。
        let (vacuum_before, vacuum_after, vacuum_error) = vacuum_database(&conn);

        IpcResult::ok(CleanupResultDTO {
            deleted_sessions: outcome.sessions,
            deleted_messages: outcome.messages(),
            deleted_parts: outcome.parts(),
            freed_bytes: outcome.bytes(),
            vacuum_before,
            vacuum_after,
            vacuum_error,
            v2: env.is_v2().then(|| outcome.v2_side()),
            legacy: legacy_side_if_any(&outcome, env.is_v2()),
        })
    })
    .await
    .unwrap_or_else(|e| IpcResult::err(format!("thread error: {}", e)))
}

/// v2 形态下旧版副本侧恒为 `None`（v2-only：不再触碰旧表）；
/// 纯 v1 库保留旧行为：删除了旧表行才返回明细。
fn legacy_side_if_any(outcome: &write::DeleteOutcome, is_v2: bool) -> Option<CleanupSideDTO> {
    if is_v2
        || (outcome.legacy_session_rows == 0
            && outcome.legacy_message_rows == 0
            && outcome.legacy_part_rows == 0
            && outcome.legacy_bytes == 0)
    {
        return None;
    }
    Some(outcome.legacy_side())
}

/// 删除提交后回收磁盘空间（VACUUM 必须在事务之外）。
///
/// 返回 `(before, after, error)`：**VACUUM 失败不代表删除失败**。删除事务一旦
/// 提交，数据就已经按预览删掉了；VACUUM 失败只意味着空闲页还没还给文件系统，
/// 因此降级为 `vacuum_error` 字段，让前端提示「空间未回收」而不是「操作失败」。
fn vacuum_database(conn: &rusqlite::Connection) -> (i64, i64, Option<String>) {
    match conn.path() {
        Some(path) => {
            let current_path = path.to_string();
            let before = std::fs::metadata(&current_path)
                .ok()
                .map(|m| m.len() as i64)
                .unwrap_or(0);
            let error = match crate::db::vacuum_with_temp_view_guard(conn) {
                Ok(()) => None,
                Err(e) => {
                    // 失败必须有完整上下文（库内对象 / 文件尺寸），独立复跑
                    // 往往无法复现；删除语义不变，仅日志更详细。
                    log::warn!(
                        "清理后 VACUUM 失败（删除已生效）：error={} before={}B {}",
                        e,
                        before,
                        crate::db::vacuum_context_summary(conn)
                    );
                    Some(e.to_string())
                }
            };
            let after = std::fs::metadata(&current_path)
                .ok()
                .map(|m| m.len() as i64)
                .unwrap_or(0);
            (before, after, error)
        }
        None => (0, 0, Some("No database path".to_string())),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use rusqlite::Connection;
    use rusqlite::types::ValueRef;

    use super::{
        build_cleanup_where_clause, build_filter, build_v1_preview, build_v2_preview,
        resolve_target_ids, validate_custom_where,
    };
    use crate::compat;

    /// 「按项目」策略的过滤值必须按项目目录口径匹配（`s.directory`）。
    /// 下拉的候选值来自 sessions:projects 的 DISTINCT directory；若错配成
    /// `s.project_id`（.git HEAD / sha1），预览永远为空 —— 这是 v1.4 修复的
    /// 用户可见 bug，测试用来锁住口径。
    #[test]
    fn project_strategy_filters_by_directory() {
        let filter = build_filter(
            "project".to_string(),
            None,
            None,
            Some("/Users/webb/dev/demo".to_string()),
            None,
            None,
        );
        let (where_sql, params) = build_cleanup_where_clause(&filter, None).unwrap();
        assert!(where_sql.contains("s.directory = ?"), "{where_sql}");
        assert!(!where_sql.contains("s.project_id"), "{where_sql}");
        assert_eq!(params.len(), 1);
        assert_eq!(
            params[0].to_sql().unwrap(),
            rusqlite::types::ToSqlOutput::Borrowed(ValueRef::Text(b"/Users/webb/dev/demo"))
        );
    }

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

    /// 夹具缺失时的处置策略：CI 下必须失败（避免静默 skip 造成假绿），
    /// 本地保留 `[skip]`。口径与 `schema::fixture_tests` 一致。
    fn missing_fixture(file: &str) -> Option<String> {
        if std::env::var_os("CI").is_some() {
            Some(format!(
                "夹具缺失，检查 Generate test fixtures 步骤：缺少 test-data/{file}（本地可先执行 `npm run generate-fixture` 或 `npm run generate-fixture:v2`）"
            ))
        } else {
            None
        }
    }

    fn fixture(file: &str) -> Option<(TempFixture, Connection, compat::Env)> {
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
            "ocw-cleanup-it-{}-{counter}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("temp dir is created");
        let path = dir.join("fixture.db");
        fs::copy(&source, &path).expect("fixture is copied");
        let conn = Connection::open(&path).expect("fixture opens");
        let info = compat::test_support::open_env(&conn);
        let env = compat::env(&conn, Some(&info));
        Some((TempFixture { dir }, conn, env))
    }

    /// 命中全部会话的筛选条件（`custom` 策略的白名单允许 `1=1`）。
    fn all_sessions_filter() -> crate::models::dto::CleanupFilter {
        build_filter(
            "custom".to_string(),
            None,
            None,
            None,
            Some("1=1".to_string()),
            None,
        )
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |row| row.get(0)).expect("row count")
    }

    /// v2-mixed 预览（v2-only 收口）：只统计 v2 表，与 v2-fresh 同口径；
    /// 与实际删除行数一致。
    #[test]
    fn v2_mixed_preview_counts_v2_rows_only() {
        let Some((_guard, conn, env)) = fixture("v2-mixed.db") else {
            return;
        };
        assert!(env.is_v2());

        let preview = build_v2_preview(&conn, &all_sessions_filter()).expect("预览必须成功");

        assert_eq!(preview.session_count, 6, "视图只暴露 6 个 v2 会话");
        assert!(preview.legacy.is_none(), "v2-only：不再输出旧版副本明细");

        let v2 = preview.v2.as_ref().expect("v2 侧明细");
        assert_eq!(v2.session_count, 6);
        assert_eq!(v2.message_count, 20, "session_message 行数");
        assert_eq!(v2.part_count, 20, "v2 无 part 表：内容块数按消息行数统计");
        assert_eq!(v2.estimated_size, 5165, "session_message.data 字节数（octet_length）");

        assert_eq!(preview.message_count, 20);
        assert_eq!(preview.part_count, 20);
        assert_eq!(preview.estimated_size, 5165);

        // 会话级计数与顶层计数必须自洽（否则列表里的数字会和汇总对不上）。
        assert_eq!(
            preview.sessions.iter().map(|s| s.msg_count).sum::<i64>(),
            preview.message_count
        );
        assert_eq!(
            preview.sessions.iter().map(|s| s.data_size).sum::<i64>(),
            preview.estimated_size
        );
    }

    /// 预览计数必须与实际删除行数一致（v2-only：只删 v2 表，旧表原样保留）。
    #[test]
    fn v2_mixed_execute_matches_the_preview_counts() {
        let Some((_guard, conn, env)) = fixture("v2-mixed.db") else {
            return;
        };
        assert!(env.is_v2());

        let preview = build_v2_preview(&conn, &all_sessions_filter()).expect("预览必须成功");
        let session_ids: Vec<String> = preview.sessions.iter().map(|s| s.id.clone()).collect();

        let outcome = compat::write::delete_sessions(&conn, &session_ids).expect("删除必须成功");

        assert_eq!(outcome.sessions, preview.session_count);
        assert_eq!(outcome.messages(), preview.message_count);
        assert_eq!(outcome.parts(), preview.part_count);
        assert_eq!(outcome.bytes(), preview.estimated_size);

        let v2 = outcome.v2_side();
        let expected = preview.v2.as_ref().expect("v2 侧");
        assert_eq!(v2.session_count, expected.session_count);
        assert_eq!(v2.message_count, expected.message_count);
        assert_eq!(v2.part_count, expected.part_count);
        assert_eq!(v2.estimated_size, expected.estimated_size);

        // v2 表清空；旧表冻结副本不再被触碰。
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM main.session_v2"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM main.session_message"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM main.session"), 3);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM main.message"), 7);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM main.part"), 11);
    }

    /// v2-fresh 库没有旧表：预览与删除都不能报 `no such table`。
    #[test]
    fn v2_fresh_cleanup_works_without_legacy_tables() {
        let Some((_guard, conn, env)) = fixture("v2-fresh.db") else {
            return;
        };
        assert!(env.is_v2());

        let preview = build_v2_preview(&conn, &all_sessions_filter()).expect("预览必须成功");
        assert_eq!(preview.session_count, 6, "v2-fresh 夹具共 6 个会话");
        assert!(preview.legacy.is_none(), "没有旧表就不该有旧版副本明细");
        let v2 = preview.v2.as_ref().expect("v2 侧明细");
        assert_eq!(v2.session_count, 6);
        assert_eq!(v2.message_count, 20);
        assert_eq!(v2.part_count, 20, "v2 无 part 表：内容块数按消息行数统计");
        assert_eq!(v2.estimated_size, 5165, "session_message.data 字节数（octet_length）");

        let session_ids: Vec<String> = preview.sessions.iter().map(|s| s.id.clone()).collect();
        let outcome = compat::write::delete_sessions(&conn, &session_ids).expect("删除必须成功");
        assert_eq!(outcome.sessions, 6);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM main.session_v2"), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM main.session_message"), 0);
    }

    /// v1 预览字段逐字不变：数值与 1.3.5 一致，且不出现 v2 / legacy 字段。
    #[test]
    fn v1_preview_keeps_the_legacy_fields_and_omits_the_v2_breakdown() {
        let Some((_guard, conn, env)) = fixture("test.db") else {
            return;
        };
        assert!(!env.is_v2());

        let preview = build_v1_preview(&conn, &all_sessions_filter()).expect("预览必须成功");
        assert_eq!(preview.session_count, 5);
        assert_eq!(preview.message_count, 20);
        assert_eq!(preview.part_count, 80);
        assert_eq!(preview.estimated_size, 14020);
        assert!(preview.v2.is_none());
        assert!(preview.legacy.is_none());

        let json = serde_json::to_value(&preview).expect("预览可序列化");
        assert!(json.get("v2").is_none(), "v1 输出不得出现 v2 字段");
        assert!(json.get("legacy").is_none(), "v1 输出不得出现 legacy 字段");
    }

    /// v1 删除：只删所选会话，不递归子会话（保持 1.3.5 语义）。
    #[test]
    fn v1_delete_keeps_the_legacy_semantics_without_recursing_children() {
        let Some((_guard, conn, env)) = fixture("test.db") else {
            return;
        };
        assert!(!env.is_v2());

        let outcome =
            compat::write::delete_sessions(&conn, &["96c5a5bc-4237-4b07-ac06-a7efab9cf637".to_string()])
                .expect("删除必须成功");

        assert_eq!(outcome.sessions, 1, "v1 只删所选会话，不连带删子会话");
        assert_eq!(outcome.messages(), 7);
        assert_eq!(outcome.parts(), 28);
        assert!(outcome.v2_session_rows == 0 && outcome.v2_message_rows == 0);
        assert_eq!(
            outcome.legacy_bytes, 4519,
            "v1 路径的体积保持字符数历史口径（不因 v2 改字节而变动）"
        );

        // 两个子会话必须还在。
        let children: i64 = count(
            &conn,
            "SELECT COUNT(*) FROM main.session WHERE parent_id = '96c5a5bc-4237-4b07-ac06-a7efab9cf637'",
        );
        assert_eq!(children, 2, "v1 不递归：子会话必须保留");
    }

    /// v2 删除会递归子会话（v2 树），预览与执行看到的是同一批会话。
    #[test]
    fn v2_preview_and_execute_share_the_same_target_set() {
        let Some((_guard, conn, env)) = fixture("v2-mixed.db") else {
            return;
        };
        assert!(env.is_v2());

        // 只命中父会话：子会话 0102 不在过滤结果里，但会被 v2 后代展开带上。
        let filter = build_filter(
            "custom".to_string(),
            None,
            None,
            None,
            Some("s.id = 'ses_mixed_v2only_0101'".to_string()),
            None,
        );
        let preview = build_v2_preview(&conn, &filter).expect("预览必须成功");
        let preview_ids: Vec<&str> = preview.sessions.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(
            preview_ids,
            vec!["ses_mixed_v2only_0101", "ses_mixed_v2only_0102"],
            "预览必须包含 v2 后代，否则用户看到的和被删的不是同一批"
        );

        let targets = resolve_target_ids(&conn, &filter, &env).expect("目标集合必须算得出");
        assert_eq!(
            targets,
            vec![
                "ses_mixed_v2only_0101".to_string(),
                "ses_mixed_v2only_0102".to_string()
            ],
            "删除集合必须与预览逐项相等"
        );

        let outcome = compat::write::delete_sessions_exact(&conn, &targets).expect("删除必须成功");
        assert_eq!(outcome.sessions, preview.session_count);
        assert_eq!(outcome.messages(), preview.message_count);
        assert_eq!(outcome.parts(), preview.part_count);
        assert_eq!(outcome.bytes(), preview.estimated_size);
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM main.session_v2
                 WHERE id IN ('ses_mixed_v2only_0101', 'ses_mixed_v2only_0102')"
            ),
            0,
            "v2 后代必须一并删除"
        );
    }

    /// P2-5：自定义 WHERE 的关键字黑名单必须挡住「改写删除目标集合」的语句。
    ///
    /// `UNION` / `SELECT` 原本能通过校验：渲染进程可以借此把条件子查询拼进
    /// WHERE，让删除落到别的会话上。UI 目前不产生 `custom_where`，加黑名单
    /// 不影响正常用户。
    #[test]
    fn custom_where_rejects_clauses_that_could_rewrite_the_target_set() {
        for clause in [
            "SELECT id FROM session",
            "1=1 UNION SELECT id FROM session",
            "1=1 UNION ALL SELECT id FROM session",
            "1=1 ATTACH DATABASE '/tmp/other.db' AS other",
            "1=1 PRAGMA writable_schema = 1",
            "1=1 REPLACE INTO session (id) VALUES ('x')",
            // 大小写不敏感
            "1=1 union select id from session",
            "1=1 PrAgMa writable_schema = 1",
        ] {
            assert!(
                !validate_custom_where(clause),
                "必须拒绝这条自定义条件：{clause}"
            );
        }

        // 正常条件仍然放行（黑名单不能误伤）。
        for clause in [
            "1=1",
            "s.id = 'ses_x'",
            "s.id IN ('ses_a','ses_b')",
            "s.time_updated > 1 AND s.parent_id IS NULL",
            "s.title LIKE '%demo%'",
        ] {
            assert!(
                validate_custom_where(clause),
                "不该拒绝这条自定义条件：{clause}"
            );
        }
    }

    /// P2-2 补充：预览行带**父子归属**（`parentId`）。
    ///
    /// `childSessionIds` 只说明「这是子会话」，说不出属于哪个父会话；
    /// 前端要靠 `parentId` 才能把「取消父会话」精确到整棵子树。
    #[test]
    fn v2_mixed_preview_exposes_the_parent_child_relation() {
        let Some((_guard, conn, env)) = fixture("v2-mixed.db") else {
            return;
        };
        assert!(env.is_v2());

        let filter = build_filter(
            "custom".to_string(),
            None,
            None,
            None,
            Some("s.id IN ('ses_mixed_v2only_0101','ses_mixed_v2only_0102')".to_string()),
            None,
        );
        let preview = build_v2_preview(&conn, &filter).expect("预览必须成功");

        let parent = preview
            .sessions
            .iter()
            .find(|session| session.id == "ses_mixed_v2only_0101")
            .expect("父会话在预览里");
        assert_eq!(parent.parent_id, None, "根会话没有父会话");

        let child = preview
            .sessions
            .iter()
            .find(|session| session.id == "ses_mixed_v2only_0102")
            .expect("子会话在预览里");
        assert_eq!(
            child.parent_id.as_deref(),
            Some("ses_mixed_v2only_0101"),
            "子会话必须带上父会话 id（v2 取 session_v2.parent_id）"
        );

        // DTO 契约：字段名是 `parentId`；缺省时不下发（向后兼容）。
        let json = serde_json::to_value(&preview).expect("预览可序列化");
        let rows = json["sessions"].as_array().expect("sessions 是数组");
        let child_json = rows
            .iter()
            .find(|row| row["id"] == "ses_mixed_v2only_0102")
            .expect("子会话行");
        assert_eq!(child_json["parentId"], "ses_mixed_v2only_0101");
        let parent_json = rows
            .iter()
            .find(|row| row["id"] == "ses_mixed_v2only_0101")
            .expect("父会话行");
        assert!(
            parent_json.get("parentId").is_none(),
            "没有父会话时不下发 parentId：{parent_json}"
        );
    }

    /// P2-2 补充：v1 预览同样带父子归属（取 `session.parent_id`）。
    #[test]
    fn v1_preview_exposes_the_parent_child_relation() {
        let Some((_guard, conn, env)) = fixture("test.db") else {
            return;
        };
        assert!(!env.is_v2());

        let preview = build_v1_preview(&conn, &all_sessions_filter()).expect("预览必须成功");

        let parent = preview
            .sessions
            .iter()
            .find(|session| session.id == "96c5a5bc-4237-4b07-ac06-a7efab9cf637")
            .expect("父会话在预览里");
        assert_eq!(parent.parent_id, None, "根会话没有父会话");

        let child = preview
            .sessions
            .iter()
            .find(|session| session.id == "ff6feeb6-8bf6-4cff-9791-23c056973e36")
            .expect("子会话在预览里");
        assert_eq!(
            child.parent_id.as_deref(),
            Some("96c5a5bc-4237-4b07-ac06-a7efab9cf637"),
            "子会话必须带上父会话 id（v1 取 session.parent_id）"
        );
    }

    /// P2-2：子会话**不能单独保留**——取消勾选子会话会被忽略，它随父会话一起删除。
    ///
    /// 若允许单独保留子会话而删掉父会话，就会留下 `parent_id` 悬空的孤儿
    /// （会话页只显示根会话，孤儿会凭空消失）。
    #[test]
    fn v2_mixed_excluded_child_is_still_deleted_with_its_parent() {
        let Some((_guard, conn, env)) = fixture("v2-mixed.db") else {
            return;
        };
        assert!(env.is_v2());

        let filter = build_filter(
            "custom".to_string(),
            None,
            None,
            None,
            Some("s.id IN ('ses_mixed_v2only_0101','ses_mixed_v2only_0102')".to_string()),
            Some(vec!["ses_mixed_v2only_0102".to_string()]),
        );

        let preview = build_v2_preview(&conn, &filter).expect("预览必须成功");
        let preview_ids: Vec<&str> = preview.sessions.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(
            preview_ids,
            vec!["ses_mixed_v2only_0101", "ses_mixed_v2only_0102"],
            "子会话仍要出现在预览里（前端要展示并置灰）"
        );
        assert_eq!(
            preview.child_session_ids,
            vec!["ses_mixed_v2only_0102".to_string()],
            "预览必须标出子会话：前端据此把它置灰"
        );

        let targets = resolve_target_ids(&conn, &filter, &env).expect("目标集合必须算得出");
        assert_eq!(
            targets,
            vec![
                "ses_mixed_v2only_0101".to_string(),
                "ses_mixed_v2only_0102".to_string()
            ],
            "排除子会话被忽略：子会话随父删除"
        );

        let outcome = compat::write::delete_sessions_exact(&conn, &targets).expect("删除必须成功");
        assert_eq!(outcome.sessions, preview.session_count);
        assert_eq!(outcome.messages(), preview.message_count);
        assert_eq!(outcome.parts(), preview.part_count);
        assert_eq!(outcome.bytes(), preview.estimated_size);

        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM main.session_v2 WHERE id = 'ses_mixed_v2only_0102'"
            ),
            0,
            "子会话随父删除"
        );
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM main.session_message WHERE session_id = 'ses_mixed_v2only_0102'"
            ),
            0,
            "子会话的消息一并删除"
        );
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM main.session_v2 WHERE id = 'ses_mixed_v2only_0101'"
            ),
            0,
            "父会话必须被删除"
        );
    }

    /// P2-2：取消勾选**父会话** → 整棵子树保留（不会出现 parent_id 悬空的孤儿）。
    #[test]
    fn v2_mixed_excluded_parent_keeps_the_whole_subtree() {
        let Some((_guard, conn, env)) = fixture("v2-mixed.db") else {
            return;
        };
        assert!(env.is_v2());

        let filter = build_filter(
            "custom".to_string(),
            None,
            None,
            None,
            Some("s.id IN ('ses_mixed_v2only_0101','ses_mixed_v2only_0102')".to_string()),
            Some(vec!["ses_mixed_v2only_0101".to_string()]),
        );

        let preview = build_v2_preview(&conn, &filter).expect("预览必须成功");
        assert_eq!(
            preview.session_count, 0,
            "目标集合为空：没有待删除的会话"
        );
        assert!(preview.sessions.is_empty());

        let targets = resolve_target_ids(&conn, &filter, &env).expect("目标集合必须算得出");
        assert!(
            targets.is_empty(),
            "排除父会话 → 整棵子树保留：{targets:?}"
        );

        let outcome = compat::write::delete_sessions_exact(&conn, &targets).expect("删除必须成功");
        assert_eq!(outcome.sessions, 0);

        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM main.session_v2 WHERE id = 'ses_mixed_v2only_0101'"
            ),
            1,
            "父会话必须保留"
        );
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM main.session_v2 WHERE id = 'ses_mixed_v2only_0102'"
            ),
            1,
            "子会话随父保留：不能出现 parent_id 悬空的孤儿"
        );
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM main.session_message WHERE session_id = 'ses_mixed_v2only_0102'"
            ),
            2,
            "保留的子会话的消息也必须保留"
        );
    }

    /// P2-2 的 v1 对照：v1 不递归（删父不动子），没有孤儿问题，
    /// 因此子会话仍可单独取消勾选。
    #[test]
    fn v1_child_sessions_can_still_be_excluded_individually() {
        let Some((_guard, conn, env)) = fixture("test.db") else {
            return;
        };
        assert!(!env.is_v2());

        let parent = "96c5a5bc-4237-4b07-ac06-a7efab9cf637";
        let child = "ff6feeb6-8bf6-4cff-9791-23c056973e36";
        // 只命中子会话（它的 `time_updated` 比父会话更早）。
        let only_child = "s.time_updated < 1792330000000";

        let filter = build_filter(
            "custom".to_string(),
            None,
            None,
            None,
            Some(only_child.to_string()),
            Some(vec![child.to_string()]),
        );

        let preview = build_v1_preview(&conn, &filter).expect("预览必须成功");
        assert!(
            preview.child_session_ids.is_empty(),
            "v1 没有子会话概念：childSessionIds 恒为空"
        );
        assert_eq!(preview.session_count, 0, "被排除的子会话不在预览里");

        let targets = resolve_target_ids(&conn, &filter, &env).expect("目标集合必须算得出");
        assert!(
            targets.is_empty(),
            "v1：排除子会话仍然有效（不递归，不会产生孤儿）"
        );

        let outcome = compat::write::delete_sessions_exact(&conn, &targets).expect("删除必须成功");
        assert_eq!(outcome.sessions, 0);

        assert_eq!(
            count(
                &conn,
                &format!("SELECT COUNT(*) FROM main.session WHERE id = '{}'", child)
            ),
            1,
            "被排除的子会话必须保留"
        );
        assert_eq!(
            count(
                &conn,
                &format!("SELECT COUNT(*) FROM main.session WHERE id = '{}'", parent)
            ),
            1,
            "父会话必须保留"
        );
    }

    /// P1-1 的 v1 对照：v1 不递归，删除集合 = 命中根 − 排除。
    #[test]
    fn v1_cleanup_excludes_without_recursing_children() {
        let Some((_guard, conn, env)) = fixture("test.db") else {
            return;
        };
        assert!(!env.is_v2());

        let parent = "96c5a5bc-4237-4b07-ac06-a7efab9cf637";
        // 只命中父会话：父会话的 `time_updated` 落在两个子会话之间。
        // （自定义 WHERE 不允许 `-`，因此用时间区间而不是 id 定位。）
        let only_parent = "s.time_updated > 1792329374316 AND s.time_updated < 1792331174316";

        // ① 命中父会话且父会话被排除 → 目标集合为空。
        let filter = build_filter(
            "custom".to_string(),
            None,
            None,
            None,
            Some(only_parent.to_string()),
            Some(vec![parent.to_string()]),
        );
        let preview = build_v1_preview(&conn, &filter).expect("预览必须成功");
        assert_eq!(preview.session_count, 0, "被排除的会话不得出现在预览里");
        assert!(preview.sessions.is_empty());

        let targets = resolve_target_ids(&conn, &filter, &env).expect("目标集合必须算得出");
        assert!(
            targets.is_empty(),
            "被排除的会话不得进入删除集合：{targets:?}"
        );
        let outcome = compat::write::delete_sessions_exact(&conn, &targets).expect("删除必须成功");
        assert_eq!(outcome.sessions, 0);

        assert_eq!(
            count(
                &conn,
                &format!("SELECT COUNT(*) FROM main.session WHERE id = '{}'", parent)
            ),
            1,
            "被排除的父会话必须保留"
        );
        assert_eq!(
            count(
                &conn,
                &format!(
                    "SELECT COUNT(*) FROM main.session WHERE parent_id = '{}'",
                    parent
                )
            ),
            2,
            "子会话必须保留"
        );

        // ② 命中父会话且不排除 → v1 不递归：删父会话不动子会话。
        let filter = build_filter(
            "custom".to_string(),
            None,
            None,
            None,
            Some(only_parent.to_string()),
            None,
        );
        let preview = build_v1_preview(&conn, &filter).expect("预览必须成功");
        assert_eq!(preview.session_count, 1, "只命中父会话");

        let targets = resolve_target_ids(&conn, &filter, &env).expect("目标集合必须算得出");
        assert_eq!(targets, vec![parent.to_string()]);
        let outcome = compat::write::delete_sessions_exact(&conn, &targets).expect("删除必须成功");
        assert_eq!(outcome.sessions, preview.session_count);
        assert_eq!(outcome.messages(), preview.message_count);
        assert_eq!(outcome.parts(), preview.part_count);
        assert_eq!(outcome.bytes(), preview.estimated_size);

        assert_eq!(
            count(
                &conn,
                &format!("SELECT COUNT(*) FROM main.session WHERE id = '{}'", parent)
            ),
            0,
            "父会话必须被删除"
        );
        assert_eq!(
            count(
                &conn,
                &format!(
                    "SELECT COUNT(*) FROM main.session WHERE parent_id = '{}'",
                    parent
                )
            ),
            2,
            "v1 不递归：子会话必须保留"
        );
    }
}

/// 真实库只读基准探针（`#[ignore]`，默认不参与 `cargo test`）。
///
/// 覆盖 PR-2 引入的两类可能在大库上变慢的操作：
/// 1. `cleanup_preview` 的 v2 逐会话体积/消息子查询（按时间窗口与全量两种）；
/// 2. 写后 `schema::refresh_counts` 的计数 + 尾消息扫描（只读等价物 = `detect`）。
///
/// 性能红线：30 天窗口 < 500 ms；`refresh_counts` < 1 s；全量预览只记录实际值。
///
/// 用法：
///
/// ```text
/// OPENCODE_W_BENCH_DB=~/.local/share/opencode/opencode.db \
///   cargo test cleanup_bench_real_database -- --ignored --nocapture
/// ```
///
/// 探针**只读**打开数据库（`SQLITE_OPEN_READ_ONLY`），不改用户数据。
#[cfg(test)]
mod perf_probe {
    use std::time::{Duration, Instant};

    use rusqlite::{Connection, OpenFlags};

    use super::{build_filter, build_v2_preview};

    /// 每组跑 3 次取中位数，抵消首次读页与缓存抖动。
    const RUNS: usize = 3;

    fn median(mut samples: Vec<Duration>) -> Duration {
        samples.sort_unstable();
        samples[samples.len() / 2]
    }

    fn report(label: &str, elapsed: Duration, extra: &str) {
        println!("{label:<34} {:>9} ms  {extra}", elapsed.as_millis());
    }

    /// 把 3 次采样一起打出来：真库 14.8 GB 放不进 page cache，首轮必然是冷读，
    /// 只看中位数会误判「快」。
    fn report_samples(label: &str, samples: &[Duration], extra: &str) {
        let each: Vec<String> = samples
            .iter()
            .map(|sample| sample.as_millis().to_string())
            .collect();
        report(
            label,
            median(samples.to_vec()),
            &format!("{extra}  [{} ms]", each.join(", ")),
        );
    }

    #[test]
    #[ignore = "需要真实 OpenCode 数据库：设置 OPENCODE_W_BENCH_DB 后手动运行"]
    fn cleanup_bench_real_database() {
        let Some(path) = std::env::var_os("OPENCODE_W_BENCH_DB") else {
            eprintln!("[skip] 未设置 OPENCODE_W_BENCH_DB");
            return;
        };
        let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("真实库以只读方式打开");
        // 与 `db::open` 的连接参数保持一致（只读连接不能改 journal_mode）。
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA cache_size = -64000;
             PRAGMA mmap_size = 268435456;
             PRAGMA synchronous = NORMAL;
             PRAGMA temp_store = MEMORY;
             PRAGMA threads = 4;",
        )
        .expect("连接参数生效");

        let info = crate::schema::detect(&conn).expect("schema 探测");
        println!("模式：{:?}  迁移阶段：{:?}", info.mode, info.migration_phase);
        if !info.mode.is_v2() {
            eprintln!("[skip] 不是 v2 / 混合库，本探针只测 v2 写路径");
            return;
        }
        // 预览走 `session` 兼容视图；TEMP VIEW 建在 temp schema，不写主库。
        crate::schema::apply_session_view(&conn, &info).expect("session 视图可用");

        // ── a) 30 天窗口（最常用策略）──
        let filter_30d = build_filter("time".to_string(), Some(30), None, None, None, None);
        let mut samples = Vec::new();
        let mut matched = 0usize;
        for _ in 0..RUNS {
            let started = Instant::now();
            let preview = build_v2_preview(&conn, &filter_30d).expect("30 天预览");
            samples.push(started.elapsed());
            matched = preview.session_count as usize;
        }
        report_samples(
            "cleanup_preview(30 天窗口)",
            &samples,
            &format!("命中 {matched} 个会话"),
        );

        // ── b) 全量（无时间过滤）──
        let filter_all = build_filter(
            "custom".to_string(),
            None,
            None,
            None,
            Some("1=1".to_string()),
            None,
        );
        let mut samples = Vec::new();
        let mut matched_all = 0usize;
        for _ in 0..RUNS {
            let started = Instant::now();
            let preview = build_v2_preview(&conn, &filter_all).expect("全量预览");
            samples.push(started.elapsed());
            matched_all = preview.session_count as usize;
        }
        report_samples(
            "cleanup_preview(全量)",
            &samples,
            &format!("命中 {matched_all} 个会话"),
        );

        // ── b2) 「按大小」策略 30 天：必须复用同一份 GROUP BY 聚合，不再扫一遍 ──
        let filter_size = build_filter("size".to_string(), None, Some(1), None, None, None);
        let mut samples = Vec::new();
        let mut matched_size = 0usize;
        for _ in 0..RUNS {
            let started = Instant::now();
            let preview = build_v2_preview(&conn, &filter_size).expect("按大小预览");
            samples.push(started.elapsed());
            matched_size = preview.session_count as usize;
        }
        report_samples(
            "cleanup_preview(按大小 1MB)",
            &samples,
            &format!("命中 {matched_size} 个会话"),
        );

        // ── c) 写后刷新的只读等价物：detect（表存在性 + v2 计数）──
        let mut samples = Vec::new();
        for _ in 0..RUNS {
            let started = Instant::now();
            let detected = crate::schema::detect(&conn).expect("schema 探测");
            samples.push(started.elapsed());
            let _ = detected.v2_session_count;
        }
        report_samples("refresh_counts 只读等价(detect)", &samples, "v2 计数");
        
    }
}
