//! v2 统计口径的只读查询（实施计划 TASK-030 ~ TASK-033）。
//!
//! v1 的统计全部读旧表 `part`（`step-finish` 分片带 token / cost）与
//! `session`（模型、目录等维度）。v2 没有 `part` 表：
//!
//! - token / cost 挂在 **assistant 消息**上
//!   （`session_message.data.tokens` / `data.cost`）；
//! - 工具调用是消息 `data.content[]` 里的 `type='tool'` 块；
//! - 模型 / 供应商 / 项目维度来自 `session_v2`。
//!
//! 三条硬约束：
//!
//! 1. **只用消息级数据**：不使用 `session_v2.tokens_*` / `cost` 聚合列
//!    （E-14 / ASSUMPTION-002：两者口径差 2.5%~21%）。
//! 2. **时间窗口必须下推**：所有查询都把 `session_message.time_created`
//!    的窗口条件写进 `WHERE`，命中 `session_message_time_created_idx`。
//! 3. **口径与 v1 对齐**：分组键、排序、条数上限、缓存命中率公式都与 v1
//!    逐字一致（`groupBy` 的 day / week / month 用同一套 `strftime` 格式）。
//!
//! ## 性能取舍：为什么 token 扫描不在 SQL 里 `GROUP BY`
//!
//! `session_message.data` 是整条消息 JSON（14.8 GB 真库上约 7 GB）。
//! `GROUP BY` 会让 SQLite 把 `data` 带进临时 B 树排序：实测 25.3 s，
//! 而「顺序扫描 + 内存聚合」与「纯合计」同量级（19.0 s），临时文件也不会
//! 膨胀到 GB 级（OOM 风险）。因此 token 扫描改成**逐行取小值、内存里按天
//! 聚合**，顺带让「总量」与「分组」共用同一次扫描。
//!
//! ## 本版已接受的口径边界（1.4.0 定稿，留 PR-4 统一）
//!
//! 1. **混合库里的「旧表独有会话」与「旧表尾消息」不进 v2 仪表盘聚合**。
//!    - 旧表独有会话：只存在于旧 `session` 表、消息在旧 `message` / `part`，
//!      不在 `session_message` 里；模型 / 供应商 / 项目排行 JOIN
//!      `session_v2`，因此统计不到它们。
//!    - 旧表尾消息：迁移后由 v1 客户端追加写入、只在旧 `message` 表里的行
//!      （真库 41 条），同样不在 `session_message` 里。
//!    - 影响量级：真库只有 1 个旧表独有会话 / 41 条尾消息，占总量 0.04%。
//!      为这 0.04% 精度在每次仪表盘查询上多扫一遍 5.6 GB 的旧 `part` 表
//!      **不划算**，因此 1.4.0 接受该偏差，PR-4 的进程内索引落地时统一
//!      处理（会话级统计 `sessions.rs` 已经包含尾消息）。
//! 2. **`message_trend` 排除 `idle` / `model-switched` / `agent-switched`**。
//!    - Q-03 说这些类型「隐藏但计入逻辑统计」，指的是**会话 / 消息的逻辑
//!      计数**（`msg_count`、会话详情统计）；趋势图是**展示口径**，与消息
//!      列表保持一致（列表里这三类同样不展示），因此不计入趋势。
//!    - 其余未知类型仍计入趋势（默认安全，E-15）。
//!
//! 本模块只读：不建表、不改表、不写 `kv`（SEC-001）。所有取值参数化，
//! JSON 路径与表名只来自本模块常量（SEC-003）。

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use rusqlite::{Connection, ToSql};
use serde::Deserialize;

use crate::commands::fork_stats;
use crate::models::dto::{
    CostTrendItem, MessageTrendItem, ModelRankingItem, ProjectRankingItem, ProviderStatsItem,
    SkillUsage, TokenGroupDataPoint, TokenStats, ToolRanking,
};

/// v2 统计里被排除的消息类型（Q-03：这些事件不计入消息活跃度趋势）。
const HIDDEN_MESSAGE_TYPES: [&str; 3] = ["idle", "model-switched", "agent-switched"];

/// v2 token 扫描的缓存有效期（与 `fork_stats` 的归因缓存一致）。
const TOKEN_CACHE_TTL: Duration = Duration::from_secs(5);

/// 一条「天」级聚合结果，同时带出周 / 月分组键。
///
/// 三个键都由**本地日期**唯一决定，因此按天聚合后可以在内存里无损地
/// 重新分组成周 / 月（不必为每种 `groupBy` 各扫一次全库）。
#[derive(Debug, Clone)]
pub struct TokenRow {
    pub day: String,
    pub week: String,
    pub month: String,
    pub input: f64,
    pub output: f64,
    pub reasoning: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub cost: f64,
}

/// v2 统计用的时间窗口。
pub type Window = Option<(i64, i64)>;

/// SQL 片段 + 参数收集器。
///
/// 参数按出现顺序编号（`?1`、`?2`……），保证「SQL 引用的占位符」与「绑定
/// 的参数」一一对应：可选项（例如空的隐藏集合）不出现时不会留下悬空占位符。
struct Query {
    params: Vec<Box<dyn ToSql>>,
}

impl Query {
    fn new() -> Self {
        Query { params: Vec::new() }
    }

    fn bind(&mut self, value: Box<dyn ToSql>) -> usize {
        self.params.push(value);
        self.params.len()
    }

    /// 分叉归因隐藏的消息 id。
    ///
    /// 集合为空时**不写**这个条件：`NOT IN (SELECT ... json_each(?))` 在全表
    /// 扫描上明显拖慢查询（实测 24.0 s → 29.6 s），而空集合本来就排除不了
    /// 任何行。
    fn push_hidden(&mut self, sql: &mut String, hidden_json: &str) {
        if hidden_json.is_empty() || hidden_json == "[]" {
            return;
        }
        let slot = self.bind(Box::new(hidden_json.to_string()));
        sql.push_str(&format!(
            " AND sm.id NOT IN (SELECT value FROM json_each(?{slot}))"
        ));
    }

    /// 时间窗口（`session_message.time_created`，可走
    /// `session_message_time_created_idx`）。
    fn push_window(&mut self, sql: &mut String, window: Window) {
        let Some((start, end)) = window else {
            return;
        };
        let from = self.bind(Box::new(start));
        let to = self.bind(Box::new(end));
        sql.push_str(&format!(
            " AND sm.time_created BETWEEN ?{from} AND ?{to}"
        ));
    }
}

/// 统计失败时的中文提示（REQ-006）。
fn query_error(context: &str, error: rusqlite::Error) -> String {
    format!("统计查询失败（{}）：{}", context, error)
}

/// v2 token 扫描：顺序扫描 assistant 消息，在内存里按天聚合。
///
/// 输出「天」级行（自带周 / 月键），因此：
///
/// - 总量 = 所有行的和；
/// - `groupBy` = day / week / month 的重新分组；
/// - 前端并发调用两次（总量 + 分组）只扫一次全库。
pub fn scan_tokens(
    conn: &Connection,
    window: Window,
    hidden_json: &str,
) -> Result<Vec<TokenRow>, String> {
    let mut query = Query::new();
    let mut sql = String::from(
        "SELECT strftime('%Y-%m-%d', sm.time_created / 1000, 'unixepoch', 'localtime'),
                strftime('%Y-W%W', sm.time_created / 1000, 'unixepoch', 'localtime'),
                strftime('%Y-%m', sm.time_created / 1000, 'unixepoch', 'localtime'),
                json_extract(sm.data, '$.tokens.input'),
                json_extract(sm.data, '$.tokens.output'),
                json_extract(sm.data, '$.tokens.reasoning'),
                json_extract(sm.data, '$.tokens.cache.read'),
                json_extract(sm.data, '$.tokens.cache.write'),
                json_extract(sm.data, '$.cost')
         FROM main.session_message sm
         WHERE sm.type = 'assistant'",
    );
    query.push_hidden(&mut sql, hidden_json);
    query.push_window(&mut sql, window);

    let mut stmt = conn.prepare(&sql).map_err(|e| query_error("token", e))?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(query.params.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<f64>>(3)?,
                row.get::<_, Option<f64>>(4)?,
                row.get::<_, Option<f64>>(5)?,
                row.get::<_, Option<f64>>(6)?,
                row.get::<_, Option<f64>>(7)?,
                row.get::<_, Option<f64>>(8)?,
            ))
        })
        .map_err(|e| query_error("token", e))?;

    let mut buckets: BTreeMap<(String, String, String), TokenRow> = BTreeMap::new();
    for row in rows {
        let (day, week, month, input, output, reasoning, cache_read, cache_write, cost) =
            row.map_err(|e| query_error("token", e))?;
        let bucket = buckets
            .entry((day.clone(), week.clone(), month.clone()))
            .or_insert_with(|| TokenRow {
                day: day.clone(),
                week: week.clone(),
                month: month.clone(),
                input: 0.0,
                output: 0.0,
                reasoning: 0.0,
                cache_read: 0.0,
                cache_write: 0.0,
                cost: 0.0,
            });
        bucket.input += input.unwrap_or(0.0);
        bucket.output += output.unwrap_or(0.0);
        bucket.reasoning += reasoning.unwrap_or(0.0);
        bucket.cache_read += cache_read.unwrap_or(0.0);
        bucket.cache_write += cache_write.unwrap_or(0.0);
        bucket.cost += cost.unwrap_or(0.0);
    }
    Ok(buckets.into_values().collect())
}

// ─── token 扫描缓存 ──────────────────────────────────────────────────────

/// 缓存键必须带上 `hidden_json`：同一路径、同一窗口下，不同的分叉隐藏
/// 集合会得到不同的扫描结果，不能互相复用。
type TokenCacheKey = (String, Window, u64, String);

struct TokenSlot {
    state: Mutex<Option<(Instant, Arc<Vec<TokenRow>>)>>,
}

fn token_cache() -> &'static Mutex<BTreeMap<TokenCacheKey, Arc<TokenSlot>>> {
    static CACHE: OnceLock<Mutex<BTreeMap<TokenCacheKey, Arc<TokenSlot>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(BTreeMap::new()))
}

/// 带缓存的 token 扫描。
///
/// 前端会**并发**调用 `dashboard_tokens` 两次（总量 + 分组），两次的时间
/// 窗口相同。缓存让两次调用共用同一次全表扫描：先到的调用在算，后到的
/// 调用阻塞等待并直接复用结果（PR-3 性能红线：「能一次算完就一次算完」）。
///
/// 缓存键含 `fork_stats::cache_generation()`：写操作会让代次变化，
/// 旧结果自然失效，无需额外的失效通道。键同时包含 `hidden_json`，
/// 避免不同分叉隐藏集合之间串用结果。
pub fn scan_tokens_cached(
    conn: &Connection,
    window: Window,
    hidden_json: &str,
) -> Result<Arc<Vec<TokenRow>>, String> {
    let Some(path) = cache_path(conn) else {
        return Ok(Arc::new(scan_tokens(conn, window, hidden_json)?));
    };
    let generation = fork_stats::cache_generation();
    let key = (path, window, generation, hidden_json.to_string());

    let slot = {
        let mut map = token_cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // 只保留当前代次的条目，避免写操作后无限增长。
        map.retain(|(_, _, gen, _), _| *gen == generation);
        map.entry(key)
            .or_insert_with(|| {
                Arc::new(TokenSlot {
                    state: Mutex::new(None),
                })
            })
            .clone()
    };

    let mut guard = slot
        .state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((created_at, rows)) = guard.as_ref() {
        if created_at.elapsed() <= TOKEN_CACHE_TTL {
            return Ok(Arc::clone(rows));
        }
    }
    let rows = Arc::new(scan_tokens(conn, window, hidden_json)?);
    *guard = Some((Instant::now(), Arc::clone(&rows)));
    Ok(rows)
}

fn cache_path(conn: &Connection) -> Option<String> {
    conn.path()
        .and_then(|path| std::path::Path::new(path).canonicalize().ok())
        .map(|path| path.to_string_lossy().into_owned())
}

// ─── 聚合与分组 ──────────────────────────────────────────────────────────

/// 总量：与 v1 `dashboard_tokens` 的聚合口径逐字一致。
///
/// v1 的公式：`hit_rate = cache_read / (cache_read + input) * 100`，
/// 再 `(hit_rate * 100).round() / 100`（注意是二次乘 100，原样保留）。
pub fn aggregate(rows: &[TokenRow]) -> TokenStats {
    let (mut input, mut output, mut reasoning) = (0.0f64, 0.0f64, 0.0f64);
    let (mut cache_read, mut cache_write, mut cost) = (0.0f64, 0.0f64, 0.0f64);
    for row in rows {
        input += row.input;
        output += row.output;
        reasoning += row.reasoning;
        cache_read += row.cache_read;
        cache_write += row.cache_write;
        cost += row.cost;
    }

    let total_attempts = cache_read + input;
    let hit_rate = if total_attempts > 0.0 {
        (cache_read / total_attempts) * 100.0
    } else {
        0.0
    };

    TokenStats {
        input_tokens: input as i64,
        output_tokens: output as i64,
        reasoning_tokens: reasoning as i64,
        cache_read: cache_read as i64,
        cache_write: cache_write as i64,
        estimated_cost: cost,
        cache_hit_rate: (hit_rate * 100.0).round() / 100.0,
    }
}

/// 按 `groupBy` 分组：day / week / month，与 v1 的 `strftime` 格式一致。
///
/// 天级行已经带出周 / 月键，因此三种分组都不需要额外的库扫描。
pub fn grouped(rows: &[TokenRow], group_by: &str) -> Vec<TokenGroupDataPoint> {
    let mut buckets: BTreeMap<String, (f64, f64, f64, f64, f64, f64)> = BTreeMap::new();
    for row in rows {
        let period = match group_by {
            "week" => row.week.clone(),
            "month" => row.month.clone(),
            _ => row.day.clone(),
        };
        let bucket = buckets.entry(period.clone()).or_insert((
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
        ));
        bucket.0 += row.input;
        bucket.1 += row.output;
        bucket.2 += row.reasoning;
        bucket.3 += row.cache_read;
        bucket.4 += row.cache_write;
        bucket.5 += row.cost;
    }

    buckets
        .into_iter()
        .map(
            |(period, (input, output, reasoning, cache_read, cache_write, cost))| {
                TokenGroupDataPoint {
                    period,
                    input_tokens: input as i64,
                    output_tokens: output as i64,
                    reasoning_tokens: reasoning as i64,
                    cache_read: cache_read as i64,
                    cache_write: cache_write as i64,
                    estimated_cost: cost,
                }
            },
        )
        .collect()
}

// ─── 工具 / 技能排行 ────────────────────────────────────────────────────

/// v2 工具排行：`content[].type='tool'` 的 `name` 计数。
///
/// 与 v1 一致：名字缺失记为 `unknown`，取前 20。
///
/// 计数放在内存里做：`GROUP BY` 会让 SQLite 把 `content[]` 里展开的块
/// （真库 32 万个）带进临时 B 树，实测比「取出名字、内存计数」慢一倍以上。
pub fn tool_ranking(
    conn: &Connection,
    window: Window,
    hidden_json: &str,
) -> Result<Vec<ToolRanking>, String> {
    let mut query = Query::new();
    let mut sql = String::from(
        "SELECT json_extract(c.value, '$.name')
         FROM main.session_message sm, json_each(sm.data, '$.content') AS c
         WHERE json_extract(c.value, '$.type') = 'tool'",
    );
    query.push_hidden(&mut sql, hidden_json);
    query.push_window(&mut sql, window);

    let counts = count_names(conn, &sql, &query.params, "工具排行")?;
    Ok(top_counts(
        counts,
        20,
        |tool_name, count| ToolRanking { tool_name, count },
    ))
}

/// v2 技能排行：`content[].name='skill'` 的 `state.input.name` 计数。
///
/// 新版 OpenCode 的技能调用可能只带 `state.input.id`（无 `name`），因此
/// 优先取非空 `name`，再退回非空 `id`；两者都缺失时仍记为 `unknown`。
pub fn skill_usage(
    conn: &Connection,
    window: Window,
    hidden_json: &str,
) -> Result<Vec<SkillUsage>, String> {
    let mut query = Query::new();
    let mut sql = String::from(
        "SELECT COALESCE(NULLIF(json_extract(c.value, '$.state.input.name'), ''),
                         NULLIF(json_extract(c.value, '$.state.input.id'), ''))
         FROM main.session_message sm, json_each(sm.data, '$.content') AS c
         WHERE json_extract(c.value, '$.type') = 'tool'
           AND json_extract(c.value, '$.name') = 'skill'",
    );
    query.push_hidden(&mut sql, hidden_json);
    query.push_window(&mut sql, window);

    let counts = count_names(conn, &sql, &query.params, "技能排行")?;
    Ok(top_counts(
        counts,
        20,
        |skill_name, count| SkillUsage { skill_name, count },
    ))
}

/// 逐行取名字并在内存里计数。
fn count_names(
    conn: &Connection,
    sql: &str,
    params: &[Box<dyn ToSql>],
    context: &str,
) -> Result<BTreeMap<String, i64>, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| query_error(context, e))?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params.iter()), |row| {
            row.get::<_, Option<String>>(0)
        })
        .map_err(|e| query_error(context, e))?;

    let mut counts: BTreeMap<String, i64> = BTreeMap::new();
    for row in rows {
        let name = row.map_err(|e| query_error(context, e))?;
        *counts
            .entry(name.unwrap_or_else(|| String::from("unknown")))
            .or_insert(0) += 1;
    }
    Ok(counts)
}

/// 次数降序取前 N；同次数按名字升序，保证结果确定。
fn top_counts<T>(
    counts: BTreeMap<String, i64>,
    limit: usize,
    build: impl Fn(String, i64) -> T,
) -> Vec<T> {
    let mut items: Vec<(String, i64)> = counts.into_iter().collect();
    items.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    items.truncate(limit);
    items.into_iter().map(|(name, count)| build(name, count)).collect()
}

// ─── 模型 / 供应商 / 项目排行 ───────────────────────────────────────────

/// 消息级 token 合计：input + output + reasoning + cache.read + cache.write。
///
/// v1 的 `step-finish` 有 `tokens.total`，v2 没有，需要自行相加
/// （E-09 / TASK-013）。
const TOKEN_TOTAL_SQL: &str = "(COALESCE(json_extract(sm.data, '$.tokens.input'), 0)
       + COALESCE(json_extract(sm.data, '$.tokens.output'), 0)
       + COALESCE(json_extract(sm.data, '$.tokens.reasoning'), 0)
       + COALESCE(json_extract(sm.data, '$.tokens.cache.read'), 0)
       + COALESCE(json_extract(sm.data, '$.tokens.cache.write'), 0))";

/// 模型归并键：JSON 模型按 `id + providerID` 归并（忽略 `variant`），
/// 非 JSON 模型保留原始字符串。
const MODEL_GROUP_KEY_SQL: &str = "CASE WHEN json_valid(s.model)
                  AND substr(trim(s.model), 1, 1) = '{'
             THEN COALESCE(json_extract(s.model, '$.id'),
                           json_extract(s.model, '$.modelID'),
                           s.model)
                  || char(31)
                  || COALESCE(json_extract(s.model, '$.providerID'), '')
             ELSE s.model END";

/// v2 模型排行：按消息聚合 token / cost，再 JOIN `session_v2` 取 `model`。
///
/// 同一模型可能以不同 `variant` 存成多行 JSON；这里按 `id + providerID`
/// 归并。返回的 `model` 仍是可被前端 `JSON.parse` 的 JSON 字符串
/// （`{"id":...,"providerID":...}`），非 JSON 模型保持原串。
pub fn model_ranking(
    conn: &Connection,
    window: Window,
    hidden_json: &str,
) -> Result<Vec<ModelRankingItem>, String> {
    let mut query = Query::new();
    let mut sql = format!(
        "SELECT CASE WHEN json_valid(s.model)
                      AND substr(trim(s.model), 1, 1) = '{{'
                THEN json_object(
                       'id', COALESCE(json_extract(s.model, '$.id'),
                                      json_extract(s.model, '$.modelID')),
                       'providerID', json_extract(s.model, '$.providerID'))
                ELSE s.model END AS model,
                COALESCE(SUM({TOKEN_TOTAL_SQL}), 0) AS tokenCount,
                COALESCE(SUM(json_extract(sm.data, '$.cost')), 0) AS totalCost
         FROM main.session_message sm
         JOIN main.session_v2 s ON s.id = sm.session_id
         WHERE sm.type = 'assistant'
           AND s.model IS NOT NULL"
    );
    query.push_hidden(&mut sql, hidden_json);
    query.push_window(&mut sql, window);
    sql.push_str(&format!(
        " GROUP BY {MODEL_GROUP_KEY_SQL} ORDER BY tokenCount DESC LIMIT 10"
    ));

    let mut stmt = conn.prepare(&sql).map_err(|e| query_error("模型排行", e))?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(query.params.iter()), |row| {
            let token_count: f64 = row.get(1)?;
            let total_cost: f64 = row.get(2)?;
            Ok(ModelRankingItem {
                model: row.get(0)?,
                token_count: token_count as i64,
                total_cost,
            })
        })
        .map_err(|e| query_error("模型排行", e))?;

    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|e| query_error("模型排行", e))?);
    }
    Ok(items)
}

/// v2 供应商统计：按 `session_v2.model.providerID` 分组。
pub fn provider_stats(
    conn: &Connection,
    window: Window,
    hidden_json: &str,
) -> Result<Vec<ProviderStatsItem>, String> {
    let mut query = Query::new();
    let mut sql = format!(
        "SELECT CASE WHEN json_valid(s.model) THEN json_extract(s.model, '$.providerID') END AS provider,
                COALESCE(SUM({TOKEN_TOTAL_SQL}), 0) AS tokenCount,
                COALESCE(SUM(json_extract(sm.data, '$.cost')), 0) AS totalCost
         FROM main.session_message sm
         JOIN main.session_v2 s ON s.id = sm.session_id
         WHERE sm.type = 'assistant'
           AND json_valid(s.model)
           AND json_extract(s.model, '$.providerID') IS NOT NULL"
    );
    query.push_hidden(&mut sql, hidden_json);
    query.push_window(&mut sql, window);
    sql.push_str(" GROUP BY provider ORDER BY tokenCount DESC");

    let mut stmt = conn.prepare(&sql).map_err(|e| query_error("供应商统计", e))?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(query.params.iter()), |row| {
            let provider: Option<String> = row.get(0)?;
            let token_count: f64 = row.get(1)?;
            let total_cost: f64 = row.get(2)?;
            Ok(ProviderStatsItem {
                provider: provider.unwrap_or_else(|| String::from("unknown")),
                token_count: token_count as i64,
                total_cost,
            })
        })
        .map_err(|e| query_error("供应商统计", e))?;

    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|e| query_error("供应商统计", e))?);
    }
    Ok(items)
}

/// v2 项目排行：按 `session_v2.directory` 分组，取目录名（末段）。
pub fn project_ranking(
    conn: &Connection,
    window: Window,
    hidden_json: &str,
) -> Result<Vec<ProjectRankingItem>, String> {
    let mut query = Query::new();
    let mut sql = format!(
        "SELECT s.directory AS directory,
                COALESCE(SUM({TOKEN_TOTAL_SQL}), 0) AS tokenCount,
                COALESCE(SUM(json_extract(sm.data, '$.cost')), 0) AS totalCost
         FROM main.session_message sm
         JOIN main.session_v2 s ON s.id = sm.session_id
         WHERE sm.type = 'assistant'
           AND s.directory IS NOT NULL AND s.directory != ''"
    );
    query.push_hidden(&mut sql, hidden_json);
    query.push_window(&mut sql, window);
    sql.push_str(" GROUP BY s.directory ORDER BY tokenCount DESC LIMIT 10");

    let mut stmt = conn.prepare(&sql).map_err(|e| query_error("项目排行", e))?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(query.params.iter()), |row| {
            let directory: String = row.get(0)?;
            let token_count: f64 = row.get(1)?;
            let total_cost: f64 = row.get(2)?;
            let project = directory.rsplit('/').next().unwrap_or(&directory).to_string();
            Ok(ProjectRankingItem {
                project,
                token_count: token_count as i64,
                total_cost,
            })
        })
        .map_err(|e| query_error("项目排行", e))?;

    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|e| query_error("项目排行", e))?);
    }
    Ok(items)
}

// ─── 趋势 ────────────────────────────────────────────────────────────────

/// v2 消息趋势：按天统计消息数，排除 `idle` / `model-switched` /
/// `agent-switched`。
///
/// 口径说明（1.4.0 定稿）：趋势图是**展示口径**，与消息列表一致——这三类
/// 事件在列表里同样不展示（Q-03 的「隐藏但计入逻辑统计」指的是会话 / 消息
/// 的逻辑计数，不是趋势）。其余未知类型仍计入趋势（默认安全，E-15）。
pub fn message_trend(
    conn: &Connection,
    window: Window,
    hidden_json: &str,
) -> Result<Vec<MessageTrendItem>, String> {
    let mut query = Query::new();
    let mut sql = format!(
        "SELECT date(sm.time_created / 1000, 'unixepoch', 'localtime') AS d,
                COUNT(*) AS cnt
         FROM main.session_message sm
         WHERE sm.type NOT IN ({})",
        HIDDEN_MESSAGE_TYPES
            .iter()
            .map(|kind| format!("'{}'", kind))
            .collect::<Vec<String>>()
            .join(", ")
    );
    query.push_hidden(&mut sql, hidden_json);
    query.push_window(&mut sql, window);
    sql.push_str(" GROUP BY d ORDER BY d ASC");

    let mut stmt = conn.prepare(&sql).map_err(|e| query_error("消息趋势", e))?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(query.params.iter()), |row| {
            let d: String = row.get(0)?;
            let cnt: i64 = row.get(1)?;
            Ok(MessageTrendItem {
                date: d,
                value: cnt as f64,
                label: None,
                count: cnt,
            })
        })
        .map_err(|e| query_error("消息趋势", e))?;

    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|e| query_error("消息趋势", e))?);
    }
    Ok(items)
}

/// v2 成本趋势：按天汇总 assistant 消息的 `cost`。
pub fn cost_trend(
    conn: &Connection,
    window: Window,
    hidden_json: &str,
) -> Result<Vec<CostTrendItem>, String> {
    let mut query = Query::new();
    let mut sql = String::from(
        "SELECT date(sm.time_created / 1000, 'unixepoch', 'localtime') AS d,
                COALESCE(SUM(json_extract(sm.data, '$.cost')), 0) AS c
         FROM main.session_message sm
         WHERE sm.type = 'assistant'",
    );
    query.push_hidden(&mut sql, hidden_json);
    query.push_window(&mut sql, window);
    sql.push_str(" GROUP BY d ORDER BY d ASC");

    let mut stmt = conn.prepare(&sql).map_err(|e| query_error("成本趋势", e))?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(query.params.iter()), |row| {
            let d: String = row.get(0)?;
            let c: f64 = row.get(1)?;
            Ok(CostTrendItem {
                date: d,
                value: c,
                label: None,
                total_cost: c,
            })
        })
        .map_err(|e| query_error("成本趋势", e))?;

    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|e| query_error("成本趋势", e))?);
    }
    Ok(items)
}

// ─── T2：窗口投影（单趟扫描 + 内存聚合 + 缓存） ──────────────────────────
//
// 设计约束（实施规格 B-1，见私有文档 T2 设计草案）：
//
// 1. **SQL 里不出现任何 JSON 函数**：`json_extract` 每次调用都会重新解析整条
//    JSON，`json_group_array` 还要为每条消息构造一次数组；真库实测 (a) 19.1s、
//    (c) 18.3s，而「SQL 只取原始列 + Rust 单趟解析」为 4.26s。因此投影走
//    `data` 原样取出、Rust 一次反序列化同时拿到 tokens / cost / content。
// 2. **每条消息只累加一次**：不 JOIN `json_each`，行数不会被 content 块放大，
//    也不依赖任何行序（无 ORDER BY 假设）。
// 3. **口径与旧实现逐字一致**：派生函数直接复用 `aggregate` / `grouped` /
//    `top_counts`，模型按（id, providerID）归并后仍输出可被前端解析的 JSON。
// 4. **失败即可回退**：任何错误都返回 `Err`，调用方记录日志后走旧 SQL。
//
// 形状差异（skill 的 name / state.input.id，model 的 id / providerID）全部
// 收敛在 `shape` 模块，SQL 只输出原始值。
//
// 注意：block 顶层的 `id` 是**工具调用 id**（如 `call_00_XtIM...`），不是技能名，
// 不能进技能名的回退链——否则技能排行会出现一堆 `call_...`。

/// 投影缓存版本号：实现变更时必须 +1，避免旧投影被复用。
pub const PROJ_VERSION: u32 = 1;

/// 单窗口投影允许的最大消息行数；超过则放弃投影、回退旧查询，避免大库内存风险。
const PROJ_MAX_ROWS: i64 = 400_000;

/// 投影缓存条目上限（本期窗口 + 上期窗口）。
const PROJ_CACHE_ENTRIES: usize = 2;

/// 形状适配层。
///
/// 只做「同义字段归一」，不含任何 I/O；Wave 2/3 新增形状时在这里加分支，
/// 不需要改 SQL、聚合或 DTO。
pub mod shape {
    use std::borrow::Cow;

    use serde::Deserialize;

    /// 模型键。
    ///
    /// 旧 SQL 的口径是：
    ///
    /// - 结构化（`json_valid` 且以 `{` 开头）：按 `id || char(31) || providerID`
    ///   分组，输出 `json_object('id', COALESCE(id, modelID), 'providerID', providerID)`；
    /// - 非结构化：整串作为一个分组，原样输出。
    ///
    /// [`ModelKey::group_key`] 与 [`ModelKey::json`] 分别复刻这两半，保证
    /// 投影输出与旧查询逐字一致。
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct ModelKey {
        /// `$.id`，缺失退回 `$.modelID`（两者都缺时保持 `None`）。
        pub id: Option<String>,
        /// `$.providerID`；缺失为 `None`（分组时按 `''` 处理）。
        pub provider: Option<String>,
        /// 原始 `session_v2.model` 文本。
        pub raw: String,
        /// 是否为可解析的 JSON 对象。
        pub structured: bool,
    }

    /// 模型 JSON 的最小视图。
    ///
    /// 用 `Cow` 而不是 `&str`：带转义字符的字符串无法零拷贝借用，`&str`
    /// 会让整条消息反序列化失败（真库确实存在这种模型名）。
    #[derive(Deserialize)]
    struct RawModel<'a> {
        #[serde(default)]
        id: Option<Cow<'a, str>>,
        #[serde(default, rename = "modelID")]
        model_id: Option<Cow<'a, str>>,
        #[serde(default, rename = "providerID")]
        provider: Option<Cow<'a, str>>,
    }

    impl ModelKey {
        /// 分组键：`(id 或原串, providerID 或 '')`。
        pub fn group_key(&self) -> (String, String) {
            if self.structured {
                (
                    self.id.clone().unwrap_or_else(|| self.raw.clone()),
                    self.provider.clone().unwrap_or_default(),
                )
            } else {
                (self.raw.clone(), String::new())
            }
        }

        /// 输出给前端的模型字符串。
        pub fn json(&self) -> String {
            if self.structured {
                serde_json::json!({
                    "id": self.id,
                    "providerID": self.provider,
                })
                .to_string()
            } else {
                self.raw.clone()
            }
        }
    }

    /// 技能名归一：`state.input.name` → `state.input.id` → `unknown`。
    ///
    /// 空字符串视为缺失（旧 SQL 用 `NULLIF(x, '')` 表达同一语义）。
    /// **不要**把 block 顶层 `id` 加进这条链：那是工具调用 id
    /// （`call_00_XtIMKHALCviKUh137huW1672` 这类），不是技能名。
    pub fn skill_name<'a>(name: Option<&'a str>, input_id: Option<&'a str>) -> Option<&'a str> {
        [name, input_id]
            .into_iter()
            .flatten()
            .find(|value| !value.is_empty())
    }

    /// 解析 `session_v2.model`。
    ///
    /// 空串返回 `None`（旧 SQL 用 `s.model IS NOT NULL` 过滤，空串会保留，
    /// 但真库没有空串；这里按「空即缺失」处理更安全）。
    pub fn model_key(raw: Option<&str>) -> Option<ModelKey> {
        let raw = raw?;
        if raw.is_empty() {
            return None;
        }
        let trimmed = raw.trim();
        if trimmed.starts_with('{') {
            if let Ok(parsed) = serde_json::from_str::<RawModel>(trimmed) {
                let id = parsed
                    .id
                    .filter(|value| !value.is_empty())
                    .or(parsed.model_id.filter(|value| !value.is_empty()))
                    .map(Cow::into_owned);
                return Some(ModelKey {
                    id,
                    provider: parsed.provider.map(Cow::into_owned),
                    raw: raw.to_string(),
                    structured: true,
                });
            }
        }
        Some(ModelKey {
            id: None,
            provider: None,
            raw: raw.to_string(),
            structured: false,
        })
    }
}

/// 一条消息的最小反序列化视图（借用 `data`，不复制）。
///
/// 只声明需要的字段：serde 会跳过其余字段（含 `content` 之外的大字段），
/// 但整个 `data` 只被解析这一次。
#[derive(Debug, Default, Deserialize)]
struct MsgData<'a> {
    #[serde(default)]
    tokens: Option<MsgTokens>,
    #[serde(default)]
    cost: Option<f64>,
    #[serde(default, borrow)]
    content: Option<Vec<MsgBlock<'a>>>,
}

#[derive(Debug, Default, Deserialize)]
struct MsgTokens {
    #[serde(default)]
    input: Option<f64>,
    #[serde(default)]
    output: Option<f64>,
    #[serde(default)]
    reasoning: Option<f64>,
    #[serde(default)]
    cache: Option<MsgCache>,
}

#[derive(Debug, Default, Deserialize)]
struct MsgCache {
    #[serde(default)]
    read: Option<f64>,
    #[serde(default)]
    write: Option<f64>,
}

#[derive(Debug, Default, Deserialize)]
struct MsgBlock<'a> {
    #[serde(default)]
    name: Option<Cow<'a, str>>,
    #[serde(default, rename = "type")]
    ty: Option<Cow<'a, str>>,
    #[serde(default, borrow)]
    state: Option<MsgBlockState<'a>>,
}

#[derive(Debug, Default, Deserialize)]
struct MsgBlockState<'a> {
    #[serde(default, borrow)]
    input: Option<MsgBlockInput<'a>>,
}

#[derive(Debug, Default, Deserialize)]
struct MsgBlockInput<'a> {
    #[serde(default)]
    name: Option<Cow<'a, str>>,
    #[serde(default)]
    id: Option<Cow<'a, str>>,
}

/// 模型分组聚合：同一 `(id, providerID)` 下第一次见到的输出串 + 合计。
#[derive(Debug, Default, Clone)]
pub struct ModelAccum {
    /// 输出给前端的模型字符串（组内恒定）。
    pub output: String,
    /// token 合计。
    pub tokens: f64,
    /// cost 合计。
    pub cost: f64,
}

/// 时间窗口投影：8 条统计命令共用的唯一一次扫描结果。
#[derive(Debug, Default)]
pub struct Projection {
    /// 窗口内消息总行数。
    pub rows: i64,
    /// 窗口内 assistant 行数。
    pub assistant_rows: i64,
    /// 按天聚合的 token 行（自带周 / 月键），顺序与 `scan_tokens` 一致。
    pub token_rows: Vec<TokenRow>,
    /// tool 名 → 次数。
    pub tools: BTreeMap<String, i64>,
    /// 技能名 → 次数。
    pub skills: BTreeMap<String, i64>,
    /// (model 分组键, 输出串) → 聚合。输出串在首次插入时确定（同组恒定）。
    pub models: BTreeMap<(String, String), ModelAccum>,
    /// providerID → (token 合计, cost 合计)。
    pub providers: BTreeMap<String, (f64, f64)>,
    /// 目录 → (token 合计, cost 合计)。
    pub projects: BTreeMap<String, (f64, f64)>,
    /// 日期 → 消息数（已排除 idle / model-switched / agent-switched）。
    pub messages_by_day: BTreeMap<String, i64>,
}

/// 拆出消息级 token 六元组：input, output, reasoning, cache_read, cache_write, cost。
fn msg_token_fields(data: &MsgData<'_>) -> (f64, f64, f64, f64, f64, f64) {
    let tokens = data.tokens.as_ref();
    let cache = tokens.and_then(|t| t.cache.as_ref());
    let get = |value: Option<f64>| value.unwrap_or(0.0);
    (
        get(tokens.and_then(|t| t.input)),
        get(tokens.and_then(|t| t.output)),
        get(tokens.and_then(|t| t.reasoning)),
        get(cache.and_then(|c| c.read)),
        get(cache.and_then(|c| c.write)),
        get(data.cost),
    )
}

fn token_total(data: &MsgData<'_>) -> f64 {
    let (input, output, reasoning, cache_read, cache_write, _cost) = msg_token_fields(data);
    input + output + reasoning + cache_read + cache_write
}

/// 单趟扫描 SQL：只取原始列（含 3 个 `strftime(localtime)`），不含任何 JSON 函数。
fn projection_sql(query: &mut Query, window: Window, hidden_json: &str) -> String {
    let mut sql = String::from(
        "SELECT sm.type,
                strftime('%Y-%m-%d', sm.time_created / 1000, 'unixepoch', 'localtime'),
                strftime('%Y-W%W', sm.time_created / 1000, 'unixepoch', 'localtime'),
                strftime('%Y-%m', sm.time_created / 1000, 'unixepoch', 'localtime'),
                sm.data,
                s.model,
                s.directory
         FROM main.session_message sm
         LEFT JOIN main.session_v2 s ON s.id = sm.session_id
         WHERE 1=1",
    );
    query.push_hidden(&mut sql, hidden_json);
    query.push_window(&mut sql, window);
    sql
}

/// 测试专用：`scan_projection` 实际执行次数，**按库路径**计数（缓存命中不增加）。
///
/// 按路径而不是全局计数：其它测试模块会用内存库直接调 `scan_projection`
/// （内存库没有 path），与缓存测试并行运行时不会污染这里的读数。
/// 测试专用扫描计数表：库规范化路径 → 实际扫描次数。
#[cfg(test)]
static SCAN_COUNTS: OnceLock<Mutex<std::collections::BTreeMap<String, u64>>> = OnceLock::new();

#[cfg(test)]
fn scan_counts() -> &'static Mutex<std::collections::BTreeMap<String, u64>> {
    SCAN_COUNTS.get_or_init(|| Mutex::new(std::collections::BTreeMap::new()))
}

/// 测试专用：`scan_projection` 实际执行次数，**按库路径**计数（缓存命中不增加）。
///
/// 按路径而不是全局计数：其它测试模块会用内存库直接调 `scan_projection`
/// （内存库没有 path），与缓存测试并行运行时不会污染这里的读数。
#[cfg(test)]
fn record_scan_for_tests(conn: &Connection) {
    let Some(path) = cache_path(conn) else {
        return;
    };
    let mut counts = scan_counts()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *counts.entry(path).or_insert(0) += 1;
}

/// 读取某库路径的扫描次数（测试断言用）。
#[cfg(test)]
fn projection_scan_count_for_tests(path: &str) -> u64 {
    scan_counts()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(path)
        .copied()
        .unwrap_or(0)
}

/// 清零某库路径的扫描次数（测试准备用）。
#[cfg(test)]
fn reset_projection_scan_count_for_tests(path: &str) {
    scan_counts()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(path);
}

/// 执行一次窗口投影扫描。
///
/// 只读，不使用 `session_v2` 的聚合列，不写 `kv`。单条坏 JSON 视为投影失败
/// （旧路径 `json_extract` 同样会整体报错），由调用方回退旧 SQL 并记录日志。
pub fn scan_projection(
    conn: &Connection,
    window: Window,
    hidden_json: &str,
) -> Result<Projection, String> {
    #[cfg(test)]
    record_scan_for_tests(conn);

    let mut query = Query::new();
    let sql = projection_sql(&mut query, window, hidden_json);

    let mut projection = Projection::default();
    let mut buckets: BTreeMap<(String, String, String), TokenRow> = BTreeMap::new();
    let mut parse_error: Option<String> = None;

    let mut stmt = conn.prepare(&sql).map_err(|e| query_error("投影", e))?;
    let mut rows = stmt
        .query(rusqlite::params_from_iter(query.params.iter()))
        .map_err(|e| query_error("投影", e))?;

    while let Some(row) = rows.next().map_err(|e| query_error("投影", e))? {
        projection.rows += 1;
        if projection.rows > PROJ_MAX_ROWS {
            return Err(format!(
                "窗口内消息数超过投影上限 {}，回退旧查询",
                PROJ_MAX_ROWS
            ));
        }

        let kind: String = row.get(0).map_err(|e| query_error("投影", e))?;
        let day: String = row.get(1).map_err(|e| query_error("投影", e))?;
        let week: String = row.get(2).map_err(|e| query_error("投影", e))?;
        let month: String = row.get(3).map_err(|e| query_error("投影", e))?;
        let data: String = row.get(4).map_err(|e| query_error("投影", e))?;
        let model_raw: Option<String> = row.get(5).map_err(|e| query_error("投影", e))?;
        let directory: Option<String> = row.get(6).map_err(|e| query_error("投影", e))?;

        // 消息趋势：与旧 SQL 一致，排除三类事件，其余类型全部计入。
        if !HIDDEN_MESSAGE_TYPES.contains(&kind.as_str()) {
            *projection.messages_by_day.entry(day.clone()).or_insert(0) += 1;
        }

        let parsed: MsgData<'_> = match serde_json::from_str(&data) {
            Ok(parsed) => parsed,
            Err(error) => {
                if parse_error.is_none() {
                    parse_error = Some(format!("{}（message JSON 无法解析：{}）", error, kind));
                }
                continue;
            }
        };

        let is_assistant = kind == "assistant";
        if is_assistant {
            projection.assistant_rows += 1;
            let (input, output, reasoning, cache_read, cache_write, cost) =
                msg_token_fields(&parsed);
            let bucket = buckets
                .entry((day.clone(), week.clone(), month.clone()))
                .or_insert_with(|| TokenRow {
                    day: day.clone(),
                    week: week.clone(),
                    month: month.clone(),
                    input: 0.0,
                    output: 0.0,
                    reasoning: 0.0,
                    cache_read: 0.0,
                    cache_write: 0.0,
                    cost: 0.0,
                });
            bucket.input += input;
            bucket.output += output;
            bucket.reasoning += reasoning;
            bucket.cache_read += cache_read;
            bucket.cache_write += cache_write;
            bucket.cost += cost;

            // 模型 / 供应商：旧 SQL 用 INNER JOIN + json_valid + providerID NOT NULL。
            if let Some(key) = shape::model_key(model_raw.as_deref()) {
                let tokens = token_total(&parsed);
                let (group_id, group_provider) = key.group_key();
                let entry = projection
                    .models
                    .entry((group_id, group_provider))
                    .or_insert_with(|| ModelAccum {
                        output: key.json(),
                        tokens: 0.0,
                        cost: 0.0,
                    });
                entry.tokens += tokens;
                entry.cost += cost;
                if let Some(provider) = key.provider.as_deref() {
                    let entry = projection
                        .providers
                        .entry(provider.to_string())
                        .or_insert((0.0, 0.0));
                    entry.0 += tokens;
                    entry.1 += cost;
                }
            }

            // 项目：旧 SQL 过滤 `directory IS NOT NULL AND directory != ''`。
            if let Some(directory) = directory.as_deref().filter(|value| !value.is_empty()) {
                let tokens = token_total(&parsed);
                let entry = projection
                    .projects
                    .entry(directory.to_string())
                    .or_insert((0.0, 0.0));
                entry.0 += tokens;
                entry.1 += cost;
            }
        }

        // 工具 / 技能：旧 SQL 不筛消息类型，所有消息的 content[] 都计入。
        if let Some(blocks) = parsed.content {
            for block in blocks {
                if block.ty.as_deref() != Some("tool") {
                    continue;
                }
                let tool = block.name.as_deref().unwrap_or("unknown");
                *projection.tools.entry(tool.to_string()).or_insert(0) += 1;
                if tool == "skill" {
                    let input = block.state.and_then(|state| state.input);
                    let name = shape::skill_name(
                        input.as_ref().and_then(|value| value.name.as_deref()),
                        input.as_ref().and_then(|value| value.id.as_deref()),
                    );
                    *projection
                        .skills
                        .entry(name.unwrap_or("unknown").to_string())
                        .or_insert(0) += 1;
                }
            }
        }
    }

    if let Some(error) = parse_error {
        return Err(error);
    }

    projection.token_rows = buckets.into_values().collect();
    Ok(projection)
}

// ─── 投影缓存 ────────────────────────────────────────────────────────────

/// 环境变量开关：默认启用，显式 `0` 时回退旧 SQL。
pub fn projection_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| match std::env::var("OPENCODE_W_STATS_PROJECTION") {
        Ok(value) => value.trim() != "0",
        Err(_) => true,
    })
}

/// 数据库文件的廉价版本戳：外部写入（含 WAL）后投影立即失效。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DbStamp {
    db_size: u64,
    db_mtime: u64,
    wal_size: u64,
    wal_mtime: u64,
}

fn file_stamp(path: &std::path::Path) -> (u64, u64) {
    match std::fs::metadata(path) {
        Ok(meta) => {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_nanos() as u64)
                .unwrap_or(0);
            (meta.len(), mtime)
        }
        Err(_) => (0, 0),
    }
}

fn db_stamp(conn: &Connection) -> Option<DbStamp> {
    let path = conn.path()?;
    let db = std::path::Path::new(path);
    let (db_size, db_mtime) = file_stamp(db);
    let (wal_size, wal_mtime) = file_stamp(&std::path::PathBuf::from(format!("{}-wal", path)));
    Some(DbStamp {
        db_size,
        db_mtime,
        wal_size,
        wal_mtime,
    })
}

fn hidden_hash(hidden_json: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    hidden_json.hash(&mut hasher);
    hasher.finish()
}

type ProjectionKey = (String, Window, u64, u64, u32);

/// 缓存条目：(创建时刻, 创建时的库文件戳, 投影)。
type ProjectionEntry = (Instant, Option<DbStamp>, Arc<Projection>);

struct ProjectionSlot {
    last_used: Mutex<Instant>,
    state: Mutex<Option<ProjectionEntry>>,
}

fn projection_cache() -> &'static Mutex<BTreeMap<ProjectionKey, Arc<ProjectionSlot>>> {
    static CACHE: OnceLock<Mutex<BTreeMap<ProjectionKey, Arc<ProjectionSlot>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(BTreeMap::new()))
}

/// 带缓存的投影：同一窗口的 8 条统计命令共用一次扫描。
///
/// - 键：规范化路径 + 窗口 + 缓存代次 + 隐藏集合哈希 + `PROJ_VERSION`；
/// - TTL 5 分钟，命中前比对数据库文件戳（外部写入立即失效）；
/// - 单飞：同键的后来者阻塞等待并复用结果；
/// - 条目 ≤2，按最近使用淘汰。
pub fn projection_cached(
    conn: &Connection,
    window: Window,
    hidden_json: &str,
) -> Result<Arc<Projection>, String> {
    let Some(path) = cache_path(conn) else {
        return Ok(Arc::new(scan_projection(conn, window, hidden_json)?));
    };
    let generation = fork_stats::cache_generation();
    let key = (
        path,
        window,
        generation,
        hidden_hash(hidden_json),
        PROJ_VERSION,
    );

    let slot = {
        let mut map = projection_cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        map.retain(|(_, _, gen, _, version), _| *gen == generation && *version == PROJ_VERSION);
        let slot = map
            .entry(key)
            .or_insert_with(|| {
                Arc::new(ProjectionSlot {
                    last_used: Mutex::new(Instant::now()),
                    state: Mutex::new(None),
                })
            })
            .clone();
        // 只保留最近使用的 N 个条目，避免切换窗口时无限增长。
        while map.len() > PROJ_CACHE_ENTRIES {
            let oldest = map
                .iter()
                .min_by_key(|(_, slot)| {
                    *slot
                        .last_used
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                })
                .map(|(key, _)| key.clone());
            match oldest {
                Some(oldest) => {
                    map.remove(&oldest);
                }
                None => break,
            }
        }
        slot
    };

    *slot
        .last_used
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Instant::now();

    let stamp = db_stamp(conn);
    let mut guard = slot
        .state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((created_at, cached_stamp, projection)) = guard.as_ref() {
        let age = created_at.elapsed();
        // 两条命中的理由，满足其一即可：
        // 1. 新鲜度窗口（≤5s）：仪表盘一次刷新会并发打来 8 条命令，全部复用；
        // 2. 库文件戳没变（≤5min）：OpenCode 空闲时投影可以长期复用。
        // 库在活跃写入时 `.db` / `-wal` 的 mtime 每秒都在变，只靠文件戳会退化成
        // 每次都重扫，因此必须有新鲜度窗口；窗口本身与 token 缓存一致（5s）。
        let fresh = age <= PROJECTION_CACHE_TTL;
        let unchanged =
            stamp.is_none() || cached_stamp.is_none() || *cached_stamp == stamp;
        if fresh || (unchanged && age <= PROJECTION_CACHE_MAX_AGE) {
            return Ok(Arc::clone(projection));
        }
    }

    let projection = Arc::new(scan_projection(conn, window, hidden_json)?);
    *guard = Some((Instant::now(), stamp, Arc::clone(&projection)));
    Ok(projection)
}

/// 活跃写入下的最大陈旧度：与 token 缓存保持一致（5s）。
const PROJECTION_CACHE_TTL: Duration = Duration::from_secs(5);

/// 库文件戳未变化时的复用上限：OpenCode 空闲时避免重复扫描大库。
const PROJECTION_CACHE_MAX_AGE: Duration = Duration::from_secs(300);

// ─── 投影派生（8 条命令） ────────────────────────────────────────────────

/// Token 总量：与 `aggregate(&scan_tokens(..))` 完全同代码。
pub fn derive_token_stats(projection: &Projection) -> TokenStats {
    aggregate(&projection.token_rows)
}

/// Token 分组：与 `grouped(&scan_tokens(..), group_by)` 完全同代码。
pub fn derive_token_groups(projection: &Projection, group_by: &str) -> Vec<TokenGroupDataPoint> {
    grouped(&projection.token_rows, group_by)
}

pub fn derive_tool_ranking(projection: &Projection) -> Vec<ToolRanking> {
    top_counts(projection.tools.clone(), 20, |tool_name, count| {
        ToolRanking { tool_name, count }
    })
}

pub fn derive_skill_usage(projection: &Projection) -> Vec<SkillUsage> {
    top_counts(projection.skills.clone(), 20, |skill_name, count| {
        SkillUsage { skill_name, count }
    })
}

pub fn derive_model_ranking(projection: &Projection) -> Vec<ModelRankingItem> {
    // BTreeMap 迭代顺序 = 旧 SQL 的分组键升序；稳定排序保证同分顺序一致。
    let mut items: Vec<(&ModelAccum, f64)> = projection
        .models
        .values()
        .map(|accum| (accum, accum.tokens))
        .collect();
    items.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    items.truncate(10);
    items
        .into_iter()
        .map(|(accum, tokens)| ModelRankingItem {
            model: accum.output.clone(),
            token_count: tokens as i64,
            total_cost: accum.cost,
        })
        .collect()
}

pub fn derive_provider_stats(projection: &Projection) -> Vec<ProviderStatsItem> {
    let mut items: Vec<(&String, f64, f64)> = projection
        .providers
        .iter()
        .map(|(provider, (tokens, cost))| (provider, *tokens, *cost))
        .collect();
    items.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    items
        .into_iter()
        .map(|(provider, tokens, cost)| ProviderStatsItem {
            provider: provider.clone(),
            token_count: tokens as i64,
            total_cost: cost,
        })
        .collect()
}

pub fn derive_project_ranking(projection: &Projection) -> Vec<ProjectRankingItem> {
    let mut items: Vec<(&String, f64, f64)> = projection
        .projects
        .iter()
        .map(|(directory, (tokens, cost))| (directory, *tokens, *cost))
        .collect();
    items.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    // 旧 SQL：先 LIMIT 10，再取目录末段（重名不去重）。
    items.truncate(10);
    items
        .into_iter()
        .map(|(directory, tokens, cost)| ProjectRankingItem {
            project: directory
                .rsplit('/')
                .next()
                .unwrap_or(directory)
                .to_string(),
            token_count: tokens as i64,
            total_cost: cost,
        })
        .collect()
}

pub fn derive_message_trend(projection: &Projection) -> Vec<MessageTrendItem> {
    projection
        .messages_by_day
        .iter()
        .map(|(date, count)| MessageTrendItem {
            date: date.clone(),
            value: *count as f64,
            label: None,
            count: *count,
        })
        .collect()
}

pub fn derive_cost_trend(projection: &Projection) -> Vec<CostTrendItem> {
    projection
        .token_rows
        .iter()
        .map(|row| CostTrendItem {
            date: row.day.clone(),
            value: row.cost,
            label: None,
            total_cost: row.cost,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{aggregate, grouped, TokenRow};

    fn row(day: &str, week: &str, month: &str, input: f64, cost: f64) -> TokenRow {
        TokenRow {
            day: day.to_string(),
            week: week.to_string(),
            month: month.to_string(),
            input,
            output: 10.0,
            reasoning: 1.0,
            cache_read: 100.0,
            cache_write: 2.0,
            cost,
        }
    }

    #[test]
    fn aggregate_sums_all_rows_and_uses_the_v1_hit_rate_formula() {
        let rows = vec![
            row("2026-10-01", "2026-W40", "2026-10", 1000.0, 0.5),
            row("2026-10-02", "2026-W40", "2026-10", 2000.0, 0.25),
        ];

        let stats = aggregate(&rows);

        assert_eq!(stats.input_tokens, 3000);
        assert_eq!(stats.output_tokens, 20);
        assert_eq!(stats.reasoning_tokens, 2);
        assert_eq!(stats.cache_read, 200);
        assert_eq!(stats.cache_write, 4);
        assert!((stats.estimated_cost - 0.75).abs() < 1e-9);
        // v1 公式：cache_read / (cache_read + input) * 100，再二次乘 100 后四舍五入
        // （注意 v1 这里确实是二次乘 100，v2 逐字保留，避免口径漂移）
        let expected = ((200.0f64 / 3200.0f64) * 100.0f64 * 100.0f64).round() / 100.0f64;
        assert!((stats.cache_hit_rate - expected).abs() < 1e-9);
    }

    #[test]
    fn grouped_rebuckets_daily_rows_into_week_and_month() {
        let rows = vec![
            row("2026-10-01", "2026-W40", "2026-10", 1000.0, 0.5),
            row("2026-10-02", "2026-W40", "2026-10", 2000.0, 0.25),
            row("2026-10-09", "2026-W41", "2026-10", 4000.0, 1.0),
        ];

        let daily = grouped(&rows, "day");
        assert_eq!(daily.len(), 3);
        assert_eq!(daily[0].period, "2026-10-01");
        assert_eq!(daily[0].input_tokens, 1000);

        let weekly = grouped(&rows, "week");
        assert_eq!(weekly.len(), 2);
        assert_eq!(weekly[0].period, "2026-W40");
        assert_eq!(weekly[0].input_tokens, 3000);
        assert!((weekly[0].estimated_cost - 0.75).abs() < 1e-9);
        assert_eq!(weekly[1].period, "2026-W41");
        assert_eq!(weekly[1].input_tokens, 4000);

        let monthly = grouped(&rows, "month");
        assert_eq!(monthly.len(), 1);
        assert_eq!(monthly[0].period, "2026-10");
        assert_eq!(monthly[0].input_tokens, 7000);
    }
}

/// 基于真实夹具（`test-data/v2-mixed.db` / `v2-fresh.db`）的集成测试。
///
/// 断言口径：
///
/// - token 合计 = 逐条 assistant 消息 JSON 求和（Rust 侧独立解析，不复用 SQL）；
/// - 工具排行的工具名与 `content[]` 里的 tool 块一致；
/// - 消息趋势不含 `idle` / `model-switched` / `agent-switched`；
/// - v2-fresh 上 8 个统计命令全部成功返回（不再是中文降级）。
#[cfg(test)]
mod fixture_tests {
    use super::{
        aggregate, cost_trend, message_trend, model_ranking, project_ranking, provider_stats,
        scan_tokens, scan_tokens_cached, skill_usage, tool_ranking,
    };
    use serde_json::Value;    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDb {
        dir: PathBuf,
        path: PathBuf,
    }

    impl TempDb {
        /// 复制夹具到临时目录（避免 WAL 写回仓库里的夹具文件）。
        fn copy_fixture(label: &str, file: &str, generate_with: &str) -> Option<Self> {
            let source = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../test-data")
                .join(file);
            if !source.is_file() {
                if std::env::var_os("CI").is_some() {
                    panic!(
                        "夹具缺失，检查 Generate test fixtures 步骤：缺少 test-data/{file}（本地可先执行 `{generate_with}`）"
                    );
                }
                eprintln!(
                    "[skip] 缺少夹具 {file}（已被 .gitignore 忽略）：先执行 `{generate_with}` 后重跑 cargo test"
                );
                return None;
            }
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time is after the Unix epoch")
                .as_nanos();
            let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!(
                "opencode-w-stats-{label}-{}-{nanos}-{counter}",
                std::process::id()
            ));
            std::fs::create_dir_all(&dir).expect("temp dir is created");
            let path = dir.join("fixture.db");
            std::fs::copy(&source, &path).expect("fixture is copied to temp dir");
            Some(TempDb { dir, path })
        }

        fn path_str(&self) -> &str {
            self.path.to_str().expect("temp path is UTF-8")
        }
    }

    impl Drop for TempDb {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// 打开夹具并返回连接（`db::open` 会建好 `session` 兼容视图）。
    fn open_fixture(
        label: &str,
        file: &str,
        generate_with: &str,
    ) -> Option<(crate::db::DbState, TempDb)> {
        let temp = TempDb::copy_fixture(label, file, generate_with)?;
        let state = crate::db::DbState::new();
        crate::db::open(&state, temp.path_str()).expect("fixture opens");
        Some((state, temp))
    }

    type PooledConn = r2d2::PooledConnection<r2d2_sqlite::SqliteConnectionManager>;

    fn pooled_conn(state: &crate::db::DbState) -> PooledConn {
        let pool = crate::db::get_pool(&state.0).expect("pool is available");
        pool.get().expect("pooled connection")
    }

    /// 逐条 assistant 消息解析 JSON 求和（独立于 SQL 的期望值）。
    fn expected_token_totals(conn: &PooledConn) -> (i64, i64, i64, i64, i64, f64) {
        let mut stmt = conn
            .prepare("SELECT data FROM session_message WHERE type = 'assistant' ORDER BY time_created, id")
            .expect("statement prepares");
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query runs");
        let (mut input, mut output, mut reasoning) = (0i64, 0i64, 0i64);
        let (mut cache_read, mut cache_write) = (0i64, 0i64);
        let mut cost = 0.0f64;
        for row in rows {
            let raw = row.expect("row is readable");
            let data: Value = serde_json::from_str(&raw).expect("data is valid JSON");
            let tokens = &data["tokens"];
            input += tokens["input"].as_i64().unwrap_or(0);
            output += tokens["output"].as_i64().unwrap_or(0);
            reasoning += tokens["reasoning"].as_i64().unwrap_or(0);
            cache_read += tokens["cache"]["read"].as_i64().unwrap_or(0);
            cache_write += tokens["cache"]["write"].as_i64().unwrap_or(0);
            cost += data["cost"].as_f64().unwrap_or(0.0);
        }
        (input, output, reasoning, cache_read, cache_write, cost)
    }

    #[test]
    fn v2_mixed_token_totals_match_the_per_message_json_sum() {
        // 开/关库会失效 fork_stats 缓存，与缓存测试串行执行。
        let _cache_guard = crate::commands::fork_stats::test_serial_guard();
        let Some((state, _temp)) =
            open_fixture("mixed", "v2-mixed.db", "npm run generate-fixture:v2")
        else {
            return;
        };
        let conn = pooled_conn(&state);

        let (input, output, reasoning, cache_read, cache_write, cost) =
            expected_token_totals(&conn);
        assert!(input > 0, "夹具里必须有 assistant 消息的 token 数据");

        let rows = scan_tokens(&conn, None, "[]").expect("token scan runs");
        let stats = aggregate(&rows);

        assert_eq!(stats.input_tokens, input);
        assert_eq!(stats.output_tokens, output);
        assert_eq!(stats.reasoning_tokens, reasoning);
        assert_eq!(stats.cache_read, cache_read);
        assert_eq!(stats.cache_write, cache_write);
        assert!(
            (stats.estimated_cost - cost).abs() < 1e-9,
            "cost 合计应与逐条求和一致：{} vs {}",
            stats.estimated_cost,
            cost
        );

        crate::db::close(&state).expect("state closes");
    }

    #[test]
    fn v2_mixed_tool_ranking_matches_the_content_tool_blocks() {
        let _cache_guard = crate::commands::fork_stats::test_serial_guard();
        let Some((state, _temp)) =
            open_fixture("mixed", "v2-mixed.db", "npm run generate-fixture:v2")
        else {
            return;
        };
        let conn = pooled_conn(&state);

        // 期望值：逐条消息解析 content[] 里的 tool 块。
        let mut expected: BTreeMap<String, i64> = BTreeMap::new();
        let mut stmt = conn
            .prepare("SELECT data FROM session_message ORDER BY time_created, id")
            .expect("statement prepares");
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query runs");
        for row in rows {
            let raw = row.expect("row is readable");
            let data: Value = serde_json::from_str(&raw).expect("data is valid JSON");
            let Some(blocks) = data["content"].as_array() else {
                continue;
            };
            for block in blocks {
                if block["type"].as_str() != Some("tool") {
                    continue;
                }
                let name = block["name"].as_str().unwrap_or("unknown").to_string();
                *expected.entry(name).or_insert(0) += 1;
            }
        }
        assert!(!expected.is_empty(), "夹具里必须有 tool 块");

        let ranking = tool_ranking(&conn, None, "[]").expect("tool ranking runs");
        let actual: BTreeMap<String, i64> = ranking
            .iter()
            .map(|item| (item.tool_name.clone(), item.count))
            .collect();
        assert_eq!(actual, expected, "工具名与 content 里的 tool 块必须一致");

        crate::db::close(&state).expect("state closes");
    }

    #[test]
    fn v2_mixed_message_trend_excludes_event_messages() {
        let _cache_guard = crate::commands::fork_stats::test_serial_guard();
        let Some((state, _temp)) =
            open_fixture("mixed", "v2-mixed.db", "npm run generate-fixture:v2")
        else {
            return;
        };
        let conn = pooled_conn(&state);

        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM session_message", [], |row| row.get(0))
            .expect("count runs");
        let excluded: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM session_message WHERE type IN ('idle','model-switched','agent-switched')",
                [],
                |row| row.get(0),
            )
            .expect("count runs");
        assert!(excluded > 0, "夹具里必须有 idle / 切换事件消息");

        let trend = message_trend(&conn, None, "[]").expect("message trend runs");
        let counted: i64 = trend.iter().map(|item| item.count).sum();
        assert_eq!(
            counted,
            total - excluded,
            "消息趋势必须排除 idle / model-switched / agent-switched"
        );

        crate::db::close(&state).expect("state closes");
    }

    #[test]
    fn v2_fresh_all_stats_queries_succeed() {
        let _cache_guard = crate::commands::fork_stats::test_serial_guard();
        let Some((state, _temp)) =
            open_fixture("fresh", "v2-fresh.db", "npm run generate-fixture:v2")
        else {
            return;
        };
        let conn = pooled_conn(&state);

        // 8 个曾在 v2 下返回中文降级错误的统计命令。
        let rows = scan_tokens(&conn, None, "[]").expect("token scan runs");
        assert!(!rows.is_empty());
        assert!(aggregate(&rows).input_tokens > 0);
        assert!(!tool_ranking(&conn, None, "[]").expect("tool ranking runs").is_empty());
        // 夹具里没有 `skill` 工具调用：应返回空列表而不是报错。
        assert!(
            skill_usage(&conn, None, "[]")
                .expect("skill usage runs")
                .is_empty(),
            "夹具没有 skill 调用时应返回空列表"
        );
        assert!(!model_ranking(&conn, None, "[]").expect("model ranking runs").is_empty());
        // 夹具的 `session_v2.model` 是纯字符串（与 v1 夹具同风格），没有
        // `providerID`：此时应「跳过而不是报错」，返回空列表。
        assert!(
            provider_stats(&conn, None, "[]").expect("provider stats runs").is_empty(),
            "模型字段不是 JSON 时应跳过而不是报错"
        );
        assert!(!project_ranking(&conn, None, "[]").expect("project ranking runs").is_empty());
        assert!(!cost_trend(&conn, None, "[]").expect("cost trend runs").is_empty());
        assert!(!message_trend(&conn, None, "[]").expect("message trend runs").is_empty());

        // 会话趋势走 `session` 兼容视图（v1 / v2 共用同一段 SQL）。
        let session_trend: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM (SELECT date(time_created / 1000, 'unixepoch', 'localtime') AS d FROM session GROUP BY d)",
                [],
                |row| row.get(0),
            )
            .expect("session trend runs");
        assert!(session_trend > 0);

        crate::db::close(&state).expect("state closes");
    }

    #[test]
    fn v2_provider_stats_reads_provider_id_from_json_models() {
        let _cache_guard = crate::commands::fork_stats::test_serial_guard();
        let Some((state, _temp)) =
            open_fixture("fresh", "v2-fresh.db", "npm run generate-fixture:v2")
        else {
            return;
        };
        let conn = pooled_conn(&state);

        // 真实 v2 库的 `session_v2.model` 是 JSON 对象（夹具里是纯字符串）。
        conn.execute(
            "UPDATE session_v2 SET model = '{\"id\":\"gpt-5.6-terra\",\"providerID\":\"opencode\",\"variant\":\"default\"}'",
            [],
        )
        .expect("model updates");

        let stats = provider_stats(&conn, None, "[]").expect("provider stats runs");
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[0].provider, "opencode");
        assert!(stats[0].token_count > 0);

        crate::db::close(&state).expect("state closes");
    }

    #[test]
    fn v2_time_window_is_pushed_down_to_message_time_created() {
        let _cache_guard = crate::commands::fork_stats::test_serial_guard();
        let Some((state, _temp)) =
            open_fixture("fresh", "v2-fresh.db", "npm run generate-fixture:v2")
        else {
            return;
        };
        let conn = pooled_conn(&state);

        let all = scan_tokens(&conn, None, "[]").expect("token scan runs");
        let empty = scan_tokens(&conn, Some((0, 1)), "[]").expect("token scan runs");
        assert!(!all.is_empty());
        assert!(
            empty.is_empty(),
            "窗口下推到 session_message.time_created 后应为空"
        );

        crate::db::close(&state).expect("state closes");
    }

    fn in_memory_conn(schema: &str) -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().expect("in-memory db opens");
        conn.execute_batch(schema).expect("schema creates");
        conn
    }

    /// 技能排行必须同时兼容 `state.input.name` 与新版 `state.input.id`。
    #[test]
    fn v2_skill_usage_accepts_name_and_id_inputs() {
        let conn = in_memory_conn(
            "CREATE TABLE session_message (
                 id TEXT PRIMARY KEY,
                 type TEXT NOT NULL,
                 time_created INTEGER NOT NULL,
                 data TEXT NOT NULL
             );",
        );

        let messages = [
            (
                "msg_skill_name",
                r#"{"content":[{"type":"tool","name":"skill","state":{"status":"completed","input":{"name":"brainstorming"}}}]}"#,
            ),
            (
                "msg_skill_id",
                r#"{"content":[{"type":"tool","name":"skill","state":{"status":"completed","input":{"id":"huashu-nuwa"}}}]}"#,
            ),
            (
                "msg_skill_empty_name",
                r#"{"content":[{"type":"tool","name":"skill","state":{"status":"completed","input":{"name":"","id":"pdf"}}}]}"#,
            ),
        ];
        for (id, data) in messages {
            conn.execute(
                "INSERT INTO session_message (id, type, time_created, data)
                 VALUES (?1, 'assistant', 1, ?2)",
                rusqlite::params![id, data],
            )
            .expect("message inserts");
        }

        let ranking = skill_usage(&conn, None, "[]").expect("skill usage runs");
        let counts: BTreeMap<&str, i64> = ranking
            .iter()
            .map(|item| (item.skill_name.as_str(), item.count))
            .collect();
        assert_eq!(counts.get("brainstorming"), Some(&1));
        assert_eq!(counts.get("huashu-nuwa"), Some(&1), "缺 name 时必须退回 id");
        assert_eq!(counts.get("pdf"), Some(&1), "空 name 必须退回 id");
        assert!(!counts.contains_key("unknown"));
    }

    /// 同一 model id 的不同 variant 必须合并为一行，且 `model` 仍可 JSON 解析。
    #[test]
    fn v2_model_ranking_merges_variants_by_id_and_provider() {
        let conn = in_memory_conn(
            "CREATE TABLE session_v2 (id TEXT PRIMARY KEY, model TEXT);
             CREATE TABLE session_message (
                 id TEXT PRIMARY KEY,
                 session_id TEXT NOT NULL,
                 type TEXT NOT NULL,
                 time_created INTEGER NOT NULL,
                 data TEXT NOT NULL
             );",
        );

        let sessions = [
            (
                "ses_gpt_default",
                r#"{"id":"gpt-5.6-terra","providerID":"opencode","variant":"default"}"#,
            ),
            (
                "ses_gpt_high",
                r#"{"id":"gpt-5.6-terra","providerID":"opencode","variant":"high"}"#,
            ),
            (
                "ses_deepseek",
                r#"{"id":"deepseek-v4.1-flash-free","providerID":"opencode","variant":"high"}"#,
            ),
            ("ses_plain", "claude-sonnet-4-6"),
        ];
        for (id, model) in sessions {
            conn.execute(
                "INSERT INTO session_v2 (id, model) VALUES (?1, ?2)",
                rusqlite::params![id, model],
            )
            .expect("session inserts");
        }

        let messages = [
            ("msg_1", "ses_gpt_default", 100, "0.1"),
            ("msg_2", "ses_gpt_high", 200, "0.2"),
            ("msg_3", "ses_deepseek", 50, "0.3"),
            ("msg_4", "ses_plain", 10, "0.4"),
        ];
        for (id, session_id, input, cost) in messages {
            let data = format!(r#"{{"tokens":{{"input":{input}}},"cost":{cost}}}"#);
            conn.execute(
                "INSERT INTO session_message (id, session_id, type, time_created, data)
                 VALUES (?1, ?2, 'assistant', 1, ?3)",
                rusqlite::params![id, session_id, data],
            )
            .expect("message inserts");
        }

        let ranking = model_ranking(&conn, None, "[]").expect("model ranking runs");
        assert_eq!(ranking.len(), 3, "同 id 不同 variant 必须合并为一行");

        let gpt = ranking
            .iter()
            .find(|item| item.model.contains("gpt-5.6-terra"))
            .expect("gpt row exists");
        assert_eq!(gpt.token_count, 300);
        assert!((gpt.total_cost - 0.3).abs() < 1e-9);
        let parsed: Value = serde_json::from_str(&gpt.model).expect("model is valid JSON");
        assert_eq!(parsed["id"], "gpt-5.6-terra");
        assert_eq!(parsed["providerID"], "opencode");

        let plain = ranking
            .iter()
            .find(|item| item.model == "claude-sonnet-4-6")
            .expect("non-JSON model keeps raw string");
        assert_eq!(plain.token_count, 10);
    }

    /// 缓存键必须区分 hidden 集：同一窗口下不同隐藏集合各算各的。
    #[test]
    fn v2_token_cache_separates_hidden_sets() {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time is after the Unix epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "opencode-w-token-cache-{}-{}-{}",
            std::process::id(),
            nanos,
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).expect("temp dir is created");
        let path = dir.join("cache.db");

        {
            let conn = rusqlite::Connection::open(&path).expect("cache db opens");
            conn.execute_batch(
                "CREATE TABLE session_message (
                     id TEXT PRIMARY KEY,
                     type TEXT NOT NULL,
                     time_created INTEGER NOT NULL,
                     data TEXT NOT NULL
                 );",
            )
            .expect("schema creates");
            for (id, input) in [("msg_keep", 100), ("msg_hidden", 50)] {
                let data = format!(r#"{{"tokens":{{"input":{input}}}}}"#);
                conn.execute(
                    "INSERT INTO session_message (id, type, time_created, data)
                     VALUES (?1, 'assistant', 1700000000000, ?2)",
                    rusqlite::params![id, data],
                )
                .expect("message inserts");
            }

            let all = scan_tokens_cached(&conn, None, "[]").expect("scan runs");
            assert_eq!(aggregate(&all).input_tokens, 150);

            let hidden =
                scan_tokens_cached(&conn, None, "[\"msg_hidden\"]").expect("scan runs");
            assert_eq!(
                aggregate(&hidden).input_tokens,
                100,
                "隐藏集合必须影响扫描结果"
            );

            let all_again = scan_tokens_cached(&conn, None, "[]").expect("scan runs");
            assert_eq!(
                aggregate(&all_again).input_tokens,
                150,
                "不同 hidden 集不能污染同一窗口的缓存"
            );
        }

        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// T2 投影测试：同一份数据上，投影派生结果必须与旧 SQL 逐项一致。
#[cfg(test)]
mod projection_tests {
    use super::{
        aggregate, cost_trend, grouped, message_trend, model_ranking, project_ranking,
        projection_enabled, provider_stats, scan_projection, scan_tokens, shape, skill_usage,
        tool_ranking, Projection,
    };
    use rusqlite::Connection;

    const TS1: i64 = 1_789_000_000_000; // 2026-09-09 前后
    const TS2: i64 = 1_789_086_400_000; // +1 天
    const TS3: i64 = 1_789_172_800_000; // +2 天
    const WINDOW: Option<(i64, i64)> = Some((TS1, TS3));

    fn db() -> Connection {
        let conn = Connection::open_in_memory().expect("内存库");
        conn.execute_batch(
            "CREATE TABLE main.session_v2 (id TEXT PRIMARY KEY, model TEXT, directory TEXT);
             CREATE TABLE main.session_message (
                 id TEXT PRIMARY KEY,
                 session_id TEXT,
                 type TEXT,
                 time_created INTEGER,
                 data TEXT
             );",
        )
        .expect("建表");
        conn
    }

    fn session(conn: &Connection, id: &str, model: Option<&str>, directory: Option<&str>) {
        conn.execute(
            "INSERT INTO main.session_v2 (id, model, directory) VALUES (?1, ?2, ?3)",
            rusqlite::params![id, model, directory],
        )
        .expect("插入会话");
    }

    fn message(conn: &Connection, id: &str, session: &str, kind: &str, ts: i64, data: &str) {
        conn.execute(
            "INSERT INTO main.session_message (id, session_id, type, time_created, data)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![id, session, kind, ts, data],
        )
        .expect("插入消息");
    }

    /// 覆盖：token 五段 + cost、两种 skill 形状、非 assistant 的工具块、
    /// 被排除的事件、同模型不同 variant、非 JSON 模型、缺 providerID、
    /// 空目录 / NULL 目录。
    fn fixture() -> Connection {
        let conn = db();
        session(
            &conn,
            "s1",
            Some(r#"{"id":"claude-sonnet-4","providerID":"anthropic","variant":"high"}"#),
            Some("/repo/alpha"),
        );
        session(
            &conn,
            "s2",
            Some(r#"{"id":"claude-sonnet-4","providerID":"anthropic","variant":"low"}"#),
            Some("/repo/beta"),
        );
        session(&conn, "s3", Some("gpt-4o"), Some(""));
        session(&conn, "s4", Some(r#"{"id":"gemini"}"#), None);

        message(
            &conn,
            "m1",
            "s1",
            "assistant",
            TS1,
            r#"{"tokens":{"input":100,"output":20,"reasoning":5,"cache":{"read":7,"write":3}},"cost":0.5,
                "content":[{"type":"tool","name":"read"},{"type":"text","text":"done"}]}"#,
        );
        message(
            &conn,
            "m2",
            "s2",
            "assistant",
            TS1,
            r#"{"tokens":{"input":50,"output":10},"cost":0.25,
                "content":[{"type":"tool","name":"skill","state":{"input":{"name":"brainstorming"}}}]}"#,
        );
        message(
            &conn,
            "m3",
            "s1",
            "assistant",
            TS2,
            r#"{"cost":0.125,
                "content":[{"type":"tool","name":"skill","state":{"input":{"id":"tdd"}}},
                           {"type":"tool","name":"bash"}]}"#,
        );
        message(
            &conn,
            "m4",
            "s2",
            "user",
            TS2,
            r#"{"content":[{"type":"tool","name":"bash"},{"type":"text","text":"hi"}]}"#,
        );
        message(&conn, "m5", "s3", "idle", TS2, r#"{}"#);
        message(&conn, "m6", "s3", "model-switched", TS3, r#"{}"#);
        message(
            &conn,
            "m7",
            "s3",
            "assistant",
            TS3,
            r#"{"tokens":{"input":8},"cost":0.01,"content":[]}"#,
        );
        message(
            &conn,
            "m8",
            "s4",
            "assistant",
            TS3,
            r#"{"tokens":{"input":4,"cache":{"write":6}},"cost":0.02}"#,
        );
        // 无 content / tokens 缺失的 assistant：两个实现都必须容错。
        message(&conn, "m9", "s4", "assistant", TS3, r#"{"cost":0.03}"#);
        // 技能块只有工具调用 id（block 顶层 `id`）+ 空 input：必须记 unknown，
        // 不能把 `call_x` 当成技能名。
        message(
            &conn,
            "m10",
            "s2",
            "user",
            TS2,
            r#"{"content":[{"type":"tool","id":"call_x","name":"skill",
                            "state":{"status":"completed","input":{}}}]}"#,
        );
        conn
    }

    fn debug<T: std::fmt::Debug>(value: &T) -> String {
        format!("{:?}", value)
    }

    /// cost 是 f64：SQL 逐行求和、投影逐条累加，最后一位可能不同。
    /// 规格允许 1e-9 相对误差，这里按相对误差比较。
    fn close(left: f64, right: f64) -> bool {
        let scale = left.abs().max(right.abs()).max(1.0);
        (left - right).abs() <= 1e-9 * scale
    }

    fn assert_tokens_eq(old: &super::TokenStats, new: &super::TokenStats, context: &str) {
        assert_eq!(old.input_tokens, new.input_tokens, "{context} input");
        assert_eq!(old.output_tokens, new.output_tokens, "{context} output");
        assert_eq!(old.reasoning_tokens, new.reasoning_tokens, "{context} reasoning");
        assert_eq!(old.cache_read, new.cache_read, "{context} cache_read");
        assert_eq!(old.cache_write, new.cache_write, "{context} cache_write");
        assert!(
            close(old.estimated_cost, new.estimated_cost),
            "{context} cost {} vs {}",
            old.estimated_cost,
            new.estimated_cost
        );
        assert!(
            close(old.cache_hit_rate, new.cache_hit_rate),
            "{context} cache_hit_rate {} vs {}",
            old.cache_hit_rate,
            new.cache_hit_rate
        );
    }

    fn assert_groups_eq(
        old: &[super::TokenGroupDataPoint],
        new: &[super::TokenGroupDataPoint],
        context: &str,
    ) {
        assert_eq!(old.len(), new.len(), "{context} 组数");
        for (old, new) in old.iter().zip(new.iter()) {
            assert_eq!(old.period, new.period, "{context} period");
            assert_eq!(old.input_tokens, new.input_tokens, "{context} input");
            assert_eq!(old.output_tokens, new.output_tokens, "{context} output");
            assert_eq!(old.reasoning_tokens, new.reasoning_tokens, "{context} reasoning");
            assert_eq!(old.cache_read, new.cache_read, "{context} cache_read");
            assert_eq!(old.cache_write, new.cache_write, "{context} cache_write");
            assert!(
                close(old.estimated_cost, new.estimated_cost),
                "{context} cost {} vs {}",
                old.estimated_cost,
                new.estimated_cost
            );
        }
    }

    fn assert_ranked_eq<T>(
        old: &[T],
        new: &[T],
        context: &str,
        key: impl Fn(&T) -> (String, i64, f64),
    ) {
        assert_eq!(old.len(), new.len(), "{context} 条数");
        for (old, new) in old.iter().zip(new.iter()) {
            let (old_key, old_tokens, old_cost) = key(old);
            let (new_key, new_tokens, new_cost) = key(new);
            assert_eq!(old_key, new_key, "{context} 名称");
            assert_eq!(old_tokens, new_tokens, "{context} token 数");
            assert!(
                close(old_cost, new_cost),
                "{context} cost {old_cost} vs {new_cost}"
            );
        }
    }

    fn assert_cost_trend_eq(
        old: &[super::CostTrendItem],
        new: &[super::CostTrendItem],
        context: &str,
    ) {
        assert_eq!(old.len(), new.len(), "{context} 天数");
        for (old, new) in old.iter().zip(new.iter()) {
            assert_eq!(old.date, new.date, "{context} 日期");
            assert!(
                close(old.total_cost, new.total_cost),
                "{context} cost {} vs {}",
                old.total_cost,
                new.total_cost
            );
            assert!(close(old.value, new.value), "{context} value");
        }
    }

    #[test]
    fn projection_matches_legacy_queries() {
        let conn = fixture();
        let hidden = "[]";
        let rows = scan_tokens(&conn, WINDOW, hidden).expect("旧 token 扫描");
        let projection = scan_projection(&conn, WINDOW, hidden).expect("投影");

        assert_eq!(projection.rows, 10);
        assert_eq!(projection.assistant_rows, 6);
        assert_tokens_eq(
            &aggregate(&rows),
            &super::derive_token_stats(&projection),
            "token 总量",
        );
        for group in ["day", "week", "month"] {
            assert_groups_eq(
                &grouped(&rows, group),
                &super::derive_token_groups(&projection, group),
                &format!("token 分组 {group}"),
            );
        }
        assert_eq!(
            debug(&tool_ranking(&conn, WINDOW, hidden).expect("旧工具")),
            debug(&super::derive_tool_ranking(&projection)),
            "工具排行"
        );
        assert_eq!(
            debug(&skill_usage(&conn, WINDOW, hidden).expect("旧技能")),
            debug(&super::derive_skill_usage(&projection)),
            "技能排行"
        );
        assert_ranked_eq(
            &model_ranking(&conn, WINDOW, hidden).expect("旧模型"),
            &super::derive_model_ranking(&projection),
            "模型排行",
            |item| (item.model.clone(), item.token_count, item.total_cost),
        );
        assert_ranked_eq(
            &provider_stats(&conn, WINDOW, hidden).expect("旧供应商"),
            &super::derive_provider_stats(&projection),
            "供应商统计",
            |item| (item.provider.clone(), item.token_count, item.total_cost),
        );
        assert_ranked_eq(
            &project_ranking(&conn, WINDOW, hidden).expect("旧项目"),
            &super::derive_project_ranking(&projection),
            "项目排行",
            |item| (item.project.clone(), item.token_count, item.total_cost),
        );
        assert_eq!(
            debug(&message_trend(&conn, WINDOW, hidden).expect("旧趋势")),
            debug(&super::derive_message_trend(&projection)),
            "消息趋势"
        );
        assert_cost_trend_eq(
            &cost_trend(&conn, WINDOW, hidden).expect("旧成本"),
            &super::derive_cost_trend(&projection),
            "成本趋势",
        );
    }

    #[test]
    fn projection_respects_hidden_ids() {
        let conn = fixture();
        // m1 是 assistant 且带 token / 工具块：隐藏后必须从新旧两边同时消失。
        let hidden = r#"["m1"]"#;
        let rows = scan_tokens(&conn, WINDOW, hidden).expect("旧 token 扫描");
        let projection = scan_projection(&conn, WINDOW, hidden).expect("投影");

        assert_eq!(projection.rows, 9);
        assert_tokens_eq(
            &aggregate(&rows),
            &super::derive_token_stats(&projection),
            "隐藏后 token 总量",
        );
        assert_eq!(
            debug(&tool_ranking(&conn, WINDOW, hidden).expect("旧工具")),
            debug(&super::derive_tool_ranking(&projection))
        );
        assert_eq!(
            debug(&message_trend(&conn, WINDOW, hidden).expect("旧趋势")),
            debug(&super::derive_message_trend(&projection))
        );
    }

    #[test]
    fn projection_skill_uses_unknown_when_only_a_call_id_exists() {
        let conn = db();
        session(&conn, "s1", Some("gpt-4o"), Some("/repo/alpha"));
        // 真实形态：block 顶层 `id` 是工具调用 id，`state.input` 为空对象。
        message(
            &conn,
            "m1",
            "s1",
            "assistant",
            TS1,
            r#"{"content":[{"type":"tool","id":"call_00_XtIMKHALCviKUh137huW1672","name":"skill",
                            "state":{"status":"completed","input":{}}}]}"#,
        );

        let old = skill_usage(&conn, WINDOW, "[]").expect("旧技能");
        assert_eq!(old.len(), 1);
        assert_eq!(old[0].skill_name, "unknown");

        let projection = scan_projection(&conn, WINDOW, "[]").expect("投影");
        let new = super::derive_skill_usage(&projection);
        assert_eq!(new.len(), 1);
        assert_eq!(new[0].skill_name, "unknown", "工具调用 id 不是技能名");
    }

    #[test]
    fn projection_skill_counts_call_id_blocks_as_unknown() {
        let projection = scan_projection(&fixture(), WINDOW, "[]").expect("投影");
        assert_eq!(projection.skills.get("unknown"), Some(&1));
        assert!(
            !projection.skills.keys().any(|name| name.starts_with("call_")),
            "技能排行不应出现工具调用 id：{:?}",
            projection.skills
        );
    }

    /// 回归护栏：投影 SQL 里一旦出现 JSON 函数，就退回了被否决的形态
    /// （`json_extract` 每次调用都重新解析整条 JSON，实测 19s+）。
    #[test]
    fn projection_sql_contains_no_json_functions() {
        let mut query = super::Query::new();
        let sql = super::projection_sql(&mut query, Some((1, 2)), "[]");
        let lowered = sql.to_lowercase();
        assert!(!lowered.contains("json"), "投影 SQL 不得包含 JSON 函数：{sql}");
        assert!(sql.contains("sm.data"), "data 必须原样取出：{sql}");
        assert!(sql.contains("s.model") && sql.contains("s.directory"), "{sql}");
        assert_eq!(sql.matches("strftime").count(), 3, "日期键仍由 SQL 计算：{sql}");

        // 唯一的例外是分叉隐藏集合：json_each 只解析「被隐藏的消息 id 数组」
        // （几十个元素），与逐条解析 4.5GB 的 data 是两回事。
        let mut hidden_query = super::Query::new();
        let sql = super::projection_sql(&mut hidden_query, Some((1, 2)), "[\"hidden\"]");
        assert_eq!(sql.matches("json_").count(), 1, "{sql}");
        assert!(sql.contains("json_each(?3)") || sql.contains("json_each(?"), "{sql}");
    }

    #[test]
    fn projection_rejects_broken_json() {
        let conn = db();
        session(&conn, "s1", Some("gpt-4o"), Some("/repo/alpha"));
        message(&conn, "m1", "s1", "assistant", TS1, "{not json");

        assert!(scan_projection(&conn, WINDOW, "[]").is_err());
    }

    #[test]
    fn projection_reports_its_size() {
        let projection = scan_projection(&fixture(), WINDOW, "[]").expect("投影");
        assert_eq!(projection.token_rows.len(), 3, "三个自然日各一行");
        assert_eq!(projection.projects.len(), 2, "空目录与 NULL 目录都被过滤");
    }

    #[test]
    fn shape_skill_name_prefers_name() {
        assert_eq!(
            shape::skill_name(Some("brainstorming"), Some("tdd")),
            Some("brainstorming")
        );
        assert_eq!(shape::skill_name(Some(""), Some("tdd")), Some("tdd"));
        assert_eq!(shape::skill_name(None, None), None);
        assert_eq!(shape::skill_name(None, Some("")), None);
    }

    #[test]
    fn shape_model_key_matches_legacy_output() {
        let structured = shape::model_key(Some(
            r#"{"id":"claude-sonnet-4","providerID":"anthropic","variant":"high"}"#,
        ))
        .expect("结构化模型");
        assert_eq!(
            structured.group_key(),
            ("claude-sonnet-4".to_string(), "anthropic".to_string())
        );
        assert_eq!(
            structured.json(),
            r#"{"id":"claude-sonnet-4","providerID":"anthropic"}"#
        );

        let raw = shape::model_key(Some("gpt-4o")).expect("非 JSON 模型");
        assert_eq!(raw.group_key(), ("gpt-4o".to_string(), String::new()));
        assert_eq!(raw.json(), "gpt-4o");

        let no_provider = shape::model_key(Some(r#"{"id":"gemini"}"#)).expect("缺 providerID");
        assert_eq!(
            no_provider.group_key(),
            ("gemini".to_string(), String::new())
        );
        assert_eq!(no_provider.json(), r#"{"id":"gemini","providerID":null}"#);

        assert!(shape::model_key(Some("")).is_none());
        assert!(shape::model_key(None).is_none());
    }

    #[test]
    fn projection_is_enabled_by_default() {
        // 未设置环境变量时必须默认启用（CI / 用户机器上都如此）。
        if std::env::var("OPENCODE_W_STATS_PROJECTION").is_err() {
            assert!(projection_enabled());
        }
    }

    /// 只读打开 `OPENCODE_W_TEST_DB` 指向的真实库（golden / bench 共用）。
    fn open_real_db() -> rusqlite::Connection {
        let path = std::env::var("OPENCODE_W_TEST_DB")
            .expect("需要 OPENCODE_W_TEST_DB 指向真实 opencode.db");
        rusqlite::Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
        )
        .expect("只读打开真实库")
    }

    /// 真库 golden：7 / 30 / 90 天窗口上，投影派生必须与旧 SQL 完全一致。
    ///
    /// ```sh
    /// OPENCODE_W_TEST_DB=~/.local/share/opencode/opencode.db \
    ///   cargo test --release projection_golden_real_db -- --ignored --nocapture
    /// ```
    ///
    /// 8 条命令必须与旧 SQL 完全一致（diff = 0）。技能名回退链只到
    /// `state.input.id`；block 顶层 `id` 是工具调用 id（`call_...`），不参与。
    /// 生产投影路径的冷 / 热 / 缓存命中耗时（90 天窗口）。
    ///
    /// ```sh
    /// OPENCODE_W_TEST_DB=~/.local/share/opencode/opencode.db \
    ///   cargo test --release projection_bench_cold_warm -- --ignored --nocapture
    /// ```
    ///
    /// macOS 无 root 无法清 page cache，因此「首跑」是相对冷（进程内第一次、
    /// 库刚被其他读取扰动过），「次跑」是热。验收以这两个值为准，不因更快放宽。
    #[test]
    #[ignore = "需要 OPENCODE_W_TEST_DB 指向真实库；性能基准手动运行"]
    fn projection_bench_cold_warm() {
        use std::time::Instant;

        let conn = open_real_db();
        let window = Some((1_784_822_400_000_i64, 1_792_598_399_999_i64));

        let t0 = Instant::now();
        let first = super::scan_projection(&conn, window, "[]").expect("首跑投影");
        let cold_ms = t0.elapsed().as_secs_f64() * 1000.0;

        let t0 = Instant::now();
        let second = super::scan_projection(&conn, window, "[]").expect("热跑投影");
        let hot_ms = t0.elapsed().as_secs_f64() * 1000.0;

        // 第一次调用填缓存，第二次才是命中。
        let t0 = Instant::now();
        let _ = super::projection_cached(&conn, window, "[]").expect("填充缓存");
        let fill_ms = t0.elapsed().as_secs_f64() * 1000.0;
        let t0 = Instant::now();
        let _ = super::projection_cached(&conn, window, "[]").expect("缓存命中");
        let hit_ms = t0.elapsed().as_secs_f64() * 1000.0;

        println!(
            "\n90d rows={} cold={cold_ms:.0}ms hot={hot_ms:.0}ms cache_fill={fill_ms:.0}ms cache_hit={hit_ms:.2}ms",
            first.rows
        );
        assert_eq!(first.rows, second.rows);
        assert_eq!(first.tools, second.tools);
        assert_eq!(first.skills, second.skills);
        assert_eq!(first.models.len(), second.models.len());
        assert!(hit_ms < 50.0, "缓存命中应 <50ms，实测 {hit_ms:.2}ms");
    }

    #[test]
    #[ignore = "需要 OPENCODE_W_TEST_DB 指向真实库；golden 手动运行"]
    fn projection_golden_real_db() {
        use std::time::Instant;

        let conn = open_real_db();
        let hidden = "[]";
        // 钉住窗口右端：运行期 OpenCode 仍在写库，浮动右端会让行数漂移。
        let end: i64 = 1_792_598_399_999;
        let day = 86_400_000_i64;

        println!("\n{:<6} {:<10} {:>10} {:>12} {:>12} {:>10}", "window", "rows", "old ms", "proj ms", "cached ms", "diff");
        for days in [7_i64, 30, 90] {
            let window = Some((end - days * day, end));

            let t0 = Instant::now();
            let rows = scan_tokens(&conn, window, hidden).expect("旧 token 扫描");
            let old_ms = t0.elapsed().as_secs_f64() * 1000.0;

            let t0 = Instant::now();
            let projection = scan_projection(&conn, window, hidden).expect("投影");
            let proj_ms = t0.elapsed().as_secs_f64() * 1000.0;

            // 第一次调用负责填充缓存，第二次才是「缓存命中」。
            let first = super::projection_cached(&conn, window, hidden).expect("缓存投影");
            let t0 = Instant::now();
            let cached = super::projection_cached(&conn, window, hidden).expect("缓存投影");
            let cached_ms = t0.elapsed().as_secs_f64() * 1000.0;
            assert!(std::sync::Arc::ptr_eq(&first, &cached), "{days}d 缓存应复用同一投影");

            // ── token 总量 / 分组 ──
            assert_tokens_eq(
                &aggregate(&rows),
                &super::derive_token_stats(&projection),
                &format!("{days}d token 总量"),
            );
            for group in ["day", "week", "month"] {
                assert_groups_eq(
                    &grouped(&rows, group),
                    &super::derive_token_groups(&projection, group),
                    &format!("{days}d token 分组 {group}"),
                );
            }

            // ── 工具 / 模型 / 供应商 / 项目 ──
            assert_eq!(
                debug(&tool_ranking(&conn, window, hidden).expect("旧工具")),
                debug(&super::derive_tool_ranking(&projection)),
                "{days}d 工具排行"
            );
            assert_ranked_eq(
                &model_ranking(&conn, window, hidden).expect("旧模型"),
                &super::derive_model_ranking(&projection),
                &format!("{days}d 模型排行（要求 0 差异）"),
                |item| (item.model.clone(), item.token_count, item.total_cost),
            );
            assert_ranked_eq(
                &provider_stats(&conn, window, hidden).expect("旧供应商"),
                &super::derive_provider_stats(&projection),
                &format!("{days}d 供应商统计"),
                |item| (item.provider.clone(), item.token_count, item.total_cost),
            );
            assert_ranked_eq(
                &project_ranking(&conn, window, hidden).expect("旧项目"),
                &super::derive_project_ranking(&projection),
                &format!("{days}d 项目排行"),
                |item| (item.project.clone(), item.token_count, item.total_cost),
            );
            assert_eq!(
                debug(&message_trend(&conn, window, hidden).expect("旧趋势")),
                debug(&super::derive_message_trend(&projection)),
                "{days}d 消息趋势"
            );
            assert_cost_trend_eq(
                &cost_trend(&conn, window, hidden).expect("旧成本"),
                &super::derive_cost_trend(&projection),
                &format!("{days}d 成本趋势"),
            );

            // ── 技能：与旧 SQL 严格相等（name → state.input.id → unknown）──
            assert_eq!(
                debug(&skill_usage(&conn, window, hidden).expect("旧技能")),
                debug(&super::derive_skill_usage(&projection)),
                "{days}d 技能排行"
            );
            let diffs: Vec<String> = Vec::new();
            assert!(
                !projection.skills.keys().any(|name| name.starts_with("call_")),
                "{days}d 技能排行出现工具调用 id：{:?}",
                projection.skills
            );

            println!(
                "{:<6} {:<10} {:>10.1} {:>12.1} {:>12.1} {:>10}",
                format!("{days}d"),
                projection.rows,
                old_ms,
                proj_ms,
                cached_ms,
                if diffs.is_empty() { "0".to_string() } else { diffs.join(" | ") }
            );
            println!(
                "       tokens={} tools={} skills={} models={}",
                projection.token_rows.iter().map(|row| {
                    row.input + row.output + row.reasoning + row.cache_read + row.cache_write
                }).sum::<f64>() as i64,
                projection.tools.values().sum::<i64>(),
                projection.skills.values().sum::<i64>(),
                projection.models.len()
            );
        }
    }

    #[test]
    fn projection_without_window_scans_everything() {
        let conn = fixture();
        let projection: Projection = scan_projection(&conn, None, "[]").expect("投影");
        assert_eq!(projection.rows, 10);
        assert_tokens_eq(
            &aggregate(&scan_tokens(&conn, None, "[]").expect("旧 token 扫描")),
            &super::derive_token_stats(&projection),
            "全时间窗口 token 总量",
        );
    }
}

/// T2 投影缓存的失效机制测试（P1-2）。
///
/// 缓存是进程级单例，因此这些测试：
/// - 全部持有 [`fork_stats::test_serial_guard`]，与其它会推进 generation 的测试串行；
/// - 每个用例开头清空缓存并复位扫描计数（`PROJECTION_SCAN_COUNT`）；
/// - 使用**临时目录里的文件库**（内存库没有文件戳，无法验证 stat 失效）。
#[cfg(test)]
mod projection_cache_tests {
    use super::{
        cache_path, db_stamp, hidden_hash, projection_cache, projection_cached, Projection,
        ProjectionKey, Window, PROJECTION_CACHE_MAX_AGE, PROJ_VERSION,
    };
    use crate::commands::fork_stats;
    use rusqlite::Connection;
    use std::path::PathBuf;
    use std::sync::atomic::Ordering;
    use std::sync::Arc;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    const HIDDEN: &str = "[]";
    const TS1: i64 = 1_789_000_000_000;

    /// 临时目录（Drop 时整个删除，连带 .db / -wal / -shm）。
    struct TempDir {
        dir: PathBuf,
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn temp_dir(label: &str) -> TempDir {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time is after the Unix epoch")
            .as_nanos();
        let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "opencode-w-proj-cache-{label}-{}-{nanos}-{counter}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir is created");
        TempDir { dir }
    }

    /// 建一个文件库（最小 schema，与 `projection_tests::db()` 同构）。
    fn file_conn(label: &str) -> (TempDir, Connection) {
        let temp = temp_dir(label);
        let conn = Connection::open(temp.dir.join("stats.db")).expect("file db opens");
        conn.execute_batch(
            "CREATE TABLE main.session_v2 (id TEXT PRIMARY KEY, model TEXT, directory TEXT);
             CREATE TABLE main.session_message (
                 id TEXT PRIMARY KEY,
                 session_id TEXT,
                 type TEXT,
                 time_created INTEGER,
                 data TEXT
             );",
        )
        .expect("schema applies");
        (temp, conn)
    }

    fn insert_session(conn: &Connection) {
        conn.execute(
            "INSERT INTO main.session_v2 (id, model, directory) VALUES ('s1', ?1, '/repo')",
            [r#"{"id":"m1","providerID":"p"}"#],
        )
        .expect("session inserts");
    }

    fn insert_message(conn: &Connection, id: &str, kind: &str, ts: i64, data: &str) {
        conn.execute(
            "INSERT INTO main.session_message (id, session_id, type, time_created, data)
             VALUES (?1, 's1', ?2, ?3, ?4)",
            rusqlite::params![id, kind, ts, data],
        )
        .expect("message inserts");
    }

    fn assistant_data(input: i64) -> String {
        format!(r#"{{"tokens":{{"input":{input}}},"cost":0.1}}"#)
    }

    fn seed(conn: &Connection, count: usize) {
        insert_session(conn);
        for i in 0..count {
            insert_message(
                conn,
                &format!("m{i:02}"),
                "assistant",
                TS1 + i as i64,
                &assistant_data(10 + i as i64),
            );
        }
    }

    /// 追加若干条带大字段的 assistant 消息：保证库文件 size 必然变化。
    fn append_rows(conn: &Connection, count: usize) {
        for i in 0..count {
            let filler = "x".repeat(200);
            insert_message(
                conn,
                &format!("extra{i:02}"),
                "assistant",
                TS1 + 1000 + i as i64,
                &format!(r#"{{"tokens":{{"input":1}},"note":"{filler}"}}"#),
            );
        }
    }

    fn scan_count(conn: &Connection) -> u64 {
        let path = cache_path(conn).expect("file db has a path");
        super::projection_scan_count_for_tests(&path)
    }

    fn reset_scan(conn: &Connection) {
        let path = cache_path(conn).expect("file db has a path");
        super::reset_projection_scan_count_for_tests(&path);
    }

    /// 进程级缓存单例：用例之间必须清空，避免键互相污染。
    fn clear_cache() {
        let mut map = projection_cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        map.clear();
    }

    fn key_of(conn: &Connection, window: Window, hidden: &str) -> ProjectionKey {
        (
            cache_path(conn).expect("file db has a path"),
            window,
            fork_stats::cache_generation(),
            hidden_hash(hidden),
            PROJ_VERSION,
        )
    }

    /// 把缓存条目的创建时刻回拨 `age`（等价于「时间过去了 age」）。
    ///
    /// 返回 `false` 表示机器运行时间不足、无法回拨（`Instant` 下溢），此时
    /// 调用方应跳过依赖该回拨的断言，避免在刚启动的 CI 机器上误报。
    fn age_entry(conn: &Connection, window: Window, hidden: &str, age: Duration) -> bool {
        let key = key_of(conn, window, hidden);
        let map = projection_cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let slot = map.get(&key).expect("cache slot exists");
        let mut state = slot
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(shifted) = Instant::now().checked_sub(age) else {
            eprintln!("[skip-time] 进程运行不足 {}s，无法回拨时钟", age.as_secs());
            return false;
        };
        let (_, stamp, projection) = state.take().expect("cached entry exists");
        *state = Some((shifted, stamp, projection));
        true
    }

    fn entry_is_cached(conn: &Connection, window: Window, hidden: &str) -> bool {
        let key = key_of(conn, window, hidden);
        let map = projection_cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match map.get(&key) {
            None => false,
            Some(slot) => slot
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .is_some(),
        }
    }

    #[test]
    fn same_key_concurrent_calls_share_one_scan() {
        let _guard = fork_stats::test_serial_guard();
        clear_cache();
        let (temp, conn) = file_conn("concurrent");
        reset_scan(&conn);
        seed(&conn, 4);
        let path = temp.dir.join("stats.db");

        let handles: Vec<_> = (0..2)
            .map(|_| {
                let path = path.clone();
                std::thread::spawn(move || {
                    let conn = Connection::open(&path).expect("thread db opens");
                    projection_cached(&conn, None, HIDDEN).expect("projection runs")
                })
            })
            .collect();
        let results: Vec<Arc<Projection>> = handles
            .into_iter()
            .map(|handle| handle.join().expect("thread joins"))
            .collect();

        assert_eq!(scan_count(&conn), 1, "同键并发只允许一次全表扫描");
        assert!(
            Arc::ptr_eq(&results[0], &results[1]),
            "并发两次调用必须复用同一 Arc"
        );

        // 后续顺序调用仍然命中：不会第三次扫描。
        let third = projection_cached(&conn, None, HIDDEN).expect("projection runs");
        assert!(Arc::ptr_eq(&results[0], &third));
        assert_eq!(scan_count(&conn), 1);
    }

    #[test]
    fn generation_bump_invalidates_projection() {
        let _guard = fork_stats::test_serial_guard();
        clear_cache();
        let (_temp, conn) = file_conn("generation");
        seed(&conn, 2);

        let first = projection_cached(&conn, None, HIDDEN).expect("projection runs");
        assert_eq!(scan_count(&conn), 1);

        // 写操作（删除 / 移动等）会推进 fork_stats 的缓存代次。
        fork_stats::invalidate_cache();

        let second = projection_cached(&conn, None, HIDDEN).expect("projection runs");
        assert_eq!(scan_count(&conn), 2, "代次变化必须导致缓存 miss");
        assert!(!Arc::ptr_eq(&first, &second), "不得复用旧代次的投影");

        let generation = fork_stats::cache_generation();
        let map = projection_cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert!(
            map.keys().all(|(_, _, gen, _, _)| *gen == generation),
            "旧代次条目必须被 retain 清除"
        );
    }

    #[test]
    fn file_stamp_change_invalidates_projection() {
        let _guard = fork_stats::test_serial_guard();
        clear_cache();
        let (_temp, conn) = file_conn("stamp");
        reset_scan(&conn);
        seed(&conn, 2);

        let stamp_before = db_stamp(&conn).expect("file db has a stamp");
        let first = projection_cached(&conn, None, HIDDEN).expect("projection runs");
        assert_eq!(scan_count(&conn), 1);

        // 5s 新鲜窗口会短路文件戳比对，因此先把条目拨过新鲜窗口：
        // 空闲 60s 后，命中与否完全取决于文件戳。
        assert!(
            age_entry(&conn, None, HIDDEN, Duration::from_secs(60)),
            "需要进程运行超过 60s 才能回拨时钟"
        );

        // 外部写入（模拟 OpenCode 自己追加消息）：文件 size 必然变化。
        append_rows(&conn, 8);
        let stamp_after = db_stamp(&conn).expect("file db has a stamp");
        assert_ne!(stamp_before, stamp_after, "写入后文件戳必须变化");

        let second = projection_cached(&conn, None, HIDDEN).expect("projection runs");
        assert_eq!(scan_count(&conn), 2, "文件戳变化必须导致缓存 miss");
        assert!(!Arc::ptr_eq(&first, &second));
    }

    #[test]
    fn different_hidden_hash_does_not_cross_pollinate() {
        let _guard = fork_stats::test_serial_guard();
        clear_cache();
        let (_temp, conn) = file_conn("hidden");
        reset_scan(&conn);
        seed(&conn, 3);

        let all = projection_cached(&conn, None, HIDDEN).expect("projection runs");
        assert_eq!(all.rows, 3);
        assert_eq!(scan_count(&conn), 1);

        let hidden = projection_cached(&conn, None, r#"["m02"]"#).expect("projection runs");
        assert_eq!(hidden.rows, 2, "隐藏集合必须真的排除对应消息");
        assert_eq!(scan_count(&conn), 2, "不同 hidden_hash 必须各自扫描");
        assert!(!Arc::ptr_eq(&all, &hidden), "两个投影不得互相串用");

        // 再查 "[]"：命中自己的条目，不重扫、也不复用 hidden 的结果。
        let again = projection_cached(&conn, None, HIDDEN).expect("projection runs");
        assert!(Arc::ptr_eq(&all, &again));
        assert_eq!(scan_count(&conn), 2);
    }

    #[test]
    fn lru_keeps_two_entries_and_evicts_least_recently_used() {
        let _guard = fork_stats::test_serial_guard();
        clear_cache();
        let (_temp, conn) = file_conn("lru");
        reset_scan(&conn);
        seed(&conn, 3);
        let path = cache_path(&conn).expect("file db has a path");
        let generation = fork_stats::cache_generation();

        // 三个窗口：A（最旧）→ B → A（触活）→ C（挤出 B）。
        let window_a = Some((0, TS1));
        let window_b = Some((TS1, TS1 + 500));
        let window_c = Some((TS1 + 500, TS1 + 1000));

        let a1 = projection_cached(&conn, window_a, HIDDEN).expect("projection runs");
        let _b1 = projection_cached(&conn, window_b, HIDDEN).expect("projection runs");
        assert_eq!(scan_count(&conn), 2);

        let a2 = projection_cached(&conn, window_a, HIDDEN).expect("projection runs");
        assert!(Arc::ptr_eq(&a1, &a2), "A 触活必须命中");
        assert_eq!(scan_count(&conn), 2);

        let c1 = projection_cached(&conn, window_c, HIDDEN).expect("projection runs");
        assert_eq!(scan_count(&conn), 3, "新窗口必须扫描");

        let key = |window: Window| (path.clone(), window, generation, hidden_hash(HIDDEN), PROJ_VERSION);
        {
            let map = projection_cache()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            assert_eq!(map.len(), 2, "缓存条目上限是 2");
            assert!(map.contains_key(&key(window_a)), "最近使用的 A 必须保留");
            assert!(map.contains_key(&key(window_c)), "刚插入的 C 必须保留");
            assert!(!map.contains_key(&key(window_b)), "最久未用的 B 必须被淘汰");
        }

        // A / C 仍命中；B 需要重新扫描。
        assert!(Arc::ptr_eq(
            &a1,
            &projection_cached(&conn, window_a, HIDDEN).expect("projection runs")
        ));
        assert!(Arc::ptr_eq(
            &c1,
            &projection_cached(&conn, window_c, HIDDEN).expect("projection runs")
        ));
        assert_eq!(scan_count(&conn), 3);
        projection_cached(&conn, window_b, HIDDEN).expect("projection runs");
        assert_eq!(scan_count(&conn), 4, "被淘汰的 B 必须重扫");
    }

    #[test]
    fn ttl_fresh_window_then_max_age_expiry() {
        let _guard = fork_stats::test_serial_guard();
        clear_cache();
        let (_temp, conn) = file_conn("ttl");
        reset_scan(&conn);
        seed(&conn, 2);

        let first = projection_cached(&conn, None, HIDDEN).expect("projection runs");
        assert_eq!(scan_count(&conn), 1);

        // 5s 新鲜窗口内：直接命中。
        let fresh = projection_cached(&conn, None, HIDDEN).expect("projection runs");
        assert!(Arc::ptr_eq(&first, &fresh), "新鲜窗口内必须命中");
        assert_eq!(scan_count(&conn), 1);

        // 5s < age ≤ 300s 且文件戳未变：空闲库继续复用。
        if age_entry(&conn, None, HIDDEN, Duration::from_secs(60)) {
            let aged = projection_cached(&conn, None, HIDDEN).expect("projection runs");
            assert!(Arc::ptr_eq(&first, &aged), "文件戳未变时 5min 内必须命中");
            assert_eq!(scan_count(&conn), 1);
        }

        // age > MAX_AGE：过期，必须重扫。
        let over_max_age = PROJECTION_CACHE_MAX_AGE + Duration::from_secs(1);
        if age_entry(&conn, None, HIDDEN, over_max_age) {
            projection_cached(&conn, None, HIDDEN).expect("projection runs");
            assert_eq!(scan_count(&conn), 2, "超过 MAX_AGE 后必须重扫");
        }

        // 文件戳变了：即使 age 在窗口内也必须重扫（外部写入立即失效）。
        append_rows(&conn, 8);
        if age_entry(&conn, None, HIDDEN, Duration::from_secs(60)) {
            projection_cached(&conn, None, HIDDEN).expect("projection runs");
            assert_eq!(scan_count(&conn), 3, "窗口内但文件戳变化也必须重扫");
        }
    }

    #[test]
    fn failed_projection_is_not_cached() {
        let _guard = fork_stats::test_serial_guard();
        clear_cache();
        let (_temp, conn) = file_conn("bad-json");
        reset_scan(&conn);
        seed(&conn, 2);
        // 一条无法解析的 JSON：scan_projection 整体失败（口径与旧路径一致）。
        insert_message(&conn, "m_broken", "assistant", TS1 + 900, "{not-json");

        let error = projection_cached(&conn, None, HIDDEN).expect_err("坏 JSON 必须失败");
        assert!(error.contains("JSON"), "错误需说明 JSON 无法解析：{error}");
        assert_eq!(scan_count(&conn), 1);
        assert!(!entry_is_cached(&conn, None, HIDDEN), "失败的投影不得写入缓存");

        // 再次调用：不得「命中旧缓存」，必须重新尝试扫描（依旧失败）。
        assert!(projection_cached(&conn, None, HIDDEN).is_err());
        assert_eq!(scan_count(&conn), 2, "失败后的调用必须重扫，而不是命中旧缓存");
    }
}
