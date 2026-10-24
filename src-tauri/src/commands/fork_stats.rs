use rusqlite::Connection;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const MAX_CANDIDATES: usize = 256;
pub const MAX_ROWS: usize = 50_000;
pub const MAX_DIGESTS: usize = 50_000;

#[derive(Clone)]
struct CacheEntry {
    created_at: Instant,
    value: DedupSet,
}

/// 归因口径：v1 走旧表指纹，v2 走 `session_v2` / `session_message`。
///
/// 同一个库路径在迁移前后口径不同，因此缓存键必须带上口径，否则切换库或
/// 迁移完成后会读到旧口径的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Flavor {
    Legacy,
    V2,
}

type CacheKey = (String, Option<(i64, i64)>, u64, Flavor);
type DedupCache = BTreeMap<CacheKey, CacheEntry>;

fn cache() -> &'static Mutex<DedupCache> {
    static CACHE: OnceLock<Mutex<DedupCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(BTreeMap::new()))
}

/// 同 key 单飞槽位：并发请求命同一个 key 时，只有第一个真正计算，
/// 其余请求阻塞后复用缓存结果。槽位按代次清理，避免无限增长。
fn flights() -> &'static Mutex<BTreeMap<CacheKey, Arc<Mutex<()>>>> {
    static FLIGHTS: OnceLock<Mutex<BTreeMap<CacheKey, Arc<Mutex<()>>>>> = OnceLock::new();
    FLIGHTS.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn generation() -> &'static std::sync::atomic::AtomicU64 {
    static GENERATION: OnceLock<std::sync::atomic::AtomicU64> = OnceLock::new();
    GENERATION.get_or_init(|| std::sync::atomic::AtomicU64::new(0))
}

pub fn invalidate_cache() {
    generation().fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    if let Ok(mut entry) = cache().lock() {
        entry.clear();
    }
}

/// 当前缓存代次。
///
/// 统计侧的短缓存（v2 token 扫描）把它放进缓存键，写操作调用
/// [`invalidate_cache`] 后代次变化，旧结果自然失效。
pub fn cache_generation() -> u64 {
    generation().load(std::sync::atomic::Ordering::Acquire)
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct DedupSet {
    pub hidden_sessions: BTreeSet<String>,
    pub hidden_messages: BTreeSet<String>,
    pub hidden_parts: BTreeSet<String>,
    pub exhausted: bool,
}

impl DedupSet {
    pub fn session_ids_json(&self) -> String {
        serde_json::to_string(&self.hidden_sessions).unwrap_or_else(|_| "[]".to_string())
    }

    pub fn message_ids_json(&self) -> String {
        serde_json::to_string(&self.hidden_messages).unwrap_or_else(|_| "[]".to_string())
    }

    pub fn part_ids_json(&self) -> String {
        serde_json::to_string(&self.hidden_parts).unwrap_or_else(|_| "[]".to_string())
    }
}

#[derive(Debug)]
struct Budget {
    candidates: usize,
    rows: usize,
    digests: usize,
    exhausted: bool,
}

impl Budget {
    fn spend_candidate(&mut self) -> bool {
        self.candidates += 1;
        self.candidates <= MAX_CANDIDATES
    }

    fn spend_row(&mut self) -> bool {
        self.rows += 1;
        self.exhausted = self.rows > MAX_ROWS;
        !self.exhausted
    }

    fn spend_digest(&mut self) -> bool {
        self.digests += 1;
        self.exhausted = self.digests > MAX_DIGESTS;
        !self.exhausted
    }
}

#[derive(Debug, Clone)]
struct SessionMeta {
    id: String,
    directory: String,
    project_id: String,
    created: i64,
}

#[derive(Debug)]
struct Message {
    id: String,
    role: String,
    digest: [u8; 32],
    part_ids: Vec<String>,
}

#[derive(Debug)]
struct Transcript {
    messages: Vec<Message>,
}

/// Returns the branch IDs to hide from logical statistics without mutating the database.
/// Evidence reads are not date-filtered; an exhausted request hides nothing.
///
/// 库形态自动分流：v2 库（含混合库）走 [`dedup_v2`]，v1 库走原有
/// [`dedup_impl`]。分流只查 `main.sqlite_master`（`schema::detect_mode`），
/// 不读业务数据，v1 行为不变。
pub fn dedup(conn: &Connection) -> Result<DedupSet, String> {
    dedup_by_shape(conn, None)
}

/// Date-window variant: only branch sessions created inside the window are evaluated,
/// so large databases do not exhaust the per-request budget on narrow date filters.
/// Candidate/source evidence remains unrestricted.
pub fn dedup_for_window(conn: &Connection, start_ms: i64, end_ms: i64) -> Result<DedupSet, String> {
    dedup_by_shape(conn, Some((start_ms, end_ms)))
}

/// 按库形态分流到 v1 / v2 归因。
fn dedup_by_shape(conn: &Connection, window: Option<(i64, i64)>) -> Result<DedupSet, String> {
    if is_v2_schema(conn) {
        return match window {
            Some((start, end)) => dedup_v2_for_window(conn, start, end),
            None => dedup_v2(conn),
        };
    }
    cached(conn, window, Flavor::Legacy, || dedup_impl(conn, window))
}

/// v2 分叉去重（全量）：`session_v2` / `session_message` 口径。
///
/// 与 [`dedup`] 相同的语义，但显式指定 v2 口径（混合库里旧表独有会话仍按
/// v1 方言处理）。
pub fn dedup_v2(conn: &Connection) -> Result<DedupSet, String> {
    cached(conn, None, Flavor::V2, || dedup_v2_impl(conn, None))
}

/// v2 分叉去重（时间窗口）。
pub fn dedup_v2_for_window(
    conn: &Connection,
    start_ms: i64,
    end_ms: i64,
) -> Result<DedupSet, String> {
    cached(conn, Some((start_ms, end_ms)), Flavor::V2, || {
        dedup_v2_impl(conn, Some((start_ms, end_ms)))
    })
}

/// 缓存包装：同一路径 + 同一窗口 + 同一代次 + 同一口径的结果复用 5 秒。
///
/// 并发请求同 key 时做单飞：先拿槽位锁的请求负责计算，其余请求等待后
/// 直接读缓存；TTL 与失效（代次）语义保持不变。
fn cached(
    conn: &Connection,
    window: Option<(i64, i64)>,
    flavor: Flavor,
    compute: impl FnOnce() -> Result<DedupSet, String>,
) -> Result<DedupSet, String> {
    let Some(path) = conn
        .path()
        .and_then(|path| std::path::Path::new(path).canonicalize().ok())
        .map(|path| path.to_string_lossy().into_owned())
    else {
        return compute();
    };
    let current_generation = cache_generation();
    let key = (path, window, current_generation, flavor);

    if let Ok(guard) = cache().lock() {
        if let Some(entry) = guard.get(&key) {
            if entry.created_at.elapsed() <= Duration::from_secs(5) {
                return Ok(entry.value.clone());
            }
        }
    }

    let flight = {
        let mut map = flights()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // 只保留当前代次的槽位，避免写操作后无限增长。
        map.retain(|(_, _, gen, _), _| *gen == current_generation);
        map.entry(key.clone())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };
    let _flight_guard = flight
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    // 等锁期间可能有别的请求已经算完并写入缓存。
    if let Ok(guard) = cache().lock() {
        if let Some(entry) = guard.get(&key) {
            if entry.created_at.elapsed() <= Duration::from_secs(5) {
                return Ok(entry.value.clone());
            }
        }
    }

    let value = compute()?;
    if let Ok(mut guard) = cache().lock() {
        guard.insert(
            key,
            CacheEntry {
                created_at: Instant::now(),
                value: value.clone(),
            },
        );
    }
    Ok(value)
}

/// 当前连接是否为 v2 形态（只查 `main.sqlite_master`，不读业务数据）。
fn is_v2_schema(conn: &Connection) -> bool {
    crate::schema::detect_mode(conn)
        .map(|mode| mode.is_v2())
        .unwrap_or(false)
}

fn dedup_impl(conn: &Connection, branch_window: Option<(i64, i64)>) -> Result<DedupSet, String> {
    let mut budget = Budget {
        candidates: 0,
        rows: 0,
        digests: 0,
        exhausted: false,
    };
    let mut result = DedupSet::default();
    let mut stmt = conn
        .prepare(
            "SELECT id, directory, project_id, time_created FROM session ORDER BY time_created, id",
        )
        .map_err(|e| e.to_string())?;
    let mut branches = stmt.query([]).map_err(|e| e.to_string())?;

    while let Some(row) = branches.next().map_err(|e| e.to_string())? {
        let branch = session_meta(row)?;
        if let Some((start, end)) = branch_window {
            if branch.created < start || branch.created > end {
                continue;
            }
        }
        if branch.directory.is_empty() || branch.project_id.is_empty() {
            continue;
        }
        let source_id = match only_eligible_candidate(conn, &branch, &mut budget)? {
            CandidateDiscovery::None => continue,
            CandidateDiscovery::One(id) => id,
            CandidateDiscovery::Multiple => {
                return Ok(if budget.exhausted {
                    DedupSet {
                        exhausted: true,
                        ..DedupSet::default()
                    }
                } else {
                    DedupSet::default()
                });
            }
        };
        let Some(branch_tx) = load_transcript(conn, &branch.id, &mut budget)? else {
            return Ok(if budget.exhausted {
                DedupSet {
                    exhausted: true,
                    ..DedupSet::default()
                }
            } else {
                DedupSet::default()
            });
        };
        let Some(source) = load_transcript(conn, &source_id, &mut budget)? else {
            return Ok(if budget.exhausted {
                DedupSet {
                    exhausted: true,
                    ..DedupSet::default()
                }
            } else {
                DedupSet::default()
            });
        };
        if let Some(prefix) = shared_prefix(&source, &branch_tx) {
            for message in branch_tx.messages.iter().take(prefix) {
                result.hidden_messages.insert(message.id.clone());
                result.hidden_parts.extend(message.part_ids.iter().cloned());
            }
            if prefix == branch_tx.messages.len() {
                result.hidden_sessions.insert(branch.id.clone());
            }
        }
    }
    Ok(result)
}

fn session_meta(row: &rusqlite::Row<'_>) -> Result<SessionMeta, String> {
    Ok(SessionMeta {
        id: row.get(0).map_err(|e| e.to_string())?,
        directory: row
            .get::<_, Option<String>>(1)
            .map_err(|e| e.to_string())?
            .unwrap_or_default(),
        project_id: row
            .get::<_, Option<String>>(2)
            .map_err(|e| e.to_string())?
            .unwrap_or_default(),
        created: row.get(3).map_err(|e| e.to_string())?,
    })
}

// ─── v2 口径（TASK-027 ~ TASK-029）───────────────────────────────────────

/// v2 会话的一行元信息。
///
/// `is_v2` 表示该会话在 `session_v2` 里（消息读 `session_message`）；
/// `false` 表示混合库里「只存在于旧表」的会话（消息仍读 `message` / `part`）。
#[derive(Debug, Clone)]
struct V2SessionMeta {
    id: String,
    directory: String,
    project_id: String,
    created: i64,
    fork_session_id: Option<String>,
    is_v2: bool,
}

/// v2 会话清单 SQL（v2-only 收口：只列 `session_v2`）。
///
/// 直接查主表而不是 TEMP VIEW，避免「连接不是经 `db::open` 建立」时视图缺失
/// 导致口径漂移。迁移后留在旧表里的冻结副本（legacy-only / 尾消息）不再是
/// OpenCode-W 的归因对象。
const V2_SESSION_SQL_NO_LEGACY: &str = "SELECT * FROM (
  SELECT v.id AS id,
         v.directory AS directory,
         v.project_id AS project_id,
         v.time_created AS time_created,
         v.time_updated AS time_updated,
         v.fork_session_id AS fork_session_id,
         1 AS is_v2
  FROM main.session_v2 v
) ORDER BY time_created, id";

/// v2 分叉去重主流程。
///
/// 规则（实施计划 TASK-027 ~ TASK-029）：
///
/// 1. **原生分叉**（`session_v2.fork_session_id IS NOT NULL`）：继承前缀按
///    `session_message.time_created < session_v2.time_created` 判定并隐藏，
///    命中即**跳过指纹扫描**（原生分叉不需要比对内容）。
/// 2. **迁移会话**（没有 `fork_session_id`）：沿用 v1 的指纹去重，但指纹输入
///    换成 `compat` 映射后的消息 / 内容块，合成 ID 稳定。
/// 3. 候选发现、共享前缀判定、预算与「超预算整次回退」语义与 v1 一致。
fn dedup_v2_impl(
    conn: &Connection,
    branch_window: Option<(i64, i64)>,
) -> Result<DedupSet, String> {
    if !crate::compat::table_exists(conn, "session_v2").map_err(|e| e.to_string())? {
        // 没有 `session_v2` 就没有 v2 数据可归因，交回调用方按 v1 处理。
        return Ok(DedupSet::default());
    }

    let mut budget = Budget {
        candidates: 0,
        rows: 0,
        digests: 0,
        exhausted: false,
    };
    let mut result = DedupSet::default();

    let sql = V2_SESSION_SQL_NO_LEGACY;

    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let mut branches = stmt.query([]).map_err(|e| e.to_string())?;

    while let Some(row) = branches.next().map_err(|e| e.to_string())? {
        let branch = v2_session_meta(row)?;
        if let Some((start, end)) = branch_window {
            if branch.created < start || branch.created > end {
                continue;
            }
        }
        if branch.fork_session_id.is_some() {
            // 原生分叉：按创建时间切分继承前缀，跳过指纹扫描。
            if let Some(fallback) = hide_inherited_prefix(conn, &branch, &mut budget, &mut result)? {
                return Ok(fallback);
            }
            continue;
        }
        if branch.directory.is_empty() || branch.project_id.is_empty() {
            continue;
        }
        let source_id = match only_eligible_candidate_v2(conn, &branch, &mut budget)? {
            CandidateDiscovery::None => continue,
            CandidateDiscovery::Multiple => {
                return Ok(if budget.exhausted {
                    DedupSet {
                        exhausted: true,
                        ..DedupSet::default()
                    }
                } else {
                    DedupSet::default()
                });
            }
            CandidateDiscovery::One(id) => id,
        };
        let (branch_tx, source) = if branch.is_v2 {
            (
                load_transcript_v2(conn, &branch.id, &mut budget)?,
                load_transcript_v2(conn, &source_id, &mut budget)?,
            )
        } else {
            (
                load_transcript(conn, &branch.id, &mut budget)?,
                load_transcript(conn, &source_id, &mut budget)?,
            )
        };
        let (Some(branch_tx), Some(source)) = (branch_tx, source) else {
            return Ok(if budget.exhausted {
                DedupSet {
                    exhausted: true,
                    ..DedupSet::default()
                }
            } else {
                DedupSet::default()
            });
        };
        if let Some(prefix) = shared_prefix(&source, &branch_tx) {
            for message in branch_tx.messages.iter().take(prefix) {
                result.hidden_messages.insert(message.id.clone());
            }
            if prefix == branch_tx.messages.len() {
                result.hidden_sessions.insert(branch.id.clone());
            }
        }
    }
    Ok(result)
}

fn v2_session_meta(row: &rusqlite::Row<'_>) -> Result<V2SessionMeta, String> {
    Ok(V2SessionMeta {
        id: row.get(0).map_err(|e| e.to_string())?,
        directory: row
            .get::<_, Option<String>>(1)
            .map_err(|e| e.to_string())?
            .unwrap_or_default(),
        project_id: row
            .get::<_, Option<String>>(2)
            .map_err(|e| e.to_string())?
            .unwrap_or_default(),
        created: row.get(3).map_err(|e| e.to_string())?,
        fork_session_id: row
            .get::<_, Option<String>>(5)
            .map_err(|e| e.to_string())?
            .filter(|id| !id.trim().is_empty()),
        is_v2: row.get::<_, i64>(6).map_err(|e| e.to_string())? != 0,
    })
}

/// 原生分叉的继承前缀：`session_message.time_created < session.time_created`。
///
/// 返回 `Some(DedupSet)` 表示预算耗尽、需要整次回退（与 v1 的 fail-closed 一致）。
fn hide_inherited_prefix(
    conn: &Connection,
    branch: &V2SessionMeta,
    budget: &mut Budget,
    result: &mut DedupSet,
) -> Result<Option<DedupSet>, String> {
    let mut stmt = conn
        .prepare("SELECT id FROM session_message WHERE session_id = ?1 AND time_created < ?2 ORDER BY time_created, id")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query(rusqlite::params![branch.id, branch.created])
        .map_err(|e| e.to_string())?;
    let mut inherited = 0i64;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        if !budget.spend_row() {
            budget.exhausted = true;
            return Ok(Some(DedupSet {
                exhausted: true,
                ..DedupSet::default()
            }));
        }
        let id: String = row.get(0).map_err(|e| e.to_string())?;
        result.hidden_messages.insert(id);
        inherited += 1;
    }
    // 全部消息都是继承来的 → 整个会话都是副本，会话本身也隐藏。
    let total: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM session_message WHERE session_id = ?1",
            rusqlite::params![branch.id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if total > 0 && inherited == total {
        result.hidden_sessions.insert(branch.id.clone());
    }
    Ok(None)
}

/// v2 候选发现：同一目录 + 同一项目 + 更早的最后更新时间，且**同一方言**。
///
/// 跨方言（v2 会话 vs 旧表独有会话）的消息结构不同，指纹不可能相等，
/// 因此候选只在同方言集合里找。
fn only_eligible_candidate_v2(
    conn: &Connection,
    branch: &V2SessionMeta,
    budget: &mut Budget,
) -> Result<CandidateDiscovery, String> {
    let sql = if branch.is_v2 {
        "SELECT id FROM main.session_v2
         WHERE id != ?1 AND directory = ?2 AND project_id = ?3 AND time_updated < ?4
         ORDER BY time_created, id
         LIMIT 2"
    } else {
        "SELECT o.id FROM main.session o
         WHERE NOT EXISTS (SELECT 1 FROM main.session_v2 v WHERE v.id = o.id)
           AND o.id != ?1 AND o.directory = ?2 AND o.project_id = ?3 AND o.time_updated < ?4
         ORDER BY o.time_created, o.id
         LIMIT 2"
    };
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let mut candidates = stmt
        .query(rusqlite::params![
            branch.id,
            branch.directory,
            branch.project_id,
            branch.created
        ])
        .map_err(|e| e.to_string())?;
    let Some(candidate) = candidates.next().map_err(|e| e.to_string())? else {
        return Ok(CandidateDiscovery::None);
    };
    if !budget.spend_candidate() {
        return Ok(CandidateDiscovery::Multiple);
    }
    let candidate_id: String = candidate.get(0).map_err(|e| e.to_string())?;
    if candidates.next().map_err(|e| e.to_string())?.is_some() {
        if !budget.spend_candidate() {
            budget.exhausted = true;
        }
        return Ok(CandidateDiscovery::Multiple);
    }
    Ok(CandidateDiscovery::One(candidate_id))
}

/// v2 会话的消息指纹。
///
/// 指纹输入 = `compat` 映射后的消息与内容块：
///
/// - 角色来自 `session_message.type`（与 `compat::messages` 的 CASE 一致）；
/// - 消息体是 `data` JSON 原文；
/// - 内容块用 `compat::parts::map_message` 的映射结果，**去掉 id / message_id /
///   session_id**（合成 ID 含消息 id，源会话与分支会话不同，必须排除）。
fn load_transcript_v2(
    conn: &Connection,
    session_id: &str,
    budget: &mut Budget,
) -> Result<Option<Transcript>, String> {
    let mut stmt = conn
        .prepare("SELECT id, type, data FROM session_message WHERE session_id = ?1 ORDER BY time_created, id")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([session_id]).map_err(|e| e.to_string())?;

    let mut messages = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        if !budget.spend_row() {
            return Ok(None);
        }
        let message_id: String = row.get(0).map_err(|e| e.to_string())?;
        let message_type: String = row.get(1).map_err(|e| e.to_string())?;
        let raw: String = row.get(2).map_err(|e| e.to_string())?;
        let data: Value = match serde_json::from_str(&raw) {
            Ok(data) => data,
            Err(_) => return Ok(None),
        };
        let role = v2_role(&message_type);

        let parts = crate::compat::parts::map_message(&message_id, session_id, &message_type, &data);
        let mut part_digests = Vec::new();
        for part in &parts {
            if !budget.spend_row() || !budget.spend_digest() {
                return Ok(None);
            }
            part_digests.push(Value::String(hex::encode(digest_json(&part_fingerprint(part)?))));
        }
        // v2 的空消息（idle / 事件类消息没有内容块）是合法的，不按 v1 的
        // 「没有 part 即视为损坏」处理，否则整轮归因会直接失败。
        let digest = digest_json(&Value::Array(vec![
            Value::String(role.clone()),
            data,
            Value::Array(part_digests),
        ]));
        messages.push(Message {
            id: message_id,
            role,
            digest,
            part_ids: parts.into_iter().map(|part| part.id).collect(),
        });
    }
    Ok(Some(Transcript { messages }))
}

/// `session_message.type` → 统计口径里的角色。
///
/// 与 `compat::messages` 的 `CASE` 保持一致：user / assistant 保留，其余
/// （system / synthetic / compaction / idle / 切换事件 / 未来新增类型）
/// 一律折叠为 `system`（E-15：默认安全）。
fn v2_role(message_type: &str) -> String {
    match message_type {
        "user" => String::from("user"),
        "assistant" => String::from("assistant"),
        _ => String::from("system"),
    }
}

/// 内容块指纹：去掉身份字段后的映射结果。
///
/// `compat::parts` 生成的合成 ID 含消息 id（`<message_id>:<6 位序号>`），
/// 源会话与分支会话的消息 id 不同，因此 id / message_id / session_id
/// 三个字段不参与指纹，否则相同内容永远匹配不上。
fn part_fingerprint(part: &crate::commands::messages::PartDTOOut) -> Result<Value, String> {
    let mut value = serde_json::to_value(part).map_err(|e| e.to_string())?;
    if let Some(map) = value.as_object_mut() {
        map.remove("id");
        map.remove("message_id");
        map.remove("session_id");
    }
    Ok(value)
}

enum CandidateDiscovery {
    None,
    One(String),
    Multiple,
}

fn only_eligible_candidate(
    conn: &Connection,
    branch: &SessionMeta,
    budget: &mut Budget,
) -> Result<CandidateDiscovery, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id FROM session
             WHERE id != ?1 AND directory = ?2 AND project_id = ?3 AND time_updated < ?4
             ORDER BY time_created, id
             LIMIT 2",
        )
        .map_err(|e| e.to_string())?;
    let mut candidates = stmt
        .query(rusqlite::params![
            branch.id,
            branch.directory,
            branch.project_id,
            branch.created
        ])
        .map_err(|e| e.to_string())?;
    let Some(candidate) = candidates.next().map_err(|e| e.to_string())? else {
        return Ok(CandidateDiscovery::None);
    };
    if !budget.spend_candidate() {
        return Ok(CandidateDiscovery::Multiple);
    }
    let candidate_id: String = candidate.get(0).map_err(|e| e.to_string())?;
    if candidates.next().map_err(|e| e.to_string())?.is_some() {
        if !budget.spend_candidate() {
            budget.exhausted = true;
        }
        return Ok(CandidateDiscovery::Multiple);
    }
    Ok(CandidateDiscovery::One(candidate_id))
}

fn load_transcript(
    conn: &Connection,
    session_id: &str,
    budget: &mut Budget,
) -> Result<Option<Transcript>, String> {
    let invalid_part_reference: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM part p LEFT JOIN message m ON m.id = p.message_id WHERE p.session_id = ? AND (m.id IS NULL OR m.session_id != p.session_id))",
        [session_id],
        |row| row.get(0),
    ).map_err(|e| e.to_string())?;
    if invalid_part_reference {
        return Ok(None);
    }
    let mut stmt = conn
        .prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([session_id]).map_err(|e| e.to_string())?;

    let mut messages = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        if !budget.spend_row() {
            return Ok(None);
        }
        let message_id: String = row.get(0).map_err(|e| e.to_string())?;
        let raw: String = row.get(1).map_err(|e| e.to_string())?;
        let data: Value = match serde_json::from_str(&raw) {
            Ok(data) => data,
            Err(_) => return Ok(None),
        };
        let role = match data.get("role").and_then(Value::as_str) {
            Some(role) => role.to_string(),
            None => return Ok(None),
        };

        let mut part_stmt = conn
            .prepare("SELECT id, session_id, data FROM part WHERE message_id = ? ORDER BY time_created, id")
            .map_err(|e| e.to_string())?;
        let mut parts = part_stmt.query([&message_id]).map_err(|e| e.to_string())?;
        let mut part_ids = Vec::new();
        let mut part_digests = Vec::new();
        while let Some(part) = parts.next().map_err(|e| e.to_string())? {
            if !budget.spend_row() || !budget.spend_digest() {
                return Ok(None);
            }
            let part_id: String = part.get(0).map_err(|e| e.to_string())?;
            let part_session_id: String = part.get(1).map_err(|e| e.to_string())?;
            let part_raw: String = part.get(2).map_err(|e| e.to_string())?;
            if part_session_id != session_id {
                return Ok(None);
            }
            let part_data: Value = match serde_json::from_str(&part_raw) {
                Ok(data) => data,
                Err(_) => return Ok(None),
            };
            part_ids.push(part_id);
            part_digests.push(digest_json(&part_data));
        }
        if part_ids.is_empty() || !budget.spend_digest() {
            return Ok(None);
        }
        let digest = digest_json(&Value::Array(vec![
            Value::String(role.clone()),
            data,
            Value::Array(
                part_digests
                    .into_iter()
                    .map(|d| Value::String(hex::encode(d)))
                    .collect(),
            ),
        ]));
        messages.push(Message {
            id: message_id,
            role,
            digest,
            part_ids,
        });
    }
    Ok(Some(Transcript { messages }))
}

fn shared_prefix(source: &Transcript, branch: &Transcript) -> Option<usize> {
    if source.messages.len() > branch.messages.len() {
        return None;
    }
    let length = source
        .messages
        .iter()
        .zip(&branch.messages)
        .take_while(|(source, branch)| source.digest == branch.digest)
        .count();
    let shared = &branch.messages[..length];
    let parts = shared.iter().map(|m| m.part_ids.len()).sum::<usize>();
    let user = shared.iter().any(|m| m.role == "user");
    let non_user = shared.iter().any(|m| m.role != "user");
    (length >= 2 && parts >= 3 && user && non_user).then_some(length)
}

fn digest_json(value: &Value) -> [u8; 32] {
    let encoded = serde_json::to_vec(&canonical(value)).unwrap_or_default();
    Sha256::digest(encoded).into()
}

fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, value)| (key.clone(), canonical(value)))
                .collect::<BTreeMap<_, _>>()
                .into_iter()
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.iter().map(canonical).collect()),
        _ => value.clone(),
    }
}

/// 串行化「会推进 fork 缓存 generation」的测试。
///
/// `db::open` / `db::close` 会调用 `invalidate_cache()`，而缓存 generation 是
/// 进程级共享的；缓存相关测试必须在同一把锁下运行，否则一次失效可能落在
/// `dedup` 与断言之间。整段都在 `cfg(test)` 内，不进入 release 产物。
#[cfg(test)]
pub(crate) fn test_serial_guard() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema(conn: &Connection) {
        conn.execute_batch(
            "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, project_id TEXT, time_created INTEGER, time_updated INTEGER);
             CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER);
             CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, data TEXT, time_created INTEGER);",
        )
        .unwrap();
    }

    fn insert_session(conn: &Connection, id: &str, created: i64, updated: i64) {
        conn.execute(
            "INSERT INTO session VALUES (?1, '/p', 'p', ?2, ?3)",
            rusqlite::params![id, created, updated],
        )
        .unwrap();
    }

    fn insert_message(conn: &Connection, id: &str, session: &str, role: &str, time: i64) {
        conn.execute(
            "INSERT INTO message VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![
                id,
                session,
                serde_json::json!({"role": role}).to_string(),
                time
            ],
        )
        .unwrap();
    }

    fn insert_part(conn: &Connection, id: &str, session: &str, message: &str, time: i64) {
        conn.execute(
            "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                id,
                session,
                message,
                serde_json::json!({"type": "text", "n": time}).to_string(),
                time
            ],
        )
        .unwrap();
    }

    fn fork_pair(conn: &Connection) {
        insert_session(conn, "source", 1, 10);
        insert_session(conn, "branch", 20, 20);
        for session in ["source", "branch"] {
            insert_message(conn, &format!("{session}-m1"), session, "user", 1);
            insert_message(conn, &format!("{session}-m2"), session, "assistant", 2);
            insert_part(
                conn,
                &format!("{session}-p1"),
                session,
                &format!("{session}-m1"),
                1,
            );
            insert_part(
                conn,
                &format!("{session}-p2"),
                session,
                &format!("{session}-m2"),
                2,
            );
            insert_part(
                conn,
                &format!("{session}-p3"),
                session,
                &format!("{session}-m2"),
                3,
            );
        }
    }

    fn file_connection() -> (Connection, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "opencode-fork-stats-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        (Connection::open(&path).unwrap(), path)
    }

    #[test]
    fn hides_an_exact_fork_clone_branch() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        fork_pair(&conn);

        let result = dedup(&conn).unwrap();

        assert!(result.hidden_sessions.contains("branch"));
        assert_eq!(result.hidden_messages.len(), 2);
        assert_eq!(result.hidden_parts.len(), 3);
        assert!(!result.hidden_sessions.contains("source"));
        assert!(!result.exhausted);
    }

    #[test]
    fn keeps_a_divergent_branch_with_only_its_shared_prefix_hidden() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        fork_pair(&conn);
        insert_message(&conn, "branch-m3", "branch", "assistant", 3);
        insert_part(&conn, "branch-p4", "branch", "branch-m3", 4);

        let result = dedup(&conn).unwrap();

        assert!(!result.hidden_sessions.contains("branch"));
        assert!(result.hidden_messages.contains("branch-m1"));
        assert!(result.hidden_messages.contains("branch-m2"));
        assert!(!result.hidden_messages.contains("branch-m3"));
        assert!(!result.hidden_parts.contains("branch-p4"));
    }

    #[test]
    fn malformed_or_orphan_evidence_fails_closed() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        fork_pair(&conn);
        conn.execute("UPDATE part SET data = '{' WHERE id = 'branch-p1'", [])
            .unwrap();
        assert_eq!(dedup(&conn).unwrap(), DedupSet::default());

        conn.execute(
            "UPDATE part SET data = ? WHERE id = 'branch-p1'",
            [serde_json::json!({"type": "text", "n": 1}).to_string()],
        )
        .unwrap();
        conn.execute(
            "UPDATE part SET message_id = 'missing' WHERE id = 'branch-p1'",
            [],
        )
        .unwrap();
        assert_eq!(dedup(&conn).unwrap(), DedupSet::default());
    }

    #[test]
    fn multiple_candidates_fail_closed() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        fork_pair(&conn);
        insert_session(&conn, "source-two", 2, 11);
        for (message, role, time) in [("m1", "user", 1), ("m2", "assistant", 2)] {
            insert_message(
                &conn,
                &format!("source-two-{message}"),
                "source-two",
                role,
                time,
            );
        }
        insert_part(&conn, "source-two-p1", "source-two", "source-two-m1", 1);
        insert_part(&conn, "source-two-p2", "source-two", "source-two-m2", 2);
        insert_part(&conn, "source-two-p3", "source-two", "source-two-m2", 3);
        assert_eq!(dedup(&conn).unwrap(), DedupSet::default());
    }

    #[test]
    fn a_matching_and_a_nonmatching_candidate_fail_closed() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        fork_pair(&conn);
        insert_session(&conn, "source-two", 2, 11);
        insert_message(&conn, "source-two-m1", "source-two", "user", 1);
        insert_part(&conn, "source-two-p1", "source-two", "source-two-m1", 1);

        assert_eq!(dedup(&conn).unwrap(), DedupSet::default());
    }

    #[test]
    fn cross_session_part_evidence_fails_closed() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        fork_pair(&conn);
        conn.execute(
            "UPDATE part SET session_id = 'source' WHERE id = 'branch-p1'",
            [],
        )
        .unwrap();

        assert_eq!(dedup(&conn).unwrap(), DedupSet::default());
    }

    #[test]
    fn max_digests_exhaustion_fails_closed() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        insert_session(&conn, "session", 1, 1);
        insert_message(&conn, "message", "session", "user", 1);
        insert_part(&conn, "part", "session", "message", 1);
        let mut budget = Budget {
            candidates: 0,
            rows: 0,
            digests: MAX_DIGESTS,
            exhausted: false,
        };

        assert!(load_transcript(&conn, "session", &mut budget)
            .unwrap()
            .is_none());
        assert!(budget.exhausted);
    }

    #[test]
    fn exhausted_budget_returns_no_partial_attribution() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        fork_pair(&conn);
        for index in 0..MAX_ROWS {
            insert_message(
                &conn,
                &format!("extra-{index}"),
                "branch",
                "assistant",
                100 + index as i64,
            );
            insert_part(
                &conn,
                &format!("extra-part-{index}"),
                "branch",
                &format!("extra-{index}"),
                100 + index as i64,
            );
        }
        let result = dedup(&conn).unwrap();
        assert!(result.exhausted);
        assert!(result.hidden_sessions.is_empty());
        assert!(result.hidden_messages.is_empty());
        assert!(result.hidden_parts.is_empty());
    }

    #[test]
    fn cache_returns_a_snapshot_until_invalidated() {
        let _lock = super::test_serial_guard();
        let (conn, path) = file_connection();
        schema(&conn);
        fork_pair(&conn);
        invalidate_cache();
        let first = dedup(&conn).unwrap();
        conn.execute("DELETE FROM part WHERE id = 'branch-p1'", [])
            .unwrap();
        assert_eq!(dedup(&conn).unwrap(), first);
        invalidate_cache();
        assert_eq!(dedup(&conn).unwrap(), DedupSet::default());
        drop(conn);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn cache_entry_expires_after_five_seconds() {
        let _lock = super::test_serial_guard();
        let (conn, path) = file_connection();
        schema(&conn);
        fork_pair(&conn);
        let first = dedup(&conn).unwrap();
        conn.execute("DELETE FROM part WHERE id = 'branch-p1'", [])
            .unwrap();
        let cache_path = std::path::Path::new(conn.path().unwrap())
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let cache_generation = generation().load(std::sync::atomic::Ordering::Acquire);
        if let Ok(mut entry) = cache().lock() {
            entry
                .get_mut(&(cache_path, None, cache_generation, super::Flavor::Legacy))
                .unwrap()
                .created_at = Instant::now() - Duration::from_secs(6);
        }
        assert_ne!(dedup(&conn).unwrap(), first);
        drop(conn);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn keeps_everything_when_no_temporal_separation_exists() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        fork_pair(&conn);
        conn.execute(
            "UPDATE session SET time_updated = 30 WHERE id = 'source'",
            [],
        )
        .unwrap();

        let result = dedup(&conn).unwrap();

        assert!(result.hidden_sessions.is_empty());
        assert!(result.hidden_messages.is_empty());
        assert!(result.hidden_parts.is_empty());
    }

    #[test]
    fn window_only_evaluates_branches_created_inside_the_range() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        fork_pair(&conn);

        let inside = dedup_for_window(&conn, 15, 30).unwrap();
        assert!(inside.hidden_sessions.contains("branch"));
        assert_eq!(inside.hidden_parts.len(), 3);

        let outside = dedup_for_window(&conn, 25, 40).unwrap();
        assert!(outside.hidden_sessions.is_empty());
        assert!(outside.hidden_parts.is_empty());
    }
}

// ─── v2 口径的测试（TASK-027 ~ TASK-029）────────────────────────────────

#[cfg(test)]
mod v2_tests {
    use super::*;
    use crate::compat::test_support::v2_fresh;

    fn insert_v2_session(
        conn: &Connection,
        id: &str,
        directory: &str,
        project: &str,
        created: i64,
        updated: i64,
        fork: Option<&str>,
    ) {
        conn.execute(
            "INSERT INTO session_v2
                (id, project_id, parent_id, fork_session_id, slug, directory, title, version, time_created, time_updated)
             VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?4, '2.1.2', ?6, ?7)",
            rusqlite::params![
                id,
                project,
                fork,
                format!("slug-{id}"),
                directory,
                created,
                updated
            ],
        )
        .unwrap();
    }

    fn insert_v2_message(
        conn: &Connection,
        id: &str,
        session: &str,
        kind: &str,
        seq: i64,
        created: i64,
        data: &str,
    ) {
        conn.execute(
            "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)",
            rusqlite::params![id, session, kind, seq, created, data],
        )
        .unwrap();
    }

    const USER_DATA: &str = r#"{"text":"同样的问题","time":{"created":1100}}"#;
    const ASSISTANT_DATA: &str = r#"{"content":[{"type":"text","text":"同样的回答"}],"finish":"stop","tokens":{"input":10,"output":2,"reasoning":0,"cache":{"read":0,"write":0}},"cost":0.001,"time":{"created":1200}}"#;

    /// 迁移会话（无 `fork_session_id`）应继续走指纹去重。
    #[test]
    fn migrated_session_without_fork_id_uses_fingerprint_dedup() {
        let conn = v2_fresh();
        insert_v2_session(&conn, "source", "/p", "proj", 1000, 1500, None);
        insert_v2_session(&conn, "branch", "/p", "proj", 2000, 2000, None);
        insert_v2_message(&conn, "src-m1", "source", "user", 0, 1100, USER_DATA);
        insert_v2_message(&conn, "src-m2", "source", "assistant", 1, 1200, ASSISTANT_DATA);
        insert_v2_message(&conn, "branch-m1", "branch", "user", 0, 1100, USER_DATA);
        insert_v2_message(&conn, "branch-m2", "branch", "assistant", 1, 1200, ASSISTANT_DATA);

        let result = dedup_v2(&conn).unwrap();

        assert!(
            result.hidden_messages.contains("branch-m1"),
            "复制前缀的消息应隐藏：{:?}",
            result.hidden_messages
        );
        assert!(result.hidden_messages.contains("branch-m2"));
        assert!(
            result.hidden_sessions.contains("branch"),
            "全部消息都是副本时应整体隐藏"
        );
        assert!(!result.hidden_sessions.contains("source"), "源会话不得隐藏");
    }

    /// 分叉后新增的消息不该被隐藏。
    #[test]
    fn divergent_branch_only_hides_the_shared_prefix() {
        let conn = v2_fresh();
        insert_v2_session(&conn, "source", "/p", "proj", 1000, 1500, None);
        insert_v2_session(&conn, "branch", "/p", "proj", 2000, 2000, None);
        insert_v2_message(&conn, "src-m1", "source", "user", 0, 1100, USER_DATA);
        insert_v2_message(&conn, "src-m2", "source", "assistant", 1, 1200, ASSISTANT_DATA);
        insert_v2_message(&conn, "branch-m1", "branch", "user", 0, 1100, USER_DATA);
        insert_v2_message(&conn, "branch-m2", "branch", "assistant", 1, 1200, ASSISTANT_DATA);
        insert_v2_message(
            &conn,
            "branch-m3",
            "branch",
            "assistant",
            2,
            1300,
            r#"{"content":[{"type":"text","text":"新的分支内容"}],"finish":"stop","time":{"created":1300}}"#,
        );

        let result = dedup_v2(&conn).unwrap();

        assert!(result.hidden_messages.contains("branch-m1"));
        assert!(result.hidden_messages.contains("branch-m2"));
        assert!(
            !result.hidden_messages.contains("branch-m3"),
            "分叉后的新消息不应隐藏"
        );
        assert!(!result.hidden_sessions.contains("branch"));
    }

    /// 原生分叉：按 `time_created < session.time_created` 隐藏继承前缀。
    #[test]
    fn native_fork_hides_only_messages_created_before_the_session() {
        let conn = v2_fresh();
        insert_v2_session(&conn, "parent", "/p", "proj", 1000, 1000, None);
        insert_v2_session(&conn, "child", "/p", "proj", 2000, 2000, Some("parent"));
        insert_v2_message(&conn, "child-m1", "child", "user", 0, 1500, USER_DATA);
        insert_v2_message(
            &conn,
            "child-m2",
            "child",
            "assistant",
            1,
            2500,
            r#"{"content":[{"type":"text","text":"分叉后的新回答"}],"finish":"stop","time":{"created":2500}}"#,
        );

        let result = dedup_v2(&conn).unwrap();

        assert!(
            result.hidden_messages.contains("child-m1"),
            "继承前缀应隐藏：{:?}",
            result.hidden_messages
        );
        assert!(
            !result.hidden_messages.contains("child-m2"),
            "分叉后自产的消息不应隐藏"
        );
        assert!(
            !result.hidden_sessions.contains("child"),
            "仍有自产消息的会话不应整体隐藏"
        );
    }

    /// 原生分叉且全部消息都是继承来的 → 整个会话都是副本。
    #[test]
    fn native_fork_with_only_inherited_messages_hides_the_session() {
        let conn = v2_fresh();
        insert_v2_session(&conn, "parent", "/p", "proj", 1000, 1000, None);
        insert_v2_session(&conn, "child", "/p", "proj", 2000, 2000, Some("parent"));
        insert_v2_message(&conn, "child-m1", "child", "user", 0, 1500, USER_DATA);
        insert_v2_message(&conn, "child-m2", "child", "assistant", 1, 1600, ASSISTANT_DATA);

        let result = dedup_v2(&conn).unwrap();

        assert_eq!(result.hidden_messages.len(), 2);
        assert!(result.hidden_sessions.contains("child"));
    }

    /// 原生分叉命中即跳过指纹扫描：即使内容与源会话完全一致，
    /// 只要创建时间不早于会话创建时间，就不该被隐藏。
    #[test]
    fn native_fork_skips_the_fingerprint_scan() {
        let conn = v2_fresh();
        insert_v2_session(&conn, "source", "/p", "proj", 1000, 1500, None);
        insert_v2_session(&conn, "child", "/p", "proj", 2000, 2000, Some("source"));
        insert_v2_message(&conn, "src-m1", "source", "user", 0, 1100, USER_DATA);
        insert_v2_message(&conn, "src-m2", "source", "assistant", 1, 1200, ASSISTANT_DATA);
        // 内容与源会话完全一样，但创建时间不早于会话创建时间。
        insert_v2_message(&conn, "child-m1", "child", "user", 0, 2000, USER_DATA);
        insert_v2_message(&conn, "child-m2", "child", "assistant", 1, 2100, ASSISTANT_DATA);

        let result = dedup_v2(&conn).unwrap();

        assert!(
            result.hidden_messages.is_empty(),
            "原生分叉按时间判定，不做指纹比对：{:?}",
            result.hidden_messages
        );
    }

    /// 时间窗口只评估窗口内创建的会话。
    #[test]
    fn v2_window_only_evaluates_sessions_created_inside_the_range() {
        let conn = v2_fresh();
        insert_v2_session(&conn, "parent", "/p", "proj", 1000, 1000, None);
        insert_v2_session(&conn, "child", "/p", "proj", 2000, 2000, Some("parent"));
        insert_v2_message(&conn, "child-m1", "child", "user", 0, 1500, USER_DATA);

        let inside = dedup_v2_for_window(&conn, 1500, 2500).unwrap();
        assert!(inside.hidden_messages.contains("child-m1"));

        let outside = dedup_v2_for_window(&conn, 2500, 3000).unwrap();
        assert!(outside.hidden_messages.is_empty());
    }
}
