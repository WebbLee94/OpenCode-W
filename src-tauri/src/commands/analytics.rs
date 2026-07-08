use serde::Serialize;
use tauri::{AppHandle, Manager};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use chrono::TimeZone;

use crate::db::{self, DbState};
use crate::models::dto::{
    CostTrendItem, DatabaseStats, IpcResult, MessageTrendItem, ModelRankingItem, ProviderStatsItem,
    SessionTrendItem, SkillUsage, TokenGroupDataPoint, TokenStats, ToolRanking,
};
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;

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
    tauri::async_runtime::spawn_blocking(move || f(&db))
        .await
        .unwrap_or_else(|e| IpcResult::err(format!("thread error: {}", e)))
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
fn date_to_epoch_ms(date_str: &str, start_of_day: bool) -> i64 {
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
    run_db_task(app, move |db| {
    // No time range: delegate to db::get_stats for unfiltered counts
    if start_date.is_none() || end_date.is_none() {
        let s = db::get_stats(db);
        if let Some(err) = s.error {
            return IpcResult::err(err);
        }
        return IpcResult::ok(DatabaseStats {
            db_size: s.db_size,
            root_session_count: s.root_session_count,
            child_session_count: s.child_session_count,
            session_count: s.session_count,
            project_count: s.project_count,
            part_count: s.part_count,
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
    let params: [&dyn rusqlite::types::ToSql; 2] = [&start_epoch, &end_epoch];

    let _overview_start = Instant::now();
    let mut counts: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    let compound_sql =
        "SELECT 'root_session' as label, COUNT(*) as cnt FROM session WHERE parent_id IS NULL AND time_created BETWEEN ?1 AND ?2
         UNION ALL
         SELECT 'child_session', COUNT(*) FROM session WHERE parent_id IS NOT NULL AND time_created BETWEEN ?1 AND ?2
         UNION ALL
         SELECT 'project', COUNT(DISTINCT project_id) FROM session WHERE project_id IS NOT NULL AND project_id != '' AND time_created BETWEEN ?1 AND ?2
         UNION ALL
         SELECT 'part', COUNT(*) FROM part WHERE time_created BETWEEN ?1 AND ?2";
    if let Ok(mut stmt) = conn.prepare(compound_sql) {
        if let Ok(rows) = stmt.query_map(params, |row| {
            let label: String = row.get(0)?;
            let cnt: i64 = row.get(1)?;
            Ok((label, cnt))
        }) {
            for row in rows {
                if let Ok((label, cnt)) = row {
                    counts.insert(label, cnt);
                }
            }
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
    run_db_task(app, move |db| {
        let conn = match db::get_db(db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };

    let (filter_sql, filter_params) = build_date_filter(
        "p",
        start_date.as_deref(),
        end_date.as_deref(),
    );

    let _token_start = Instant::now();
    // Grouped mode: return time-series data points
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
            WHERE json_extract(p.data, '$.type') = 'step-finish' {}
            GROUP BY period
            ORDER BY period ASC",
            fmt, filter_sql
        );

        let mut stmt = match conn.prepare(&sql) {
            Ok(s) => s,
            Err(e) => return IpcResult::err(e.to_string()),
        };
        let rows = match stmt.query_map(rusqlite::params_from_iter(filter_params.iter()), |row| {
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
        WHERE json_extract(p.data, '$.type') = 'step-finish' {}",
        filter_sql
    );

    let stats = match conn.query_row(
        &sql,
        rusqlite::params_from_iter(filter_params.iter()),
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
            let total = input_i + output_i + reasoning_i;
            let reuse_rate = if total > 0 {
                (cache_read / total as f64) * 100.0
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
                cache_reuse_rate: (reuse_rate * 100.0).round() / 100.0,
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
            cache_reuse_rate: 0.0,
        },
        Err(e) => return IpcResult::err(e.to_string()),
    };

    #[cfg(debug_assertions)]
    eprintln!("[perf] dashboard_tokens::aggregate: {}ms", _token_start.elapsed().as_millis());
    IpcResult::ok(TokenStatsResult::Stats(stats))
    }).await
}

// ─── 3. dashboard_tool_ranking ──────────────────────────────────────────

/// Tool usage ranking — top 20 tools by invocation count.
#[tauri::command]
pub async fn dashboard_tool_ranking(
    app: AppHandle,
    start_date: Option<String>,
    end_date: Option<String>,
) -> IpcResult<Vec<ToolRanking>> {
    run_db_task(app, move |db| {
        let conn = match db::get_db(db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };
    let _t_tool = Instant::now();

    let (filter_sql, filter_params) = build_date_filter("", start_date.as_deref(), end_date.as_deref());
    let sql = format!(
        "SELECT
          COALESCE(json_extract(data, '$.tool'), 'unknown') as toolName,
          COUNT(*) as count
        FROM part
        WHERE json_extract(data, '$.type') = 'tool' {}
        GROUP BY toolName
        ORDER BY count DESC
        LIMIT 20",
        filter_sql
    );

    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(e) => return IpcResult::err(e.to_string()),
    };
    let rows = match stmt.query_map(
        rusqlite::params_from_iter(filter_params.iter()),
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
    run_db_task(app, move |db| {
        let conn = match db::get_db(db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };
    let _t_skill = Instant::now();

    let (filter_sql, filter_params) = build_date_filter("", start_date.as_deref(), end_date.as_deref());
    let sql = format!(
        "SELECT
          COALESCE(json_extract(data, '$.state.input.name'), 'unknown') as skillName,
          COUNT(*) as count
        FROM part
        WHERE json_extract(data, '$.type') = 'tool'
          AND json_extract(data, '$.tool') = 'skill' {}
        GROUP BY skillName
        ORDER BY count DESC
        LIMIT 20",
        filter_sql
    );

    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(e) => return IpcResult::err(e.to_string()),
    };
    let rows = match stmt.query_map(
        rusqlite::params_from_iter(filter_params.iter()),
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
#[tauri::command]
pub async fn dashboard_model_ranking(
    app: AppHandle,
    start_date: Option<String>,
    end_date: Option<String>,
) -> IpcResult<Vec<ModelRankingItem>> {
    run_db_task(app, move |db| {
        let conn = match db::get_db(db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };
    let _t_model = Instant::now();

    let (filter_sql, filter_params) = build_date_filter("p", start_date.as_deref(), end_date.as_deref());
    let sql = format!(
        "SELECT s.model as model,
                COUNT(DISTINCT p.session_id) as sessionCount,
                COALESCE(SUM(json_extract(p.data, '$.tokens.total')), 0) as tokenCount,
                COALESCE(SUM(json_extract(p.data, '$.cost')), 0) as totalCost
         FROM part p
         JOIN session s ON s.id = p.session_id
         WHERE json_extract(p.data, '$.type') = 'step-finish'
           AND s.model IS NOT NULL {}
         GROUP BY s.model
         ORDER BY sessionCount DESC
         LIMIT 10",
        filter_sql
    );

    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(e) => return IpcResult::err(e.to_string()),
    };
    let rows = match stmt.query_map(
        rusqlite::params_from_iter(filter_params.iter()),
        |row| {
            let token_count: f64 = row.get(2)?;
            let total_cost: f64 = row.get(3)?;
            Ok(ModelRankingItem {
                model: row.get(0)?,
                session_count: row.get(1)?,
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
    IpcResult::ok(items)
    }).await
}

// ─── 6. dashboard_provider_stats ────────────────────────────────────────

/// Provider stats — token/cost totals grouped by provider ID (extracted from session.model JSON).
#[tauri::command]
pub async fn dashboard_provider_stats(
    app: AppHandle,
    start_date: Option<String>,
    end_date: Option<String>,
) -> IpcResult<Vec<ProviderStatsItem>> {
    run_db_task(app, move |db| {
        let conn = match db::get_db(db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };
    let _t_prov = Instant::now();

    let (filter_sql, filter_params) = build_date_filter("p", start_date.as_deref(), end_date.as_deref());
    let sql = format!(
        "SELECT json_extract(s.model, '$.providerID') as provider,
                COUNT(DISTINCT p.session_id) as sessionCount,
                COALESCE(SUM(json_extract(p.data, '$.tokens.total')), 0) as tokenCount,
                COALESCE(SUM(json_extract(p.data, '$.cost')), 0) as totalCost
         FROM part p
         JOIN session s ON s.id = p.session_id
         WHERE json_extract(p.data, '$.type') = 'step-finish'
           AND json_extract(s.model, '$.providerID') IS NOT NULL {}
         GROUP BY provider
         ORDER BY sessionCount DESC",
        filter_sql
    );

    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(e) => return IpcResult::err(e.to_string()),
    };
    let rows = match stmt.query_map(
        rusqlite::params_from_iter(filter_params.iter()),
        |row| {
            let provider: Option<String> = row.get(0)?;
            let token_count: f64 = row.get(2)?;
            let total_cost: f64 = row.get(3)?;
            Ok(ProviderStatsItem {
                provider: provider.unwrap_or_else(|| "unknown".to_string()),
                session_count: row.get(1)?,
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
    IpcResult::ok(items)
    }).await
}

// ─── 7. dashboard_session_trend ─────────────────────────────────────────

/// Session creation trend — daily counts, optionally filtered to root sessions only.
///
/// 前端传递 `{ startDate, endDate, rootOnly }`，Tauri 自动 camelCase → snake_case 转换。
#[tauri::command]
pub async fn dashboard_session_trend(
    app: AppHandle,
    start_date: Option<String>,
    end_date: Option<String>,
    root_only: Option<bool>,
) -> IpcResult<Vec<SessionTrendItem>> {
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
    let sql = format!(
        "SELECT date(time_created / 1000, 'unixepoch', 'localtime') as d,
                COUNT(*) as cnt
         FROM session
         WHERE 1=1 {}{}
         GROUP BY d
         ORDER BY d ASC",
        filter_sql, root_filter
    );

    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(e) => return IpcResult::err(e.to_string()),
    };
    let rows = match stmt.query_map(
        rusqlite::params_from_iter(filter_params.iter()),
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
    run_db_task(app, move |db| {
        let conn = match db::get_db(db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };
    let _t_cost = Instant::now();

    let (filter_sql, filter_params) = build_date_filter("p", start_date.as_deref(), end_date.as_deref());
    let sql = format!(
        "SELECT date(p.time_created / 1000, 'unixepoch', 'localtime') as d,
                COALESCE(SUM(json_extract(p.data, '$.cost')), 0) as c
         FROM part p
         WHERE json_extract(p.data, '$.type') = 'step-finish' {}
         GROUP BY d
         ORDER BY d ASC",
        filter_sql
    );

    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(e) => return IpcResult::err(e.to_string()),
    };
    let rows = match stmt.query_map(
        rusqlite::params_from_iter(filter_params.iter()),
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
    run_db_task(app, move |db| {
        let conn = match db::get_db(db) {
            Ok(c) => c,
            Err(e) => return IpcResult::err(e),
        };
    let _t_msg = Instant::now();

    let (filter_sql, filter_params) = build_date_filter("", start_date.as_deref(), end_date.as_deref());
    let sql = format!(
        "SELECT date(m.time_created / 1000, 'unixepoch', 'localtime') as d,
                COUNT(*) as cnt
         FROM message m
         WHERE 1=1 {}
         GROUP BY d
         ORDER BY d ASC",
        filter_sql
    );

    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(e) => return IpcResult::err(e.to_string()),
    };
    let rows = match stmt.query_map(
        rusqlite::params_from_iter(filter_params.iter()),
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