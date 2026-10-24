use serde::Serialize;
use tauri::{AppHandle, Manager};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use chrono::TimeZone;

use crate::db::{self, DbState};
use crate::commands::fork_stats::{self, DedupSet};
use crate::models::dto::{
    CostTrendItem, DatabaseStats, IpcResult, MessageTrendItem, ModelRankingItem,
    ModelRankingResponse, ProjectRankingItem, ProviderStatsItem, ProviderStatsResponse,
    SessionTrendItem, SkillUsage, TokenGroupDataPoint, TokenStats, ToolRanking,
};
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::ToSql;

/// v2 统计口径的只读查询（实施计划 TASK-030 ~ TASK-033）。
///
/// 文件放在 `compat/` 下（v1/v2 差异只允许这一处知道），但**不**挂到
/// `compat/mod.rs`：`compat/mod.rs` 由写路径 PR-2 独占修改，这里用
/// `#[path]` 单独挂载，避免两个 PR 改同一个文件。
///
/// `pub(crate)` 仅为让会话详情的测试与仪表盘统计做口径对照（同一数据
/// 两侧结果必须一致），运行时调用方仍只有本模块。
#[path = "../compat/stats_v2.rs"]
pub(crate) mod stats_v2;

/// 分叉归因集合。
///
/// v1 库走旧表指纹，v2 库（含混合库）走 `session_v2` / `session_message`
/// 口径（TASK-027 ~ TASK-029）。
fn fork_set(
    conn: &rusqlite::Connection,
    start_date: Option<&str>,
    end_date: Option<&str>,
    v2: bool,
) -> DedupSet {
    match (start_date, end_date) {
        (Some(s), Some(e)) => {
            let start = date_to_epoch_ms(s, true);
            let end = date_to_epoch_ms(e, false);
            if v2 {
                fork_stats::dedup_v2_for_window(conn, start, end).unwrap_or_default()
            } else {
                fork_stats::dedup_for_window(conn, start, end).unwrap_or_default()
            }
        }
        _ => {
            if v2 {
                fork_stats::dedup_v2(conn).unwrap_or_default()
            } else {
                fork_stats::dedup(conn).unwrap_or_default()
            }
        }
    }
}

/// 手动刷新分叉归因（TASK-035）。
///
/// `fork_stats::invalidate_cache()` 会推进缓存代次：v1 / v2 的归因缓存与
/// v2 token 扫描缓存（键里含代次）因此同时失效，下一次统计会重新计算。
#[tauri::command]
pub fn dashboard_refresh_attribution() -> IpcResult<()> {
    fork_stats::invalidate_cache();
    IpcResult::ok(())
}

fn boxed(params: &[i64]) -> Vec<Box<dyn ToSql>> {
    params.iter().map(|v| Box::new(*v) as Box<dyn ToSql>).collect()
}

fn exclusion_fragment(alias: &str) -> String {
    if alias.is_empty() {
        " AND id NOT IN (SELECT value FROM json_each(?))".to_string()
    } else {
        format!(" AND {}.id NOT IN (SELECT value FROM json_each(?))", alias)
    }
}

/// Dual return type for `dashboard_tokens` — either aggregate stats or grouped data points.
/// Uses `#[serde(untagged)]` to match the TypeScript union `TokenStats | TokenGroupDataPoint[]`.
#[derive(Serialize)]
#[serde(untagged)]
pub enum TokenStatsResult {
    Stats(TokenStats),
    Groups(Vec<TokenGroupDataPoint>),
}

/// 在线程池中执行数据库操作，避免阻塞 Tauri 主线程导致 UI 冻结。
///
/// 所有 analytics 命令都通过此 helper 将同步的 SQLite 查询放到 spawn_blocking 线程池执行，
/// 这样主线程可以继续处理 WebView 的渲染和用户交互。
async fn run_db_task<T, F>(app: AppHandle, f: F) -> IpcResult<T>
where
    T: Send + 'static,
    F: FnOnce(&Arc<Mutex<Option<Pool<SqliteConnectionManager>>>>) -> IpcResult<T> + Send + 'static,
{
    let db = app.state::<DbState>().clone_inner();
    let result = tauri::async_runtime::spawn_blocking(move || f(&db))
        .await
        .unwrap_or_else(|e| IpcResult::err(format!("thread error: {}", e)));
    // 失败必须在日志里留痕：前端只看到 IpcResult::Error，后端排查需要原始原因。
    if let IpcResult::Error { error, .. } = &result {
        log::warn!("统计命令执行失败：{}", error);
    }
    result
}

/// 尝试用窗口投影派生统计结果。
///
/// 投影默认启用（`OPENCODE_W_STATS_PROJECTION=0` 可关闭）；未启用或投影失败时
/// 返回 `None`，调用方继续走原有 SQL —— 失败隔离与回退路径都保持原样。
fn try_projection<T>(
    conn: &rusqlite::Connection,
    window: stats_v2::Window,
    hidden_json: &str,
    derive: impl FnOnce(&stats_v2::Projection) -> T,
) -> Option<IpcResult<T>> {
    if !stats_v2::projection_enabled() {
        return None;
    }
    match stats_v2::projection_cached(conn, window, hidden_json) {
        Ok(projection) => Some(IpcResult::ok(derive(&projection))),
        Err(error) => {
            log::warn!("统计投影失败，回退旧查询：{}", error);
            None
        }
    }
}

/// 当前库是否为 v2 形态（v2-fresh 或 v2-mixed）。
fn is_v2_database(app: &AppHandle) -> bool {
    app.state::<DbState>()
        .schema()
        .map(|info| info.mode.is_v2())
        .unwrap_or(false)
}

/// 时间窗口 → `(start_ms, end_ms)`；缺任一端视为「全部时间」。
fn window_of(start_date: Option<&str>, end_date: Option<&str>) -> stats_v2::Window {
    match (start_date, end_date) {
        (Some(s), Some(e)) => Some((
            date_to_epoch_ms(s, true),
            date_to_epoch_ms(e, false),
        )),
        _ => None,
    }
}

/// dashboard_overview 里 `part` 计数的 SQL。
///
/// v2 没有 `part` 表，改用消息粒度（`session_message`）计数，避免查询失败后
/// 被 `unwrap_or(0)` 静默吞掉。
fn overview_part_counts_sql(v2: bool, time_filtered: bool) -> &'static str {
    match (v2, time_filtered) {
        (true, false) => {
            "SELECT 'part' as label, COUNT(*) as cnt FROM session_message"
        }
        (true, true) => {
            "SELECT 'part' as label, COUNT(*) as cnt FROM session_message WHERE time_created BETWEEN ?1 AND ?2"
        }
        (false, false) => {
            "SELECT 'part' as label, COUNT(*) as cnt FROM part WHERE id NOT IN (SELECT value FROM json_each(?2))"
        }
        (false, true) => {
            "SELECT 'part' as label, COUNT(*) as cnt FROM part WHERE time_created BETWEEN ?1 AND ?2 AND id NOT IN (SELECT value FROM json_each(?4))"
        }
    }
}

/// Build a SQL date filter clause for `time_created` (ms timestamp).
/// Mirrors `buildDateFilter` in `electron/ipc/analytics.ts`.
///
/// Takes `start_date` and `end_date` as separate options (Tauri 的命名参数绑定模型
/// 要求前端展开 `TimeRange` 对象为 `startDate` / `endDate` 字段，Tauri 会自动
/// camelCase → snake_case 转换)。
///
/// Returns `(sql_fragment, params)` where `sql_fragment` is either empty
/// or starts with `AND`. The `?` placeholders correspond to entries in `params`.
fn build_date_filter(
    table_alias: &str,
    start_date: Option<&str>,
    end_date: Option<&str>,
) -> (String, Vec<i64>) {
    match (start_date, end_date) {
        (Some(s), Some(e)) => {
            let prefix = if table_alias.is_empty() {
                String::new()
            } else {
                format!("{}.", table_alias)
            };
            let start_epoch = date_to_epoch_ms(s, true);
            let end_epoch = date_to_epoch_ms(e, false);
            let sql = format!("AND {}time_created BETWEEN ? AND ?", prefix);
            (sql, vec![start_epoch, end_epoch])
        }
        _ => (String::new(), Vec::new()),
    }
}

/// Parse "YYYY-MM-DD" date string to epoch milliseconds for the start or end of day in local timezone.
/// `start_of_day = true` → 00:00:00 local; `start_of_day = false` → 23:59:59 local.
/// Matches the original SQL `'localtime'` modifier behavior.
pub(crate) fn date_to_epoch_ms(date_str: &str, start_of_day: bool) -> i64 {
    if let Ok(parsed) = chrono::NaiveDate::parse_from_str(date_str, "%Y-%m-%d") {
        let naive_dt = if start_of_day {
            parsed.and_hms_opt(0, 0, 0).unwrap()
        } else {
            parsed.and_hms_opt(23, 59, 59).unwrap()
        };
        match chrono::Local.from_local_datetime(&naive_dt) {
            chrono::LocalResult::Single(dt) => dt.timestamp_millis(),
            chrono::LocalResult::Ambiguous(earliest, _) => earliest.timestamp_millis(),
            chrono::LocalResult::None => naive_dt.and_utc().timestamp_millis(),
        }
    } else {
        0
    }
}

// ─── 1. dashboard_overview ──────────────────────────────────────────────

/// Dashboard overview — aggregate database stats with optional time-range filter.
///
/// 前端传递 `TimeRange` 对象 `{ startDate, endDate }`，Tauri 自动 camelCase → snake_case
/// 转换为 `start_date` / `end_date` 命名参数。
#[tauri::command]
pub async fn dashboard_overview(
    app: AppHandle,
    start_date: Option<String>,
    end_date: Option<String>,
) -> IpcResult<DatabaseStats> {
    let v2 = is_v2_database(&app);
    run_db_task(app, move |db| {
    // No time range: use logical counts (fork-inherited rows excluded) plus file stats
    if start_date.is_none() || end_date.is_none() {
        let s = db::get_stats(db);
        if let Some(err) = s.error {
            return IpcResult::err(err);
        }
        let conn = match db::get_db(db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };
        let set = fork_set(&conn, start_date.as_deref(), end_date.as_deref(), v2);
        let session_json = set.session_ids_json();
        let part_json = set.part_ids_json();
        let mut counts: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
        // v2 没有 part 表：消息粒度计数改用 session_message，避免静默变成 0。
        let part_counts = overview_part_counts_sql(v2, false);
        let compound_sql = format!(
            "SELECT 'root_session' as label, COUNT(*) as cnt FROM session WHERE parent_id IS NULL AND id NOT IN (SELECT value FROM json_each(?1))
             UNION ALL
             SELECT 'child_session', COUNT(*) FROM session WHERE parent_id IS NOT NULL AND id NOT IN (SELECT value FROM json_each(?1))
             UNION ALL
             SELECT 'project', COUNT(DISTINCT project_id) FROM session WHERE project_id IS NOT NULL AND project_id != ''
             UNION ALL
             {part_counts}"
        );
        let params: Vec<&dyn ToSql> = if v2 {
            vec![&session_json]
        } else {
            vec![&session_json, &part_json]
        };
        let mut stmt = match conn.prepare(&compound_sql) {
            Ok(stmt) => stmt,
            Err(e) => return IpcResult::err(format!("统计查询失败：{}", e)),
        };
        let rows = match stmt.query_map(params.as_slice(), |row| {
            let label: String = row.get(0)?;
            let cnt: i64 = row.get(1)?;
            Ok((label, cnt))
        }) {
            Ok(rows) => rows,
            Err(e) => return IpcResult::err(format!("统计查询失败：{}", e)),
        };
        for row in rows {
            match row {
                Ok((label, cnt)) => {
                    counts.insert(label, cnt);
                }
                Err(e) => return IpcResult::err(format!("统计查询失败：{}", e)),
            }
        }
        let root_session_count = counts.get("root_session").copied().unwrap_or(0);
        let child_session_count = counts.get("child_session").copied().unwrap_or(0);
        let project_count = counts.get("project").copied().unwrap_or(0);
        let part_count = counts.get("part").copied().unwrap_or(0);
        return IpcResult::ok(DatabaseStats {
            db_size: s.db_size,
            root_session_count,
            child_session_count,
            session_count: root_session_count + child_session_count,
            project_count,
            part_count,
            freelist_size: s.freelist_size,
            wal_size: s.wal_size,
        });
    }

    // Time-range filtered stats
        let conn = match db::get_db(db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };

    let start_epoch = date_to_epoch_ms(start_date.as_ref().unwrap(), true);
    let end_epoch = date_to_epoch_ms(end_date.as_ref().unwrap(), false);
    let set = fork_set(&conn, start_date.as_deref(), end_date.as_deref(), v2);
    let session_json = set.session_ids_json();
    let part_json = set.part_ids_json();
    let mut params: Vec<&dyn ToSql> = vec![&start_epoch, &end_epoch, &session_json];
    if !v2 {
        params.push(&part_json);
    }

    let _overview_start = Instant::now();
    let mut counts: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    // v2 没有 part 表：消息粒度计数改用 session_message，避免静默变成 0。
    let part_counts = overview_part_counts_sql(v2, true);
    let compound_sql = format!(
        "SELECT 'root_session' as label, COUNT(*) as cnt FROM session WHERE parent_id IS NULL AND time_created BETWEEN ?1 AND ?2 AND id NOT IN (SELECT value FROM json_each(?3))
         UNION ALL
         SELECT 'child_session', COUNT(*) FROM session WHERE parent_id IS NOT NULL AND time_created BETWEEN ?1 AND ?2 AND id NOT IN (SELECT value FROM json_each(?3))
         UNION ALL
         SELECT 'project', COUNT(DISTINCT project_id) FROM session WHERE project_id IS NOT NULL AND project_id != '' AND time_created BETWEEN ?1 AND ?2
         UNION ALL
         {part_counts}"
    );
    let mut stmt = match conn.prepare(&compound_sql) {
        Ok(stmt) => stmt,
        Err(e) => return IpcResult::err(format!("统计查询失败：{}", e)),
    };
    let rows = match stmt.query_map(params.as_slice(), |row| {
        let label: String = row.get(0)?;
        let cnt: i64 = row.get(1)?;
        Ok((label, cnt))
    }) {
        Ok(rows) => rows,
        Err(e) => return IpcResult::err(format!("统计查询失败：{}", e)),
    };
    for row in rows {
        match row {
            Ok((label, cnt)) => {
                counts.insert(label, cnt);
            }
            Err(e) => return IpcResult::err(format!("统计查询失败：{}", e)),
        }
    }
    let root_session_count = counts.get("root_session").copied().unwrap_or(0);
    let child_session_count = counts.get("child_session").copied().unwrap_or(0);
    let project_count = counts.get("project").copied().unwrap_or(0);
    let part_count = counts.get("part").copied().unwrap_or(0);
    #[cfg(debug_assertions)]
    eprintln!("[perf] dashboard_overview::count_queries: {}ms", _overview_start.elapsed().as_millis());

    // File-level stats (don't depend on time range)
    let current_path = conn.path().map(|p| p.to_string());
    let (db_size, wal_size) = current_path
        .as_ref()
        .map(|p| {
            let db_sz = std::fs::metadata(p).ok().map(|m| m.len() as i64).unwrap_or(0);
            let wal_path = format!("{}-wal", p);
            let wal_sz = std::fs::metadata(&wal_path).ok().map(|m| m.len() as i64).unwrap_or(0);
            (db_sz, wal_sz)
        })
        .unwrap_or((0, 0));
    let freelist_count: i64 = conn
        .query_row("PRAGMA freelist_count", [], |row| row.get(0))
        .unwrap_or(0);
    let page_size: i64 = conn
        .query_row("PRAGMA page_size", [], |row| row.get(0))
        .unwrap_or(4096);

    IpcResult::ok(DatabaseStats {
        db_size,
        root_session_count,
        child_session_count,
        session_count: root_session_count + child_session_count,
        project_count,
        part_count,
        freelist_size: freelist_count * page_size,
        wal_size,
    })
    }).await
}

// ─── 2. dashboard_tokens ────────────────────────────────────────────────

/// Token / cost stats — either aggregate or grouped by day/week/month.
///
/// Token usage is recorded per-step in `part` rows where `type='step-finish'`.
/// (Session-level `tokens_*` columns are lifecycle totals and would misattribute
/// cross-day sessions to their creation date.)
///
/// 前端传递 `{ startDate, endDate, groupBy }`，Tauri 自动 camelCase → snake_case 转换。
#[tauri::command]
pub async fn dashboard_tokens(
    app: AppHandle,
    start_date: Option<String>,
    end_date: Option<String>,
    group_by: Option<String>,
) -> IpcResult<TokenStatsResult> {
    let v2 = is_v2_database(&app);
    run_db_task(app, move |db| {
        let conn = match db::get_db(db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };

    // v2 分支：token / cost 挂在 assistant 消息上（TASK-030）。
    if v2 {
        return v2_dashboard_tokens(
            &conn,
            start_date.as_deref(),
            end_date.as_deref(),
            group_by.as_deref(),
        );
    }

    let (filter_sql, filter_params) = build_date_filter(
        "p",
        start_date.as_deref(),
        end_date.as_deref(),
    );
    let set = fork_set(&conn, start_date.as_deref(), end_date.as_deref(), v2);
    let part_json = set.part_ids_json();
    let mut params = boxed(&filter_params);
    params.push(Box::new(part_json));

    let _token_start = Instant::now();
    if let Some(g) = group_by.as_deref().filter(|g| !g.is_empty()) {
        let fmt = match g {
            "week" => "%Y-W%W",
            "month" => "%Y-%m",
            _ => "%Y-%m-%d",
        };

        let sql = format!(
            "SELECT
              strftime('{}', p.time_created / 1000, 'unixepoch', 'localtime') as period,
              COALESCE(SUM(json_extract(p.data, '$.tokens.input')), 0) as inputTokens,
              COALESCE(SUM(json_extract(p.data, '$.tokens.output')), 0) as outputTokens,
              COALESCE(SUM(json_extract(p.data, '$.tokens.reasoning')), 0) as reasoningTokens,
              COALESCE(SUM(json_extract(p.data, '$.tokens.cache.read')), 0) as cacheRead,
              COALESCE(SUM(json_extract(p.data, '$.tokens.cache.write')), 0) as cacheWrite,
              COALESCE(SUM(json_extract(p.data, '$.cost')), 0) as estimatedCost
            FROM part p
            WHERE json_extract(p.data, '$.type') = 'step-finish' {}{}
            GROUP BY period
            ORDER BY period ASC",
            fmt, filter_sql, exclusion_fragment("p")
        );

        let mut stmt = match conn.prepare(&sql) {
            Ok(s) => s,
            Err(e) => return IpcResult::err(e.to_string()),
        };
        let rows = match stmt.query_map(rusqlite::params_from_iter(params.iter()), |row| {
            // SUM may return REAL even for integer JSON values — read as f64, cast to i64
            let input_tokens: f64 = row.get(1)?;
            let output_tokens: f64 = row.get(2)?;
            let reasoning_tokens: f64 = row.get(3)?;
            let cache_read: f64 = row.get(4)?;
            let cache_write: f64 = row.get(5)?;
            let estimated_cost: f64 = row.get(6)?;
            Ok(TokenGroupDataPoint {
                period: row.get(0)?,
                input_tokens: input_tokens as i64,
                output_tokens: output_tokens as i64,
                reasoning_tokens: reasoning_tokens as i64,
                cache_read: cache_read as i64,
                cache_write: cache_write as i64,
                estimated_cost,
            })
        }) {
            Ok(r) => r,
            Err(e) => return IpcResult::err(e.to_string()),
        };

        let mut grouped = Vec::new();
        for row in rows {
            match row {
                Ok(item) => grouped.push(item),
                Err(e) => return IpcResult::err(e.to_string()),
            }
        }
        #[cfg(debug_assertions)]
        eprintln!("[perf] dashboard_tokens::grouped: {}ms", _token_start.elapsed().as_millis());
        return IpcResult::ok(TokenStatsResult::Groups(grouped));
    }

    // Aggregate mode: return single TokenStats
    let sql = format!(
        "SELECT
          COALESCE(SUM(json_extract(p.data, '$.tokens.input')), 0) as inputTokens,
          COALESCE(SUM(json_extract(p.data, '$.tokens.output')), 0) as outputTokens,
          COALESCE(SUM(json_extract(p.data, '$.tokens.reasoning')), 0) as reasoningTokens,
          COALESCE(SUM(json_extract(p.data, '$.tokens.cache.read')), 0) as cacheRead,
          COALESCE(SUM(json_extract(p.data, '$.tokens.cache.write')), 0) as cacheWrite,
          COALESCE(SUM(json_extract(p.data, '$.cost')), 0) as estimatedCost
        FROM part p
        WHERE json_extract(p.data, '$.type') = 'step-finish' {}{}",
        filter_sql, exclusion_fragment("p")
    );

    let stats = match conn.query_row(
        &sql,
        rusqlite::params_from_iter(params.iter()),
        |row| {
            let input_tokens: f64 = row.get(0)?;
            let output_tokens: f64 = row.get(1)?;
            let reasoning_tokens: f64 = row.get(2)?;
            let cache_read: f64 = row.get(3)?;
            let cache_write: f64 = row.get(4)?;
            let estimated_cost: f64 = row.get(5)?;

            let input_i = input_tokens as i64;
            let output_i = output_tokens as i64;
            let reasoning_i = reasoning_tokens as i64;
            let cache_read_i = cache_read as i64;
            let total_attempts = cache_read + input_tokens;
            let hit_rate = if total_attempts > 0.0 {
                (cache_read / total_attempts) * 100.0
            } else {
                0.0
            };

            Ok(TokenStats {
                input_tokens: input_i,
                output_tokens: output_i,
                reasoning_tokens: reasoning_i,
                cache_read: cache_read_i,
                cache_write: cache_write as i64,
                estimated_cost,
                cache_hit_rate: (hit_rate * 100.0).round() / 100.0,
            })
        },
    ) {
        Ok(s) => s,
        Err(rusqlite::Error::QueryReturnedNoRows) => TokenStats {
            input_tokens: 0,
            output_tokens: 0,
            reasoning_tokens: 0,
            cache_read: 0,
            cache_write: 0,
            estimated_cost: 0.0,
            cache_hit_rate: 0.0,
        },
        Err(e) => return IpcResult::err(e.to_string()),
    };

    #[cfg(debug_assertions)]
    eprintln!("[perf] dashboard_tokens::aggregate: {}ms", _token_start.elapsed().as_millis());
    IpcResult::ok(TokenStatsResult::Stats(stats))
    }).await
}

/// v2 分支的 token 统计（TASK-030）。
///
/// 一次扫描同时算出「总量」与「按天 / 周 / 月分组」：天级聚合行自带周 / 月
/// 键，内存里即可重组，因此前端并发调用两次（总量 + 分组）也只扫一次全库
/// （`stats_v2::scan_tokens_cached` 复用同一次扫描结果）。
fn v2_dashboard_tokens(
    conn: &rusqlite::Connection,
    start_date: Option<&str>,
    end_date: Option<&str>,
    group_by: Option<&str>,
) -> IpcResult<TokenStatsResult> {
    let _start = Instant::now();
    let set = fork_set(conn, start_date, end_date, true);
    let hidden_json = set.message_ids_json();
    let window = window_of(start_date, end_date);

    if let Some(result) = try_projection(conn, window, &hidden_json, |projection| {
        match group_by.filter(|group| !group.is_empty()) {
            Some(group) => {
                TokenStatsResult::Groups(stats_v2::derive_token_groups(projection, group))
            }
            None => TokenStatsResult::Stats(stats_v2::derive_token_stats(projection)),
        }
    }) {
        return result;
    }

    let rows = match stats_v2::scan_tokens_cached(conn, window, &hidden_json) {
        Ok(rows) => rows,
        Err(e) => return IpcResult::err(e),
    };

    match group_by.filter(|g| !g.is_empty()) {
        Some(group) => {
            let grouped = stats_v2::grouped(&rows, group);
            #[cfg(debug_assertions)]
            eprintln!(
                "[perf] dashboard_tokens::v2_grouped: {}ms",
                _start.elapsed().as_millis()
            );
            IpcResult::ok(TokenStatsResult::Groups(grouped))
        }
        None => {
            let stats = stats_v2::aggregate(&rows);
            #[cfg(debug_assertions)]
            eprintln!(
                "[perf] dashboard_tokens::v2_aggregate: {}ms",
                _start.elapsed().as_millis()
            );
            IpcResult::ok(TokenStatsResult::Stats(stats))
        }
    }
}

// ─── 3. dashboard_tool_ranking ──────────────────────────────────────────

/// Tool usage ranking — top 20 tools by invocation count.
#[tauri::command]
pub async fn dashboard_tool_ranking(
    app: AppHandle,
    start_date: Option<String>,
    end_date: Option<String>,
) -> IpcResult<Vec<ToolRanking>> {
    let v2 = is_v2_database(&app);
    run_db_task(app, move |db| {
        let conn = match db::get_db(db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };
    let _t_tool = Instant::now();

    // v2 分支：工具调用在消息的 `content[]` 里（TASK-031）。
    if v2 {
        let set = fork_set(&conn, start_date.as_deref(), end_date.as_deref(), true);
        let hidden_json = set.message_ids_json();
        let window = window_of(start_date.as_deref(), end_date.as_deref());
        if let Some(result) =
            try_projection(&conn, window, &hidden_json, stats_v2::derive_tool_ranking)
        {
            return result;
        }
        return match stats_v2::tool_ranking(&conn, window, &hidden_json) {
            Ok(ranking) => {
                #[cfg(debug_assertions)]
                eprintln!("[perf] dashboard_tool_ranking::v2: {}ms", _t_tool.elapsed().as_millis());
                IpcResult::ok(ranking)
            }
            Err(e) => IpcResult::err(e),
        };
    }

    let (filter_sql, filter_params) = build_date_filter("", start_date.as_deref(), end_date.as_deref());
    let set = fork_set(&conn, start_date.as_deref(), end_date.as_deref(), v2);
    let part_json = set.part_ids_json();
    let mut params = boxed(&filter_params);
    params.push(Box::new(part_json));
    let sql = format!(
        "SELECT
          COALESCE(json_extract(data, '$.tool'), 'unknown') as toolName,
          COUNT(*) as count
        FROM part
        WHERE json_extract(data, '$.type') = 'tool' {}{}
        GROUP BY toolName
        ORDER BY count DESC
        LIMIT 20",
        filter_sql, exclusion_fragment("")
    );

    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(e) => return IpcResult::err(e.to_string()),
    };
    let rows = match stmt.query_map(
        rusqlite::params_from_iter(params.iter()),
        |row| {
            Ok(ToolRanking {
                tool_name: row.get(0)?,
                count: row.get(1)?,
            })
        },
    ) {
        Ok(r) => r,
        Err(e) => return IpcResult::err(e.to_string()),
    };

    let mut ranking = Vec::new();
    for row in rows {
        match row {
            Ok(item) => ranking.push(item),
            Err(e) => return IpcResult::err(e.to_string()),
        }
    }
    #[cfg(debug_assertions)]
    eprintln!("[perf] dashboard_tool_ranking: {}ms", _t_tool.elapsed().as_millis());
    IpcResult::ok(ranking)
    }).await
}

// ─── 4. dashboard_skill_usage ───────────────────────────────────────────

/// Skill usage ranking — top 20 skills by invocation count.
#[tauri::command]
pub async fn dashboard_skill_usage(
    app: AppHandle,
    start_date: Option<String>,
    end_date: Option<String>,
) -> IpcResult<Vec<SkillUsage>> {
    let v2 = is_v2_database(&app);
    run_db_task(app, move |db| {
        let conn = match db::get_db(db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };
    let _t_skill = Instant::now();

    // v2 分支：技能调用是 `name='skill'` 的工具块（TASK-031）。
    if v2 {
        let set = fork_set(&conn, start_date.as_deref(), end_date.as_deref(), true);
        let hidden_json = set.message_ids_json();
        let window = window_of(start_date.as_deref(), end_date.as_deref());
        if let Some(result) =
            try_projection(&conn, window, &hidden_json, stats_v2::derive_skill_usage)
        {
            return result;
        }
        return match stats_v2::skill_usage(&conn, window, &hidden_json) {
            Ok(usage) => {
                #[cfg(debug_assertions)]
                eprintln!("[perf] dashboard_skill_usage::v2: {}ms", _t_skill.elapsed().as_millis());
                IpcResult::ok(usage)
            }
            Err(e) => IpcResult::err(e),
        };
    }

    let (filter_sql, filter_params) = build_date_filter("", start_date.as_deref(), end_date.as_deref());
    let set = fork_set(&conn, start_date.as_deref(), end_date.as_deref(), v2);
    let part_json = set.part_ids_json();
    let mut params = boxed(&filter_params);
    params.push(Box::new(part_json));
    let sql = format!(
        "SELECT
          COALESCE(json_extract(data, '$.state.input.name'), 'unknown') as skillName,
          COUNT(*) as count
        FROM part
        WHERE json_extract(data, '$.type') = 'tool'
          AND json_extract(data, '$.tool') = 'skill' {}{}
        GROUP BY skillName
        ORDER BY count DESC
        LIMIT 20",
        filter_sql, exclusion_fragment("")
    );

    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(e) => return IpcResult::err(e.to_string()),
    };
    let rows = match stmt.query_map(
        rusqlite::params_from_iter(params.iter()),
        |row| {
            Ok(SkillUsage {
                skill_name: row.get(0)?,
                count: row.get(1)?,
            })
        },
    ) {
        Ok(r) => r,
        Err(e) => return IpcResult::err(e.to_string()),
    };

    let mut usage = Vec::new();
    for row in rows {
        match row {
            Ok(item) => usage.push(item),
            Err(e) => return IpcResult::err(e.to_string()),
        }
    }
    #[cfg(debug_assertions)]
    eprintln!("[perf] dashboard_skill_usage: {}ms", _t_skill.elapsed().as_millis());
    IpcResult::ok(usage)
    }).await
}

// ─── 5. dashboard_model_ranking ─────────────────────────────────────────

/// Model ranking — top 10 models by session count, with token/cost totals.
///
/// 返回体是 `{ items, coverageGap? }`：`coverageGap` 是「没有 model 记录、
/// 因而不参与排行」的 token 合计与会话数（真库里确实存在 model 为 NULL 的
/// 会话，它们的 token 会进概览合计、却不进排行）。没有缺口时**不输出该字段**。
#[tauri::command]
pub async fn dashboard_model_ranking(
    app: AppHandle,
    start_date: Option<String>,
    end_date: Option<String>,
) -> IpcResult<ModelRankingResponse> {
    let v2 = is_v2_database(&app);
    run_db_task(app, move |db| {
        let conn = match db::get_db(db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };
    let _t_model = Instant::now();

    // v2 分支：按消息聚合 token / cost，再 JOIN `session_v2` 取模型（TASK-032）。
    if v2 {
        let set = fork_set(&conn, start_date.as_deref(), end_date.as_deref(), true);
        let hidden_json = set.message_ids_json();
        let window = window_of(start_date.as_deref(), end_date.as_deref());
        if let Some(result) = try_projection(
            &conn,
            window,
            &hidden_json,
            stats_v2::derive_model_ranking_response,
        ) {
            return result;
        }
        return match stats_v2::model_ranking(&conn, window, &hidden_json) {
            Ok(items) => {
                // 回退路径：缺口单独跑一条查询（与主查询同样的过滤条件）。
                let coverage_gap =
                    match stats_v2::model_ranking_gap(&conn, window, &hidden_json) {
                        Ok(gap) => gap,
                        Err(e) => return IpcResult::err(e),
                    };
                #[cfg(debug_assertions)]
                eprintln!("[perf] dashboard_model_ranking::v2: {}ms", _t_model.elapsed().as_millis());
                IpcResult::ok(ModelRankingResponse { items, coverage_gap })
            }
            Err(e) => IpcResult::err(e),
        };
    }

    let (filter_sql, filter_params) = build_date_filter("p", start_date.as_deref(), end_date.as_deref());
    let set = fork_set(&conn, start_date.as_deref(), end_date.as_deref(), v2);
    let part_json = set.part_ids_json();
    let mut params = boxed(&filter_params);
    params.push(Box::new(part_json));
    let sql = format!(
        "SELECT s.model as model,
                COALESCE(SUM(json_extract(p.data, '$.tokens.total')), 0) as tokenCount,
                COALESCE(SUM(json_extract(p.data, '$.cost')), 0) as totalCost
         FROM part p
         JOIN session s ON s.id = p.session_id
         WHERE json_extract(p.data, '$.type') = 'step-finish'
           AND s.model IS NOT NULL {}{}
         GROUP BY s.model
         ORDER BY tokenCount DESC
         LIMIT 10",
        filter_sql, exclusion_fragment("p")
    );

    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(e) => return IpcResult::err(e.to_string()),
    };
    let rows = match stmt.query_map(
        rusqlite::params_from_iter(params.iter()),
        |row| {
            let token_count: f64 = row.get(1)?;
            let total_cost: f64 = row.get(2)?;
            Ok(ModelRankingItem {
                model: row.get(0)?,
                token_count: token_count as i64,
                total_cost,
            })
        },
    ) {
        Ok(r) => r,
        Err(e) => return IpcResult::err(e.to_string()),
    };

    let mut items = Vec::new();
    for row in rows {
        match row {
            Ok(item) => items.push(item),
            Err(e) => return IpcResult::err(e.to_string()),
        }
    }
    #[cfg(debug_assertions)]
    eprintln!("[perf] dashboard_model_ranking: {}ms", _t_model.elapsed().as_millis());
    // v1 库不统计覆盖缺口（旧表 `session.model` 的缺失口径与 v2 不同），
    // 因此 `coverage_gap` 恒为 `None`（前端整行不显示）。
    IpcResult::ok(ModelRankingResponse { items, coverage_gap: None })
    }).await
}

// ─── 6. dashboard_provider_stats ────────────────────────────────────────

/// Provider stats — token/cost totals grouped by provider ID (extracted from session.model JSON).
///
/// 返回体是 `{ items, coverageGap? }`：`coverageGap` 是「有 model、但没有
/// `providerID`，因而不参与 Provider 统计」的 token 合计与会话数。
/// 没有缺口时**不输出该字段**。
#[tauri::command]
pub async fn dashboard_provider_stats(
    app: AppHandle,
    start_date: Option<String>,
    end_date: Option<String>,
) -> IpcResult<ProviderStatsResponse> {
    let v2 = is_v2_database(&app);
    run_db_task(app, move |db| {
        let conn = match db::get_db(db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };
    let _t_prov = Instant::now();

    // v2 分支：按消息聚合后 JOIN `session_v2` 取 provider（TASK-032）。
    if v2 {
        let set = fork_set(&conn, start_date.as_deref(), end_date.as_deref(), true);
        let hidden_json = set.message_ids_json();
        let window = window_of(start_date.as_deref(), end_date.as_deref());
        if let Some(result) = try_projection(
            &conn,
            window,
            &hidden_json,
            stats_v2::derive_provider_stats_response,
        ) {
            return result;
        }
        return match stats_v2::provider_stats(&conn, window, &hidden_json) {
            Ok(items) => {
                // 回退路径：缺口单独跑一条查询（与主查询同样的过滤条件）。
                let coverage_gap =
                    match stats_v2::provider_stats_gap(&conn, window, &hidden_json) {
                        Ok(gap) => gap,
                        Err(e) => return IpcResult::err(e),
                    };
                #[cfg(debug_assertions)]
                eprintln!("[perf] dashboard_provider_stats::v2: {}ms", _t_prov.elapsed().as_millis());
                IpcResult::ok(ProviderStatsResponse { items, coverage_gap })
            }
            Err(e) => IpcResult::err(e),
        };
    }

    let (filter_sql, filter_params) = build_date_filter("p", start_date.as_deref(), end_date.as_deref());
    let set = fork_set(&conn, start_date.as_deref(), end_date.as_deref(), v2);
    let part_json = set.part_ids_json();
    let mut params = boxed(&filter_params);
    params.push(Box::new(part_json));
    let sql = format!(
        "SELECT json_extract(s.model, '$.providerID') as provider,
                COALESCE(SUM(json_extract(p.data, '$.tokens.total')), 0) as tokenCount,
                COALESCE(SUM(json_extract(p.data, '$.cost')), 0) as totalCost
         FROM part p
         JOIN session s ON s.id = p.session_id
         WHERE json_extract(p.data, '$.type') = 'step-finish'
           AND json_extract(s.model, '$.providerID') IS NOT NULL {}{}
         GROUP BY provider
         ORDER BY tokenCount DESC",
        filter_sql, exclusion_fragment("p")
    );

    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(e) => return IpcResult::err(e.to_string()),
    };
    let rows = match stmt.query_map(
        rusqlite::params_from_iter(params.iter()),
        |row| {
            let provider: Option<String> = row.get(0)?;
            let token_count: f64 = row.get(1)?;
            let total_cost: f64 = row.get(2)?;
            Ok(ProviderStatsItem {
                provider: provider.unwrap_or_else(|| "unknown".to_string()),
                token_count: token_count as i64,
                total_cost,
            })
        },
    ) {
        Ok(r) => r,
        Err(e) => return IpcResult::err(e.to_string()),
    };

    let mut items = Vec::new();
    for row in rows {
        match row {
            Ok(item) => items.push(item),
            Err(e) => return IpcResult::err(e.to_string()),
        }
    }
    #[cfg(debug_assertions)]
    eprintln!("[perf] dashboard_provider_stats: {}ms", _t_prov.elapsed().as_millis());
    // v1 库不统计覆盖缺口（同模型排行的取舍）。
    IpcResult::ok(ProviderStatsResponse { items, coverage_gap: None })
    }).await
}

// ─── 7. dashboard_project_ranking ────────────────────────────────────────

/// Project ranking — top 10 projects by total tokens, using the folder name from session.directory.
#[tauri::command]
pub async fn dashboard_project_ranking(
    app: AppHandle,
    start_date: Option<String>,
    end_date: Option<String>,
) -> IpcResult<Vec<ProjectRankingItem>> {
    let v2 = is_v2_database(&app);
    run_db_task(app, move |db| {
        let conn = match db::get_db(db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };
    let _t_proj = Instant::now();

    // v2 分支：按消息聚合后 JOIN `session_v2` 取目录（TASK-032）。
    if v2 {
        let set = fork_set(&conn, start_date.as_deref(), end_date.as_deref(), true);
        let hidden_json = set.message_ids_json();
        let window = window_of(start_date.as_deref(), end_date.as_deref());
        if let Some(result) =
            try_projection(&conn, window, &hidden_json, stats_v2::derive_project_ranking)
        {
            return result;
        }
        return match stats_v2::project_ranking(&conn, window, &hidden_json) {
            Ok(items) => {
                #[cfg(debug_assertions)]
                eprintln!("[perf] dashboard_project_ranking::v2: {}ms", _t_proj.elapsed().as_millis());
                IpcResult::ok(items)
            }
            Err(e) => IpcResult::err(e),
        };
    }

    let (filter_sql, filter_params) = build_date_filter("p", start_date.as_deref(), end_date.as_deref());
    let set = fork_set(&conn, start_date.as_deref(), end_date.as_deref(), v2);
    let part_json = set.part_ids_json();
    let mut params = boxed(&filter_params);
    params.push(Box::new(part_json));
    let sql = format!(
        "SELECT s.directory,
                COALESCE(SUM(json_extract(p.data, '$.tokens.total')), 0) as tokenCount,
                COALESCE(SUM(json_extract(p.data, '$.cost')), 0) as totalCost
         FROM part p
         JOIN session s ON s.id = p.session_id
         WHERE json_extract(p.data, '$.type') = 'step-finish'
           AND s.directory IS NOT NULL AND s.directory != '' {}{}
         GROUP BY s.directory
         ORDER BY tokenCount DESC
         LIMIT 10",
        filter_sql, exclusion_fragment("p")
    );

    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(e) => return IpcResult::err(e.to_string()),
    };
    let rows = match stmt.query_map(
        rusqlite::params_from_iter(params.iter()),
        |row| {
            let directory: String = row.get(0)?;
            let token_count: f64 = row.get(1)?;
            let total_cost: f64 = row.get(2)?;
            let project = directory.rsplit('/').next().unwrap_or(&directory).to_string();
            Ok(ProjectRankingItem {
                project,
                token_count: token_count as i64,
                total_cost,
            })
        },
    ) {
        Ok(r) => r,
        Err(e) => return IpcResult::err(e.to_string()),
    };

    let mut items = Vec::new();
    for row in rows {
        match row {
            Ok(item) => items.push(item),
            Err(e) => return IpcResult::err(e.to_string()),
        }
    }
    #[cfg(debug_assertions)]
    eprintln!("[perf] dashboard_project_ranking: {}ms", _t_proj.elapsed().as_millis());
    IpcResult::ok(items)
    }).await
}

// ─── 8. dashboard_session_trend ─────────────────────────────────────────

/// Session creation trend — daily counts, optionally filtered to root sessions only.
///
/// 前端传递 `{ startDate, endDate, rootOnly }`，Tauri 自动 camelCase → snake_case 转换。
///
/// v1 / v2 共用同一段 SQL：v2 下的 `session` 是 `session_v2 ∪ 旧表独有行`
/// 的 TEMP VIEW（TASK-034），列名与 v1 一致。
#[tauri::command]
pub async fn dashboard_session_trend(
    app: AppHandle,
    start_date: Option<String>,
    end_date: Option<String>,
    root_only: Option<bool>,
) -> IpcResult<Vec<SessionTrendItem>> {
    let v2 = is_v2_database(&app);
    run_db_task(app, move |db| {
        let conn = match db::get_db(db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };
    let _t_st = Instant::now();

    let (filter_sql, filter_params) = build_date_filter("", start_date.as_deref(), end_date.as_deref());
    let root_filter = if root_only.unwrap_or(false) {
        " AND parent_id IS NULL"
    } else {
        ""
    };
    let set = fork_set(&conn, start_date.as_deref(), end_date.as_deref(), v2);
    let session_json = set.session_ids_json();
    let mut params = boxed(&filter_params);
    params.push(Box::new(session_json));
    let sql = format!(
        "SELECT date(time_created / 1000, 'unixepoch', 'localtime') as d,
                COUNT(*) as cnt
         FROM session
         WHERE 1=1 {}{}{}
         GROUP BY d
         ORDER BY d ASC",
        filter_sql, root_filter, exclusion_fragment("")
    );

    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(e) => return IpcResult::err(e.to_string()),
    };
    let rows = match stmt.query_map(
        rusqlite::params_from_iter(params.iter()),
        |row| {
            let d: String = row.get(0)?;
            let cnt: i64 = row.get(1)?;
            Ok(SessionTrendItem {
                date: d,
                value: cnt as f64,
                label: None,
                count: cnt,
            })
        },
    ) {
        Ok(r) => r,
        Err(e) => return IpcResult::err(e.to_string()),
    };

    let mut items = Vec::new();
    for row in rows {
        match row {
            Ok(item) => items.push(item),
            Err(e) => return IpcResult::err(e.to_string()),
        }
    }
    #[cfg(debug_assertions)]
    eprintln!("[perf] dashboard_session_trend: {}ms", _t_st.elapsed().as_millis());
    IpcResult::ok(items)
    }).await
}

// ─── 8. dashboard_cost_trend ────────────────────────────────────────────

/// Cost trend — daily cost totals from step-finish parts.
#[tauri::command]
pub async fn dashboard_cost_trend(
    app: AppHandle,
    start_date: Option<String>,
    end_date: Option<String>,
) -> IpcResult<Vec<CostTrendItem>> {
    let v2 = is_v2_database(&app);
    run_db_task(app, move |db| {
        let conn = match db::get_db(db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };
    let _t_cost = Instant::now();

    // v2 分支：成本挂在 assistant 消息上（TASK-033）。
    if v2 {
        let set = fork_set(&conn, start_date.as_deref(), end_date.as_deref(), true);
        let hidden_json = set.message_ids_json();
        let window = window_of(start_date.as_deref(), end_date.as_deref());
        if let Some(result) =
            try_projection(&conn, window, &hidden_json, stats_v2::derive_cost_trend)
        {
            return result;
        }
        return match stats_v2::cost_trend(&conn, window, &hidden_json) {
            Ok(items) => {
                #[cfg(debug_assertions)]
                eprintln!("[perf] dashboard_cost_trend::v2: {}ms", _t_cost.elapsed().as_millis());
                IpcResult::ok(items)
            }
            Err(e) => IpcResult::err(e),
        };
    }

    let (filter_sql, filter_params) = build_date_filter("p", start_date.as_deref(), end_date.as_deref());
    let set = fork_set(&conn, start_date.as_deref(), end_date.as_deref(), v2);
    let part_json = set.part_ids_json();
    let mut params = boxed(&filter_params);
    params.push(Box::new(part_json));
    let sql = format!(
        "SELECT date(p.time_created / 1000, 'unixepoch', 'localtime') as d,
                COALESCE(SUM(json_extract(p.data, '$.cost')), 0) as c
         FROM part p
         WHERE json_extract(p.data, '$.type') = 'step-finish' {}{}
         GROUP BY d
         ORDER BY d ASC",
        filter_sql, exclusion_fragment("p")
    );

    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(e) => return IpcResult::err(e.to_string()),
    };
    let rows = match stmt.query_map(
        rusqlite::params_from_iter(params.iter()),
        |row| {
            let d: String = row.get(0)?;
            let c: f64 = row.get(1)?;
            Ok(CostTrendItem {
                date: d,
                value: c,
                label: None,
                total_cost: c,
            })
        },
    ) {
        Ok(r) => r,
        Err(e) => return IpcResult::err(e.to_string()),
    };

    let mut items = Vec::new();
    for row in rows {
        match row {
            Ok(item) => items.push(item),
            Err(e) => return IpcResult::err(e.to_string()),
        }
    }
    #[cfg(debug_assertions)]
    eprintln!("[perf] dashboard_cost_trend: {}ms", _t_cost.elapsed().as_millis());
    IpcResult::ok(items)
    }).await
}

// ─── 9. dashboard_message_trend ─────────────────────────────────────────

/// Message activity trend — daily message counts.
#[tauri::command]
pub async fn dashboard_message_trend(
    app: AppHandle,
    start_date: Option<String>,
    end_date: Option<String>,
) -> IpcResult<Vec<MessageTrendItem>> {
    let v2 = is_v2_database(&app);
    run_db_task(app, move |db| {
        let conn = match db::get_db(db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };
    let _t_msg = Instant::now();

    // v2 分支：按消息类型统计，排除 idle / model-switched / agent-switched（TASK-033）。
    if v2 {
        let set = fork_set(&conn, start_date.as_deref(), end_date.as_deref(), true);
        let hidden_json = set.message_ids_json();
        let window = window_of(start_date.as_deref(), end_date.as_deref());
        if let Some(result) =
            try_projection(&conn, window, &hidden_json, stats_v2::derive_message_trend)
        {
            return result;
        }
        return match stats_v2::message_trend(&conn, window, &hidden_json) {
            Ok(items) => {
                #[cfg(debug_assertions)]
                eprintln!("[perf] dashboard_message_trend::v2: {}ms", _t_msg.elapsed().as_millis());
                IpcResult::ok(items)
            }
            Err(e) => IpcResult::err(e),
        };
    }

    let (filter_sql, filter_params) = build_date_filter("", start_date.as_deref(), end_date.as_deref());
    let set = fork_set(&conn, start_date.as_deref(), end_date.as_deref(), v2);
    let message_json = set.message_ids_json();
    let mut params = boxed(&filter_params);
    params.push(Box::new(message_json));
    let sql = format!(
        "SELECT date(m.time_created / 1000, 'unixepoch', 'localtime') as d,
                COUNT(*) as cnt
         FROM message m
         WHERE 1=1 {}{}
         GROUP BY d
         ORDER BY d ASC",
        filter_sql, exclusion_fragment("m")
    );

    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(e) => return IpcResult::err(e.to_string()),
    };
    let rows = match stmt.query_map(
        rusqlite::params_from_iter(params.iter()),
        |row| {
            let d: String = row.get(0)?;
            let cnt: i64 = row.get(1)?;
            Ok(MessageTrendItem {
                date: d,
                value: cnt as f64,
                label: None,
                count: cnt,
            })
        },
    ) {
        Ok(r) => r,
        Err(e) => return IpcResult::err(e.to_string()),
    };

    let mut items = Vec::new();
    for row in rows {
        match row {
            Ok(item) => items.push(item),
            Err(e) => return IpcResult::err(e.to_string()),
        }
    }
    #[cfg(debug_assertions)]
    eprintln!("[perf] dashboard_message_trend: {}ms", _t_msg.elapsed().as_millis());
    IpcResult::ok(items)
    }).await
}

#[cfg(test)]
mod tests {
    use super::overview_part_counts_sql;

    #[test]
    fn overview_part_counts_use_session_message_on_v2() {
        for time_filtered in [true, false] {
            let v2_sql = overview_part_counts_sql(true, time_filtered);
            assert!(v2_sql.contains("FROM session_message"), "{v2_sql}");
            assert!(!v2_sql.contains("FROM part"), "{v2_sql}");

            let v1_sql = overview_part_counts_sql(false, time_filtered);
            assert!(v1_sql.contains("FROM part"), "{v1_sql}");
        }
    }

    #[test]
    fn v2_part_counts_sql_runs_against_v2_schema() {
        use crate::compat::test_support::{insert_v2_message, insert_v2_session, v2_mixed};

        let conn = v2_mixed();
        insert_v2_session(&conn, "ses_x", None);
        insert_v2_message(&conn, "m1", "ses_x", "user", 0, 1, r#"{"text":"hi"}"#);

        let (label, count): (String, i64) = conn
            .query_row(overview_part_counts_sql(true, false), [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .expect("v2 计数 SQL 必须可执行");
        assert_eq!(label, "part");
        assert_eq!(count, 1);
    }
}

/// 真实库基准探针（`#[ignore]`，默认不参与 `cargo test`）。
///
/// 实施计划的性能红线：14.8 GB 真库 30 天窗口每个命令 < 500 ms；全量
/// token ≈ 15.5 s、工具 ≈ 24 s（PR-4 的进程内索引落地前允许慢）。
///
/// 用法：
///
/// ```text
/// OPENCODE_W_BENCH_DB=~/.local/share/opencode/opencode.db \
///   cargo test bench_real_database -- --ignored --nocapture
/// ```
///
/// 探针**只读**打开数据库（`SQLITE_OPEN_READ_ONLY`），不改用户数据。
#[cfg(test)]
mod perf_probe {
    use super::{stats_v2, window_of};
    use crate::commands::fork_stats;
    use rusqlite::OpenFlags;
    use std::time::Instant;

    const DAY_MS: i64 = 24 * 60 * 60 * 1000;

    fn report(label: &str, elapsed: std::time::Duration, extra: &str) {
        println!(
            "{label:<28} {:>8} ms  {extra}",
            elapsed.as_millis()
        );
    }

    #[test]
    #[ignore = "需要真实 OpenCode 数据库：设置 OPENCODE_W_BENCH_DB 后手动运行"]
    fn bench_real_database() {
        let Some(path) = std::env::var_os("OPENCODE_W_BENCH_DB") else {
            eprintln!("[skip] 未设置 OPENCODE_W_BENCH_DB");
            return;
        };
        let conn = rusqlite::Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
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
        println!("模式：{:?}", info.mode);
        crate::schema::apply_session_view(&conn, &info).expect("session 视图可用");

        let now = chrono::Local::now().timestamp_millis();
        let (window_start, window_end) = (now - 30 * DAY_MS, now);
        let window_of_30d = Some((window_start, window_end));

        // ── 30 天窗口 ──
        fork_stats::invalidate_cache();
        let started = Instant::now();
        let set = fork_stats::dedup_v2_for_window(&conn, window_start, window_end)
            .expect("分叉归因");
        report("dedup_v2(30 天)", started.elapsed(), &format!(
            "隐藏会话 {} / 消息 {}",
            set.hidden_sessions.len(),
            set.hidden_messages.len()
        ));
        let hidden_json = set.message_ids_json();

        let started = Instant::now();
        let rows = stats_v2::scan_tokens(&conn, window_of_30d, &hidden_json).expect("token 扫描");
        report("dashboard_tokens(30 天)", started.elapsed(), &format!("{} 个日期分组", rows.len()));

        let started = Instant::now();
        let rows = stats_v2::scan_tokens(&conn, window_of_30d, &hidden_json).expect("token 扫描");
        report("dashboard_tokens(缓存命中)", started.elapsed(), &format!("{} 个日期分组", rows.len()));

        for (label, result) in [
            (
                "dashboard_tool_ranking",
                stats_v2::tool_ranking(&conn, window_of_30d, &hidden_json).map(|v| v.len()),
            ),
            (
                "dashboard_skill_usage",
                stats_v2::skill_usage(&conn, window_of_30d, &hidden_json).map(|v| v.len()),
            ),
            (
                "dashboard_model_ranking",
                stats_v2::model_ranking(&conn, window_of_30d, &hidden_json).map(|v| v.len()),
            ),
            (
                "dashboard_provider_stats",
                stats_v2::provider_stats(&conn, window_of_30d, &hidden_json).map(|v| v.len()),
            ),
            (
                "dashboard_project_ranking",
                stats_v2::project_ranking(&conn, window_of_30d, &hidden_json).map(|v| v.len()),
            ),
            (
                "dashboard_message_trend",
                stats_v2::message_trend(&conn, window_of_30d, &hidden_json).map(|v| v.len()),
            ),
            (
                "dashboard_cost_trend",
                stats_v2::cost_trend(&conn, window_of_30d, &hidden_json).map(|v| v.len()),
            ),
        ] {
            let started = Instant::now();
            let count = result.expect("统计查询成功");
            report(label, started.elapsed(), &format!("{count} 行"));
        }

        // ── 全量（无窗口）：允许慢，但不得比基线更差 ──
        fork_stats::invalidate_cache();
        let started = Instant::now();
        let set = fork_stats::dedup_v2(&conn).expect("分叉归因");
        report("dedup_v2(全量)", started.elapsed(), &format!(
            "隐藏会话 {} / 消息 {}",
            set.hidden_sessions.len(),
            set.hidden_messages.len()
        ));
        let hidden_json = set.message_ids_json();

        let started = Instant::now();
        let rows = stats_v2::scan_tokens(&conn, window_of(None, None), &hidden_json).expect("token 扫描");
        report("dashboard_tokens(全量)", started.elapsed(), &format!("{} 个日期分组", rows.len()));

        // 基线对照：实施计划记录的「直查 token 合计」≈ 15.5 s。
        let started = Instant::now();
        let plain: f64 = conn
            .query_row(
                "SELECT COALESCE(SUM(json_extract(data, '$.tokens.input')), 0) \
                 FROM main.session_message WHERE type = 'assistant'",
                [],
                |row| row.get(0),
            )
            .expect("基线查询成功");
        report("基线 token 合计(全量)", started.elapsed(), &format!("input={plain}"));

        let started = Instant::now();
        let ranking = stats_v2::tool_ranking(&conn, None, &hidden_json).expect("工具排行");
        report("dashboard_tool_ranking(全量)", started.elapsed(), &format!("{} 行", ranking.len()));

        let started = Instant::now();
        let skills = stats_v2::skill_usage(&conn, None, &hidden_json).expect("技能排行");
        report("dashboard_skill_usage(全量)", started.elapsed(), &format!("{} 行", skills.len()));
    }
}
