//! TASK-010a：T2 投影扫描形态原型基准（(a) 相关子查询 / (b) LEFT JOIN+HashSet / (c) 两趟）。
//!
//! 只在显式指定真实库时运行：
//!
//! ```sh
//! OPENCODE_W_TEST_DB=~/.local/share/opencode/opencode.db \
//!   cargo test --release --test t2_prototype -- --ignored --nocapture
//! ```
//!
//! 只读打开数据库；不写入、不改仓库任何数据。
//!
//! # 实测结论（2026-10，真实库，90 天窗口 104,765 行 / data ≈ 4.5 GB）
//!
//! | 变体 | 首跑 | 热跑 | 说明 |
//! | --- | --- | --- | --- |
//! | (a) | 31.8s | 19.1s | 相关子查询 `json_group_array` + Rust 解析 data |
//! | (b) | 28.5s | 20.8s | `LEFT JOIN json_each` + HashSet 去重 |
//! | (c) | 18.3s | 24.2s | 两趟（消息一趟 + 块一趟） |
//! | (d) | 12.5s | **4.26s** | SQL 零 JSON，Rust 单趟解析 tokens/cost/content |
//! | 旧 token SQL | 5.7s | 6.7s | 基线：单条 token 查询（9 次 `json_extract`） |
//!
//! 注：上表数字在删除「block 顶层 id」抽取之前测得；该字段是工具调用 id
//! （`call_...`），不参与技能名归一，删除后只会略快，不影响结论。
//!
//! 结论：(a)/(b)/(c) 的瓶颈都在 SQLite 侧 JSON——`json_group_array` 要为每条
//! 消息构造一次数组（约 14s），`json_extract` 每次调用都会重新解析整条 JSON。
//! (d) 让 SQL 只做列读取 + 3 个 `strftime(localtime)`，JSON 全程只被解析一次，
//! 因此比 (a) 快约 4.5 倍，也优于旧路径 8 条命令并发的 24s。
//! 生产实现（`stats_v2::scan_projection`）采用 (d)：SQL 里**没有任何 JSON 函数**，
//! 也没有 blocks 子查询。本文件里的 (a)(b)(c)(e) 已否决，仅作为决策证据保留
//! （一致性断言仍会跑，防止日后有人把旧形态搬回去）。

#![allow(dead_code)]

use std::collections::{BTreeMap, HashSet};
use std::time::Instant;

use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;

const DAY: &str = "strftime('%Y-%m-%d', sm.time_created / 1000, 'unixepoch', 'localtime')";
const WEEK: &str = "strftime('%Y-W%W', sm.time_created / 1000, 'unixepoch', 'localtime')";
const MONTH: &str = "strftime('%Y-%m', sm.time_created / 1000, 'unixepoch', 'localtime')";

/// 只反序列化 tokens/cost：content 交给 SQL 单独取，避免在 Rust 侧再建块结构。
#[derive(Debug, Default, Deserialize)]
struct MsgData {
    #[serde(default)]
    tokens: Option<Tokens>,
    #[serde(default)]
    cost: Option<f64>,
}

#[derive(Debug, Default, Clone, Deserialize)]
struct Tokens {
    #[serde(default)]
    input: Option<f64>,
    #[serde(default)]
    output: Option<f64>,
    #[serde(default)]
    reasoning: Option<f64>,
    #[serde(default)]
    cache: Option<Cache>,
}

#[derive(Debug, Default, Clone, Deserialize)]
struct Cache {
    #[serde(default)]
    read: Option<f64>,
    #[serde(default)]
    write: Option<f64>,
}

#[derive(Debug, Default, Deserialize)]
struct Block {
    #[serde(default)]
    name: Option<String>,
    #[serde(default, rename = "type")]
    ty: Option<String>,
    #[serde(default)]
    iname: Option<String>,
    #[serde(default)]
    iid: Option<String>,
}

/// (d) 只让 Rust 解析一次 data（tokens/cost/content 同一趟）；SQL 不碰 JSON。
#[derive(Debug, Default, Deserialize)]
struct FullMsgData {
    #[serde(default)]
    tokens: Option<Tokens>,
    #[serde(default)]
    cost: Option<f64>,
    #[serde(default)]
    content: Option<Vec<NestedBlock>>,
}

#[derive(Debug, Default, Deserialize)]
struct NestedBlock {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default, rename = "type")]
    ty: Option<String>,
    #[serde(default)]
    state: Option<NestedState>,
}

#[derive(Debug, Default, Deserialize)]
struct NestedState {
    #[serde(default)]
    input: Option<NestedInput>,
}

#[derive(Debug, Default, Deserialize)]
struct NestedInput {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    id: Option<String>,
}

#[derive(Default)]
struct Acc {
    rows: i64,
    assistant: i64,
    tokens: f64,
    tools: BTreeMap<String, i64>,
    skills: BTreeMap<String, i64>,
    days: BTreeMap<String, i64>,
    models: BTreeMap<String, i64>,
}

impl Acc {
    /// 只有 `type='assistant'` 的消息才贡献 token（与旧 `scan_tokens` 一致）。
    fn add_message(&mut self, kind: &str, data: &str) {
        if kind != "assistant" {
            return;
        }
        self.assistant += 1;
        let parsed: MsgData = serde_json::from_str(data).unwrap_or_default();
        self.tokens += token_total(&parsed);
    }

    fn add_tool_block(&mut self, name: Option<&str>, iname: Option<&str>, iid: Option<&str>) {
        let tool = name.unwrap_or("unknown");
        *self.tools.entry(tool.to_string()).or_insert(0) += 1;
        if tool == "skill" {
            // 技能名只认 state.input.name → state.input.id；
            // block 顶层 id 是工具调用 id，不能当技能名。
            let skill = iname
                .filter(|s| !s.is_empty())
                .or(iid.filter(|s| !s.is_empty()))
                .unwrap_or("unknown");
            *self.skills.entry(skill.to_string()).or_insert(0) += 1;
        }
    }
}

fn token_total(data: &MsgData) -> f64 {
    let Some(tokens) = data.tokens.as_ref() else {
        return 0.0;
    };
    let cache = tokens.cache.as_ref();
    tokens.input.unwrap_or(0.0)
        + tokens.output.unwrap_or(0.0)
        + tokens.reasoning.unwrap_or(0.0)
        + cache.and_then(|c| c.read).unwrap_or(0.0)
        + cache.and_then(|c| c.write).unwrap_or(0.0)
}

fn sql_a() -> String {
    format!(
        "SELECT sm.id, sm.type, sm.time_created, {DAY}, {WEEK}, {MONTH}, sm.data,
                s.model, s.directory,
                COALESCE((SELECT json_group_array(json_object(
                             'name',  json_extract(c.value, '$.name'),
                             'type',  json_extract(c.value, '$.type'),
                             'iname', json_extract(c.value, '$.state.input.name'),
                             'iid',   json_extract(c.value, '$.state.input.id')))
                          FROM json_each(sm.data, '$.content') c
                          WHERE json_extract(c.value, '$.type') = 'tool'), '[]') AS blocks
         FROM main.session_message sm
         LEFT JOIN main.session_v2 s ON s.id = sm.session_id
         WHERE sm.time_created BETWEEN ?1 AND ?2"
    )
}

fn sql_b() -> String {
    format!(
        "SELECT sm.id, sm.type, sm.time_created, {DAY}, {WEEK}, {MONTH}, sm.data,
                s.model, s.directory,
                json_extract(c.value, '$.name'),
                json_extract(c.value, '$.state.input.name'),
                json_extract(c.value, '$.state.input.id'),
                json_extract(c.value, '$.type')
         FROM main.session_message sm
         LEFT JOIN main.session_v2 s ON s.id = sm.session_id
         LEFT JOIN json_each(sm.data, '$.content') c
         WHERE sm.time_created BETWEEN ?1 AND ?2"
    )
}

fn sql_c_messages() -> String {
    format!(
        "SELECT sm.id, sm.type, sm.time_created, {DAY}, {WEEK}, {MONTH}, sm.data,
                s.model, s.directory
         FROM main.session_message sm
         LEFT JOIN main.session_v2 s ON s.id = sm.session_id
         WHERE sm.time_created BETWEEN ?1 AND ?2"
    )
}

fn sql_c_blocks() -> String {
    "SELECT sm.id,
            json_extract(c.value, '$.name'),
            json_extract(c.value, '$.state.input.name'),
            json_extract(c.value, '$.state.input.id')
     FROM main.session_message sm, json_each(sm.data, '$.content') c
     WHERE sm.time_created BETWEEN ?1 AND ?2
       AND json_extract(c.value, '$.type') = 'tool'"
        .to_string()
}

fn variant_a(conn: &Connection, start: i64, end: i64) -> Acc {
    let mut acc = Acc::default();
    let mut stmt = conn.prepare(&sql_a()).expect("prepare a");
    let mut rows = stmt.query([start, end]).expect("query a");
    while let Some(row) = rows.next().expect("row a") {
        acc.rows += 1;
        let kind: String = row.get(1).expect("type");
        let data: String = row.get(6).expect("data");
        let blocks: String = row.get(9).expect("blocks");
        acc.add_message(&kind, &data);
        if let Ok(items) = serde_json::from_str::<Vec<Block>>(&blocks) {
            for block in items {
                if block.ty.as_deref() == Some("tool") {
                    acc.add_tool_block(
                        block.name.as_deref(),
                        block.iname.as_deref(),
                        block.iid.as_deref(),
                    );
                }
            }
        }
    }
    acc
}

fn variant_b(conn: &Connection, start: i64, end: i64) -> Acc {
    let mut acc = Acc::default();
    let mut seen: HashSet<String> = HashSet::new();
    let mut stmt = conn.prepare(&sql_b()).expect("prepare b");
    let mut rows = stmt.query([start, end]).expect("query b");
    while let Some(row) = rows.next().expect("row b") {
        let id: String = row.get(0).expect("id");
        if seen.insert(id) {
            acc.rows += 1;
            let kind: String = row.get(1).expect("type");
            let data: String = row.get(6).expect("data");
            acc.add_message(&kind, &data);
        }
        let ty: Option<String> = row.get(12).expect("block type");
        if ty.as_deref() == Some("tool") {
            let name: Option<String> = row.get(9).expect("name");
            let iname: Option<String> = row.get(10).expect("iname");
            let iid: Option<String> = row.get(11).expect("iid");
            acc.add_tool_block(name.as_deref(), iname.as_deref(), iid.as_deref());
        }
    }
    acc
}

fn variant_c(conn: &Connection, start: i64, end: i64) -> Acc {
    let mut acc = Acc::default();
    let mut stmt = conn.prepare(&sql_c_messages()).expect("prepare c1");
    let mut rows = stmt.query([start, end]).expect("query c1");
    while let Some(row) = rows.next().expect("row c1") {
        acc.rows += 1;
        let kind: String = row.get(1).expect("type");
        let data: String = row.get(6).expect("data");
        acc.add_message(&kind, &data);
    }
    drop(rows);
    drop(stmt);

    let mut stmt = conn.prepare(&sql_c_blocks()).expect("prepare c2");
    let mut rows = stmt.query([start, end]).expect("query c2");
    while let Some(row) = rows.next().expect("row c2") {
        let name: Option<String> = row.get(1).expect("name");
        let iname: Option<String> = row.get(2).expect("iname");
        let iid: Option<String> = row.get(3).expect("iid");
        acc.add_tool_block(name.as_deref(), iname.as_deref(), iid.as_deref());
    }
    acc
}

fn sql_d() -> String {
    format!(
        "SELECT sm.id, sm.type, sm.time_created, {DAY}, {WEEK}, {MONTH}, sm.data,
                s.model, s.directory
         FROM main.session_message sm
         LEFT JOIN main.session_v2 s ON s.id = sm.session_id
         WHERE sm.time_created BETWEEN ?1 AND ?2"
    )
}

fn sql_e() -> String {
    format!(
        "SELECT sm.type, {DAY}, {WEEK}, {MONTH},
                json_extract(sm.data, '$.tokens.input'),
                json_extract(sm.data, '$.tokens.output'),
                json_extract(sm.data, '$.tokens.reasoning'),
                json_extract(sm.data, '$.tokens.cache.read'),
                json_extract(sm.data, '$.tokens.cache.write'),
                json_extract(sm.data, '$.cost'),
                s.model, s.directory,
                COALESCE((SELECT json_group_array(json_object(
                             'name',  json_extract(c.value, '$.name'),
                             'type',  json_extract(c.value, '$.type'),
                             'iname', json_extract(c.value, '$.state.input.name'),
                             'iid',   json_extract(c.value, '$.state.input.id')))
                          FROM json_each(sm.data, '$.content') c
                          WHERE json_extract(c.value, '$.type') = 'tool'), '[]') AS blocks
         FROM main.session_message sm
         LEFT JOIN main.session_v2 s ON s.id = sm.session_id
         WHERE sm.time_created BETWEEN ?1 AND ?2"
    )
}

/// 旧路径的 token 扫描 SQL（9 次 extract + 3 次 strftime），作为同条件基线。
fn sql_baseline_tokens() -> String {
    format!(
        "SELECT {DAY}, {WEEK}, {MONTH},
                json_extract(sm.data, '$.tokens.input'),
                json_extract(sm.data, '$.tokens.output'),
                json_extract(sm.data, '$.tokens.reasoning'),
                json_extract(sm.data, '$.tokens.cache.read'),
                json_extract(sm.data, '$.tokens.cache.write'),
                json_extract(sm.data, '$.cost')
         FROM main.session_message sm
         WHERE sm.type = 'assistant' AND sm.time_created BETWEEN ?1 AND ?2"
    )
}

fn variant_d(conn: &Connection, start: i64, end: i64) -> Acc {
    let mut acc = Acc::default();
    let mut stmt = conn.prepare(&sql_d()).expect("prepare d");
    let mut rows = stmt.query([start, end]).expect("query d");
    while let Some(row) = rows.next().expect("row d") {
        acc.rows += 1;
        let kind: String = row.get(1).expect("type");
        let data: String = row.get(6).expect("data");
        let parsed: FullMsgData = match serde_json::from_str(&data) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if kind == "assistant" {
            acc.assistant += 1;
            acc.tokens += token_total(&MsgData {
                tokens: parsed.tokens.clone(),
                cost: parsed.cost,
            });
        }
        if let Some(blocks) = parsed.content {
            for block in blocks {
                if block.ty.as_deref() != Some("tool") {
                    continue;
                }
                let input = block.state.and_then(|s| s.input);
                acc.add_tool_block(
                    block.name.as_deref(),
                    input.as_ref().and_then(|i| i.name.as_deref()),
                    input.as_ref().and_then(|i| i.id.as_deref()),
                );
            }
        }
    }
    acc
}

fn variant_e(conn: &Connection, start: i64, end: i64) -> Acc {
    let mut acc = Acc::default();
    let mut stmt = conn.prepare(&sql_e()).expect("prepare e");
    let mut rows = stmt.query([start, end]).expect("query e");
    while let Some(row) = rows.next().expect("row e") {
        acc.rows += 1;
        let kind: String = row.get(0).expect("type");
        if kind == "assistant" {
            acc.assistant += 1;
            // 列 4..=8 是 5 个 token 字段；列 9 是 cost，不能算进 tokens。
            let sum: f64 = (4..=8)
                .filter_map(|i| row.get::<_, Option<f64>>(i).ok().flatten())
                .sum();
            acc.tokens += sum;
        }
        let blocks: String = row.get(12).expect("blocks");
        if let Ok(items) = serde_json::from_str::<Vec<Block>>(&blocks) {
            for block in items {
                if block.ty.as_deref() == Some("tool") {
                    acc.add_tool_block(
                        block.name.as_deref(),
                        block.iname.as_deref(),
                        block.iid.as_deref(),
                    );
                }
            }
        }
    }
    acc
}

/// 旧 token 扫描的等价实现：返回 (assistant 行数, token 合计)。
///
/// 列 3..=7 是 5 个 token 字段，列 8 是 cost——基线只关心 tokens。
fn baseline_tokens(conn: &Connection, start: i64, end: i64) -> (i64, f64) {
    let mut stmt = conn.prepare(&sql_baseline_tokens()).expect("prepare baseline");
    let mut rows = stmt.query([start, end]).expect("query baseline");
    let mut count = 0_i64;
    let mut tokens = 0.0_f64;
    while let Some(row) = rows.next().expect("row baseline") {
        let _day: String = row.get(0).expect("day");
        let sum: f64 = (3..=7)
            .filter_map(|i| row.get::<_, Option<f64>>(i).ok().flatten())
            .sum();
        tokens += sum;
        count += 1;
    }
    (count, tokens)
}

fn explain(conn: &Connection, sql: &str) -> String {
    let mut stmt = conn
        .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
        .expect("prepare explain");
    let rows = stmt
        .query_map([0_i64, i64::MAX], |row| row.get::<_, String>(3))
        .expect("explain");
    rows.filter_map(Result::ok).collect::<Vec<_>>().join("\n    ")
}

fn open_real_db() -> Connection {
    let path = std::env::var("OPENCODE_W_TEST_DB")
        .expect("需要 OPENCODE_W_TEST_DB 指向真实 opencode.db");
    let conn = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .expect("只读打开真实库");
    conn.execute_batch(
        "PRAGMA cache_size = -64000;
         PRAGMA mmap_size = 268435456;
         PRAGMA temp_store = MEMORY;
         PRAGMA threads = 4;",
    )
    .expect("pragmas");
    conn
}

fn run(label: &str, conn: &Connection, start: i64, end: i64) -> Acc {
    let mut best = f64::MAX;
    let mut last = Acc::default();
    for round in 1..=2 {
        let t0 = Instant::now();
        last = match label {
            "a" => variant_a(conn, start, end),
            "b" => variant_b(conn, start, end),
            "c" => variant_c(conn, start, end),
            "d" => variant_d(conn, start, end),
            _ => variant_e(conn, start, end),
        };
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        println!(
            "  [{label}] round {round}: {:>9.1} ms  rows={} tokens={:.0} tools={} skills={}",
            ms,
            last.rows,
            last.tokens,
            last.tools.values().sum::<i64>(),
            last.skills.values().sum::<i64>()
        );
        best = best.min(ms);
    }
    println!("  [{label}] best {best:.1} ms");
    last
}

#[test]
#[ignore = "需要 OPENCODE_W_TEST_DB 指向真实库；原型基准手动运行"]
fn prototype_scan_variants() {
    let conn = open_real_db();
    let start: i64 = std::env::var("OPENCODE_W_WINDOW_START")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1_784_822_400_000);
    // 默认钉到「昨天 23:59:59」，避免运行期间 OpenCode 继续写入导致行数漂移。
    let end: i64 = std::env::var("OPENCODE_W_WINDOW_END")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1_792_598_399_999);

    println!("\n== window {start}..{end} ==");
    println!("== EXPLAIN (a) ==\n    {}", explain(&conn, &sql_a()));
    println!("== EXPLAIN (b) ==\n    {}", explain(&conn, &sql_b()));
    println!("== EXPLAIN (d) ==\n    {}", explain(&conn, &sql_d()));

    println!("\n-- 基线：旧 token 扫描 SQL（SQL 侧 9 次 extract） --");
    let mut baseline = (0_i64, 0.0_f64);
    for round in 1..=2 {
        let t0 = Instant::now();
        baseline = baseline_tokens(&conn, start, end);
        println!(
            "  [base] round {round}: {:>9.1} ms  rows={} tokens={:.0}",
            t0.elapsed().as_secs_f64() * 1000.0,
            baseline.0,
            baseline.1
        );
    }

    println!("\n-- 变体 (a) 相关子查询 json_group_array --");
    let a = run("a", &conn, start, end);
    println!("\n-- 变体 (b) LEFT JOIN json_each + HashSet 去重 --");
    let b = run("b", &conn, start, end);
    println!("\n-- 变体 (c) 两趟 --");
    let c = run("c", &conn, start, end);
    println!("\n-- 变体 (d) Rust 单趟解析 data（tokens+content 同一趟） --");
    let d = run("d", &conn, start, end);
    println!("\n-- 变体 (e) SQL 侧 extract + 子查询，Rust 不解 data --");
    let e = run("e", &conn, start, end);

    assert_eq!(a.rows, b.rows, "行数必须一致");
    assert_eq!(a.rows, c.rows, "行数必须一致");
    assert_eq!(a.rows, d.rows, "行数必须一致");
    assert_eq!(a.rows, e.rows, "行数必须一致");
    println!(
        "\n  rows={} assistant={} tokens={:.0}（基线 tokens={:.0}）",
        a.rows, a.assistant, a.tokens, baseline.1
    );
    assert_eq!(a.assistant, baseline.0, "assistant 行数必须与旧 SQL 一致");
    assert!(
        (a.tokens - baseline.1).abs() < 1e-6,
        "tokens 必须与旧 SQL 一致：a={} baseline={}",
        a.tokens,
        baseline.1
    );
    for (label, other) in [("b", &b), ("c", &c), ("d", &d), ("e", &e)] {
        assert_eq!(a.assistant, other.assistant, "assistant 行数必须一致（{label}）");
        assert!(
            (a.tokens - other.tokens).abs() < 1e-6,
            "tokens 必须一致：a={} {label}={}",
            a.tokens,
            other.tokens
        );
        assert_eq!(a.tools, other.tools, "tool 计数必须一致（{label}）");
        assert_eq!(a.skills, other.skills, "skill 计数必须一致（{label}）");
    }
}
