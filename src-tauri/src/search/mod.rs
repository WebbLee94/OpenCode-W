//! 外置 FTS5 全文索引（sidecar）。
//!
//! 设计要点（依据 B-10a 性能探针结论）：
//!
//! 1. 索引放在 `app_data_dir/search-index-v1.sqlite`，与 OpenCode 库**完全分离**；
//!    OpenCode 库只用**只读连接**读取，任何情况下都不写入（SEC-001）。
//! 2. 使用 FTS5 `trigram` 分词器：中文子串可召回（`unicode61` 会把整段 CJK
//!    当成一个 token，子串查不到）。trigram 不支持 < 3 字符查询，这类关键词在
//!    查询侧回退到 LIKE（30 天窗口）。
//! 3. 默认只索引 `user` / `assistant` 的**正文**（`$.text` / `content[].text`），
//!    不索引 reasoning 与 tool 输出（占真库 data 的 94%+，体积巨大且噪音多）。
//! 4. 混合库：v2 内容来自 `session_message`；旧表**只补** `session_message`
//!    里不存在的消息（legacy 尾消息 / legacy-only 会话）的 `part` 文本，
//!    避免把 5.4GB 旧 `part` 全量入索引。
//! 5. 构建在后台线程分批进行（2000 行/批），meta 表记录 watermark 与 source
//!    指纹；中断后下次从 watermark 继续；`docs.session_id` 不在会话集合里的
//!    文档会被清理。
//! 6. 索引可随时删除并重建；索引损坏/未就绪时 `search()` 自动回退 LIKE，
//!    不会阻断主流程。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, params_from_iter, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;

use crate::db::DbState;
use crate::models::dto::SearchResult;
use crate::schema::{self, SchemaMode};

/// sidecar 文件名（位于 `app_data_dir`）。
pub const INDEX_FILE_NAME: &str = "search-index-v1.sqlite";

/// 进度事件名（main → renderer）。
pub const EVENT_PROGRESS: &str = "search:index-progress";

/// 分词器与索引格式版本；变更它会让旧索引判为失效并重建。
const TOKENIZER_VERSION: &str = "trigram-v1";
const TOKENIZER: &str = "trigram";

/// 每批处理的行数。
const BATCH_ROWS: i64 = 2000;

/// 单次查询最多返回的结果数（与既有 `messages_search` 一致）。
const MAX_RESULTS: i64 = 100;

/// snippet 最大字符数（含省略号）。
const SNIPPET_CHARS: usize = 200;

/// trigram 分词器要求查询至少 3 个字符。
const TRIGRAM_MIN_CHARS: usize = 3;

/// LIKE 回退的时间窗口：30 天。
pub const FALLBACK_WINDOW_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// 每批之间让出 CPU，避免建索引时把前台拖慢。
const BATCH_PAUSE_MS: u64 = 5;

// ─── 状态 ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum IndexState {
    /// 从未为当前库构建过索引。
    None,
    /// 正在后台构建。
    Building,
    /// 索引可用（且 sidecar 文件存在）。
    Ready,
    /// 构建失败；查询自动回退 LIKE。
    Error,
}

/// `search_index_status` 的返回体。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchIndexStatus {
    pub state: IndexState,
    /// 已处理的消息行数（进度分子/分母都以「消息行」计，不是文档数）。
    pub indexed: i64,
    pub total: i64,
    /// 已索引的最大 `time_created`（毫秒），0 表示尚未建立水位。
    pub watermark: i64,
    pub error: Option<String>,
}

impl SearchIndexStatus {
    fn initial() -> Self {
        SearchIndexStatus {
            state: IndexState::None,
            indexed: 0,
            total: 0,
            watermark: 0,
            error: None,
        }
    }
}

/// 进度事件负载。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexProgress {
    pub indexed: i64,
    pub total: i64,
    pub phase: String,
}

// ─── 进程内状态 ───────────────────────────────────────────────────────────

/// 索引状态（Tauri managed state）。
#[derive(Clone)]
pub struct SearchIndex {
    inner: Arc<Mutex<Runtime>>,
}

struct Runtime {
    status: SearchIndexStatus,
    building: bool,
    sidecar: Option<PathBuf>,
}

impl Default for SearchIndex {
    fn default() -> Self {
        Self::new()
    }
}

impl SearchIndex {
    pub fn new() -> Self {
        SearchIndex {
            inner: Arc::new(Mutex::new(Runtime {
                status: SearchIndexStatus::initial(),
                building: false,
                sidecar: None,
            })),
        }
    }

    fn with<R>(&self, f: impl FnOnce(&mut Runtime) -> R) -> R {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        f(&mut guard)
    }

    pub fn status(&self) -> SearchIndexStatus {
        self.with(|rt| rt.status.clone())
    }

    fn set_sidecar(&self, path: PathBuf) {
        self.with(|rt| rt.sidecar = Some(path));
    }

    /// sidecar 路径：仅当索引就绪且文件存在时返回。
    pub fn ready_sidecar(&self) -> Option<PathBuf> {
        self.with(|rt| {
            if rt.status.state != IndexState::Ready {
                return None;
            }
            rt.sidecar.clone().filter(|path| path.exists())
        })
    }

    /// 抢占构建权；已有构建在跑时返回 `false`。
    fn try_begin(&self) -> bool {
        self.with(|rt| {
            if rt.building {
                return false;
            }
            rt.building = true;
            rt.status = SearchIndexStatus {
                state: IndexState::Building,
                indexed: 0,
                total: rt.status.total,
                watermark: rt.status.watermark,
                error: None,
            };
            true
        })
    }

    fn set_total(&self, total: i64) {
        self.with(|rt| rt.status.total = total);
    }

    fn set_progress(&self, indexed: i64) {
        self.with(|rt| rt.status.indexed = indexed);
    }

    fn finish(&self, watermark: i64, indexed: i64, total: i64) {
        self.with(|rt| {
            rt.building = false;
            rt.status = SearchIndexStatus {
                state: IndexState::Ready,
                indexed,
                total,
                watermark,
                error: None,
            };
        });
    }

    fn fail(&self, message: String) {
        self.with(|rt| {
            rt.building = false;
            rt.status = SearchIndexStatus {
                state: IndexState::Error,
                indexed: rt.status.indexed,
                total: rt.status.total,
                watermark: rt.status.watermark,
                error: Some(message),
            };
        });
    }
}

// ─── 对外入口 ─────────────────────────────────────────────────────────────

/// 解析 sidecar 路径（`app_data_dir/search-index-v1.sqlite`）。
pub fn index_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{}", e))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建应用数据目录：{}", e))?;
    Ok(dir.join(INDEX_FILE_NAME))
}

/// 确保索引已建立（或正在建立），立即返回当前状态。
///
/// 不做任何阻塞工作：建索引全部在后台线程里分批进行。
pub fn ensure(app: &tauri::AppHandle, db: &DbState, index: &SearchIndex) -> SearchIndexStatus {
    if !db.is_open() {
        return index.status();
    }
    let path = match index_path(app) {
        Ok(path) => path,
        Err(e) => {
            log::warn!("{}", e);
            return index.status();
        }
    };
    index.set_sidecar(path.clone());

    if !index.try_begin() {
        return index.status();
    }

    let app_for_thread = app.clone();
    let db_for_thread = db.clone();
    let index_for_thread = index.clone();
    std::thread::spawn(move || {
        let progress = |indexed: i64, total: i64, phase: &str| {
            index_for_thread.set_progress(indexed);
            index_for_thread.set_total(total);
            emit_progress(&app_for_thread, indexed, total, phase);
        };

        match build(&db_for_thread, &index_for_thread, &path, &progress) {
            Ok(outcome) => {
                index_for_thread.finish(outcome.watermark, outcome.indexed, outcome.total);
                progress(outcome.indexed, outcome.total, "done");
            }
            Err(e) => {
                log::warn!("全文索引构建失败，后续查询回退 LIKE：{}", e);
                index_for_thread.fail(e);
            }
        }
    });

    index.status()
}

fn emit_progress(app: &tauri::AppHandle, indexed: i64, total: i64, phase: &str) {
    use tauri::Emitter;
    let payload = IndexProgress {
        indexed,
        total,
        phase: phase.to_string(),
    };
    if let Err(e) = app.emit(EVENT_PROGRESS, payload) {
        log::warn!("无法发送索引进度事件：{}", e);
    }
}

// ─── 查询 ────────────────────────────────────────────────────────────────

/// 搜索入口：索引就绪且关键词 >= 3 字符时走 FTS5，否则回退 LIKE（30 天）。
///
/// 任何索引侧错误都只会 `log::warn` 并回退，不向调用方报错。
pub fn search(conn: &Connection, index: &SearchIndex, keyword: &str) -> Vec<SearchResult> {
    let keyword = keyword.trim();
    if keyword.is_empty() {
        return Vec::new();
    }

    let mode = schema::detect_mode(conn).unwrap_or(SchemaMode::V1);

    if keyword.chars().count() >= TRIGRAM_MIN_CHARS {
        if let Some(sidecar) = index.ready_sidecar() {
            match fts_search(&sidecar, conn, keyword) {
                // ready 状态下 FTS 结果是权威结果（索引已覆盖全部正文），
                // 空结果不再走 LIKE，避免「FTS 没有、LIKE 有」的不一致。
                Ok(rows) => return rows,
                Err(e) => log::warn!("FTS 查询失败，回退 LIKE：{}", e),
            }
        }
    }

    like_fallback(conn, mode, keyword)
}

/// FTS5 查询：MATCH + 按时间倒序取 100 条，snippet 在 Rust 侧截断。
fn fts_search(sidecar: &Path, conn: &Connection, keyword: &str) -> Result<Vec<SearchResult>, String> {
    let side = Connection::open_with_flags(sidecar, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("无法打开搜索索引：{}", e))?;

    // trigram 的 MATCH 参数仍需转义：整体包成短语，内部引号双写。
    let expr = format!("\"{}\"", keyword.replace('"', "\"\""));

    let rows = {
        let mut stmt = side
            .prepare(
                "SELECT d.id, d.session_id, d.time_created, d.body \
                 FROM docs_fts JOIN docs d ON d.rowid = docs_fts.rowid \
                 WHERE docs_fts MATCH ?1 \
                 ORDER BY d.time_created DESC \
                 LIMIT ?2",
            )
            .map_err(|e| format!("搜索索引不可用：{}", e))?;
        let rows = stmt
            .query_map(params![expr, MAX_RESULTS], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| format!("搜索索引查询失败：{}", e))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| format!("搜索索引结果解析失败：{}", e))?;
        rows
    };

    if rows.is_empty() {
        return Ok(Vec::new());
    }

    let titles = session_titles(conn, rows.iter().map(|r| r.1.as_str()))?;

    Ok(rows
        .into_iter()
        .map(|(id, session_id, time_created, body)| SearchResult {
            id,
            content: snippet(&body, keyword),
            session_title: titles.get(&session_id).cloned().unwrap_or_default(),
            session_id,
            time_created,
        })
        .collect())
}

/// 批量取会话标题（走 `session` 视图，v1/v2 通用）。
fn session_titles<'a>(
    conn: &Connection,
    session_ids: impl Iterator<Item = &'a str>,
) -> Result<HashMap<String, String>, String> {
    let ids: Vec<&str> = session_ids.collect();
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let placeholders = std::iter::repeat("?")
        .take(ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!("SELECT id, title FROM session WHERE id IN ({})", placeholders);
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("无法读取会话标题：{}", e))?;
    let rows = stmt
        .query_map(params_from_iter(ids.iter().copied()), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(|e| format!("无法读取会话标题：{}", e))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("无法读取会话标题：{}", e))?;
    Ok(rows
        .into_iter()
        .map(|(id, title)| (id, title.unwrap_or_default()))
        .collect())
}

/// LIKE 回退：限定最近 30 天，按时间倒序取 100 条。
///
/// - v2 形态：查 `session_message`（`$.text` 或 `$.content`）。
/// - v1 形态：沿用旧 `message` 表 SQL（与既有行为一致）。
///
/// 混合库的 legacy-only 会话正文由 sidecar 覆盖（通常 0-1 个，索引在启动后
/// 数秒内可用），因此回退路径不再扫 5.4GB 旧 `part`。
fn like_fallback(conn: &Connection, mode: SchemaMode, keyword: &str) -> Vec<SearchResult> {
    let since = now_ms() - FALLBACK_WINDOW_MS;
    let pattern = format!("%{}%", escape_like(keyword));

    let sql = if mode.is_v2() {
        "SELECT m.id, m.session_id, \
                COALESCE(json_extract(m.data,'$.text'), json_extract(m.data,'$.content')), \
                s.title, m.time_created \
         FROM session_message m \
         JOIN session s ON s.id = m.session_id \
         WHERE m.time_created >= ?2 \
           AND (json_extract(m.data,'$.text') LIKE ?1 ESCAPE '\\' \
                OR json_extract(m.data,'$.content') LIKE ?1 ESCAPE '\\') \
         ORDER BY m.time_created DESC \
         LIMIT ?3"
    } else {
        "SELECT m.id, m.session_id, json_extract(m.data,'$.content'), \
                s.title, m.time_created \
         FROM message m \
         JOIN session s ON s.id = m.session_id \
         WHERE m.time_created >= ?2 \
           AND json_extract(m.data,'$.content') LIKE ?1 ESCAPE '\\' \
         ORDER BY m.time_created DESC \
         LIMIT ?3"
    };

    let rows = (|| -> rusqlite::Result<Vec<_>> {
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt
            .query_map(params![pattern, since, MAX_RESULTS], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })();

    match rows {
        Ok(rows) => rows
            .into_iter()
            .map(|(id, session_id, content, title, time_created)| SearchResult {
                id,
                session_id,
                content: snippet(&content.unwrap_or_default(), keyword),
                session_title: title.unwrap_or_default(),
                time_created,
            })
            .collect(),
        Err(e) => {
            log::warn!("LIKE 回退查询失败：{}", e);
            Vec::new()
        }
    }
}

/// LIKE 通配符转义（配合 `ESCAPE '\'`），避免用户输入 `%` / `_` 变成通配符。
fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// 截取包含关键词的片段，总长不超过 [`SNIPPET_CHARS`] 个字符。
pub fn snippet(body: &str, keyword: &str) -> String {
    let body = body.trim();
    if body.is_empty() {
        return String::new();
    }
    let chars: Vec<char> = body.chars().collect();
    if chars.len() <= SNIPPET_CHARS {
        return body.to_string();
    }

    // 关键词在字符串中的字符位置（忽略大小写）。
    let lower_body: Vec<char> = body.to_lowercase().chars().collect();
    let lower_kw: Vec<char> = keyword.to_lowercase().chars().collect();
    let match_at = if lower_kw.is_empty() || lower_kw.len() > lower_body.len() {
        None
    } else {
        lower_body
            .windows(lower_kw.len())
            .position(|window| window == lower_kw.as_slice())
    };

    // 命中点前留 40 个字符上下文。
    let start = match match_at {
        Some(pos) => pos.saturating_sub(40),
        None => 0,
    };

    // 省略号也算在 200 字预算内。
    let prefix = start > 0;
    let budget = SNIPPET_CHARS.saturating_sub(prefix as usize);
    let mut end = (start + budget).min(chars.len());
    let suffix = end < chars.len();
    if suffix {
        end = end.saturating_sub(1);
    }

    let mut out = String::new();
    if prefix {
        out.push('…');
    }
    out.push_str(chars[start..end].iter().collect::<String>().trim_start());
    if suffix {
        out.push('…');
    }
    out
}

// ─── 构建 ────────────────────────────────────────────────────────────────

pub(crate) struct BuildOutcome {
    pub indexed: i64,
    pub total: i64,
    pub watermark: i64,
}

/// 构建（或增量更新）索引。测试直接调用这个同步版本。
pub(crate) fn build(
    db: &DbState,
    _index: &SearchIndex,
    sidecar: &Path,
    progress: &dyn Fn(i64, i64, &str),
) -> Result<BuildOutcome, String> {
    let db_path = db.path().ok_or_else(|| String::from("没有已连接的数据库"))?;

    // 只读连接：绝不写入 OpenCode 库（SEC-001）。独立连接而不是借池，
    // 避免长时间构建占住连接池。
    let source = Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("无法以只读方式打开数据库：{}", e))?;
    let mode = schema::detect_mode(&source).map_err(|e| format!("无法识别数据库结构：{}", e))?;
    if mode == SchemaMode::Unsupported {
        return Err(String::from("当前数据库结构不受支持，已跳过全文索引"));
    }

    let side = open_sidecar(sidecar)?;

    let stored_path = read_meta(&side, "source_path");
    let stored_mode = read_meta(&side, "schema_mode");
    let stored_tokenizer = read_meta(&side, "tokenizer");
    let stored_watermark = read_meta(&side, "watermark").and_then(|v| v.parse::<i64>().ok());

    let mode_key = mode_key(mode);
    let rebuild = stored_path.as_deref() != Some(db_path.as_str())
        || stored_mode.as_deref() != Some(mode_key)
        || stored_tokenizer.as_deref() != Some(TOKENIZER_VERSION)
        || stored_watermark.is_none();

    let start = if rebuild {
        reset_index(&side)?;
        0
    } else {
        stored_watermark.unwrap_or(0)
    };

    let total = count_pending(&source, mode, start)?;
    progress(0, total, if rebuild { "rebuild" } else { "incremental" });

    let mut indexed = 0i64;
    let mut watermark = start;

    // 1) v2 正文：user.text + assistant content[].text
    if mode.is_v2() {
        let mut cursor: Cursor = (start, String::new());
        loop {
            let batch = fetch_v2_batch(&source, &cursor)?;
            if batch.is_empty() {
                break;
            }
            cursor = (
                batch[batch.len() - 1].3,
                batch[batch.len() - 1].0.clone(),
            );
            watermark = watermark.max(cursor.0);

            let mut docs = Vec::new();
            for (id, session_id, msg_type, ts, data) in &batch {
                collect_v2_docs(&mut docs, id, session_id, msg_type, *ts, data);
            }
            insert_docs(&side, &docs)?;

            indexed += batch.len() as i64;
            progress(indexed, total, "v2");
            throttle();
        }
    }

    // 2) 旧表正文：仅纯 v1 库全量 `part`（v2-only 收口：混合库不再补旧表正文）。
    if !mode.is_v2() {
        let mut cursor: Cursor = (start, String::new());
        loop {
            let batch = fetch_legacy_batch(&source, &cursor)?;
            if batch.is_empty() {
                break;
            }
            cursor = (
                batch[batch.len() - 1].2,
                batch[batch.len() - 1].0.clone(),
            );
            watermark = watermark.max(cursor.0);

            let mut docs = Vec::new();
            for (id, session_id, ts, data) in &batch {
                if let Some(body) = json_text(data) {
                    docs.push(Doc {
                        id: id.clone(),
                        session_id: session_id.clone(),
                        time_created: *ts,
                        source: "legacy",
                        body,
                    });
                }
            }
            insert_docs(&side, &docs)?;

            indexed += batch.len() as i64;
            progress(indexed, total, "legacy");
            throttle();
        }
    }

    // 3) 清理已删除会话的文档。
    let removed = prune(&side, &source, mode)?;
    if removed > 0 {
        progress(indexed, total, "prune");
    }

    write_meta(
        &side,
        &[
            ("source_path", db_path.as_str()),
            ("source_size", &source_size(&db_path)),
            ("source_mtime", &source_mtime(&db_path)),
            ("schema_mode", mode_key),
            ("tokenizer", TOKENIZER_VERSION),
            ("watermark", &watermark.to_string()),
            ("built_at", &now_ms().to_string()),
        ],
    )?;

    Ok(BuildOutcome {
        indexed,
        total,
        watermark,
    })
}

/// 批量游标：`(time_created, id)`，与 `(ts, id) > (?, ?)` 的 keyset 分页配合。
type Cursor = (i64, String);

fn mode_key(mode: SchemaMode) -> &'static str {
    match mode {
        SchemaMode::V1 => "v1",
        // v2-only 收口：混合库与纯净库索引口径一致，都用 "v2"。
        SchemaMode::V2Fresh | SchemaMode::V2Mixed => "v2",
        SchemaMode::Unsupported => "unsupported",
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn source_size(path: &str) -> String {
    std::fs::metadata(path)
        .map(|m| m.len())
        .unwrap_or(0)
        .to_string()
}

fn source_mtime(path: &str) -> String {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
        .to_string()
}

fn throttle() {
    std::thread::sleep(Duration::from_millis(BATCH_PAUSE_MS));
}

fn open_sidecar(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("无法创建索引目录：{}", e))?;
    }
    let conn = Connection::open(path).map_err(|e| format!("无法创建搜索索引：{}", e))?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS docs (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            time_created INTEGER NOT NULL,
            source TEXT NOT NULL,
            body TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS docs_session_idx ON docs (session_id);
         CREATE INDEX IF NOT EXISTS docs_time_idx ON docs (time_created);",
    )
    .map_err(|e| format!("无法初始化搜索索引：{}", e))?;
    create_fts_if_missing(&conn).map_err(|e| format!("无法初始化全文索引：{}", e))?;
    Ok(conn)
}

fn create_fts_if_missing(conn: &Connection) -> rusqlite::Result<()> {
    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'docs_fts'",
        [],
        |row| row.get(0),
    )?;
    if exists == 0 {
        conn.execute_batch(&format!(
            "CREATE VIRTUAL TABLE docs_fts USING fts5(body, content='', tokenize='{}');",
            TOKENIZER
        ))?;
    }
    Ok(())
}

/// 清空索引（保留表结构），用于指纹变化后的重建。
fn reset_index(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("DROP TABLE IF EXISTS docs_fts; DELETE FROM docs;")
        .map_err(|e| format!("无法清空搜索索引：{}", e))?;
    create_fts_if_missing(conn).map_err(|e| format!("无法重建全文索引：{}", e))
}

fn read_meta(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
        row.get::<_, String>(0)
    })
    .optional()
    .ok()
    .flatten()
}

fn write_meta(conn: &Connection, entries: &[(&str, &str)]) -> Result<(), String> {
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("无法写入索引元信息：{}", e))?;
    let result = (|| -> rusqlite::Result<()> {
        let mut stmt = conn.prepare(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )?;
        for (key, value) in entries {
            stmt.execute(params![key, value])?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => conn
            .execute_batch("COMMIT")
            .map_err(|e| format!("无法写入索引元信息：{}", e)),
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(format!("无法写入索引元信息：{}", e))
        }
    }
}

// ─── 源数据读取 ───────────────────────────────────────────────────────────

/// 待处理行数（构建进度的分母）。v2-only：混合库只索引 v2 正文。
fn count_pending(conn: &Connection, mode: SchemaMode, start: i64) -> Result<i64, String> {
    let mut total = 0i64;
    if mode.is_v2() {
        total += conn
            .query_row(
                "SELECT COUNT(*) FROM session_message \
                 WHERE \"type\" IN ('user','assistant') AND (time_created, id) > (?1, ?2)",
                params![start, ""],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|e| format!("无法统计待索引消息：{}", e))?;
    } else {
        total += conn
            .query_row(&legacy_count_sql(), params![start, ""], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(|e| format!("无法统计待索引旧消息：{}", e))?;
    }
    Ok(total)
}

fn legacy_count_sql() -> String {
    String::from(
        "SELECT COUNT(*) FROM part p \
         WHERE (p.time_created, p.id) > (?1, ?2)",
    )
}

/// v2 批次：`(id, session_id, type, time_created, data)`。
type V2Row = (String, String, String, i64, String);
/// 旧表批次：`(part id, session_id, time_created, data)`。
type LegacyRow = (String, String, i64, String);

fn fetch_v2_batch(conn: &Connection, cursor: &Cursor) -> Result<Vec<V2Row>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, \"type\", time_created, data FROM session_message \
             WHERE \"type\" IN ('user','assistant') AND (time_created, id) > (?1, ?2) \
             ORDER BY time_created, id LIMIT ?3",
        )
        .map_err(|e| format!("无法读取 v2 消息：{}", e))?;
    let rows = stmt
        .query_map(params![cursor.0, cursor.1, BATCH_ROWS], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(|e| format!("无法读取 v2 消息：{}", e))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("无法读取 v2 消息：{}", e))?;
    Ok(rows)
}

fn fetch_legacy_batch(conn: &Connection, cursor: &Cursor) -> Result<Vec<LegacyRow>, String> {
    let sql = "SELECT p.id, p.session_id, p.time_created, p.data FROM part p \
         WHERE (p.time_created, p.id) > (?1, ?2) \
         ORDER BY p.time_created, p.id LIMIT ?3";
    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| format!("无法读取旧消息：{}", e))?;
    let rows = stmt
        .query_map(params![cursor.0, cursor.1, BATCH_ROWS], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|e| format!("无法读取旧消息：{}", e))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("无法读取旧消息：{}", e))?;
    Ok(rows)
}

// ─── 文档抽取 ─────────────────────────────────────────────────────────────

struct Doc {
    id: String,
    session_id: String,
    time_created: i64,
    source: &'static str,
    body: String,
}

/// v2 消息 → 文档：user 取 `$.text`，assistant 取 `content[]` 中 `type=text` 的块。
///
/// reasoning / tool 输出默认不入索引（体积占真库 94%+，且噪音大）。
fn collect_v2_docs(
    out: &mut Vec<Doc>,
    id: &str,
    session_id: &str,
    msg_type: &str,
    time_created: i64,
    data: &str,
) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
        return;
    };
    match msg_type {
        "user" => {
            if let Some(text) = value.get("text").and_then(|v| v.as_str()) {
                let text = text.trim();
                if !text.is_empty() {
                    out.push(Doc {
                        id: format!("{}:u", id),
                        session_id: session_id.to_string(),
                        time_created,
                        source: "v2",
                        body: text.to_string(),
                    });
                }
            }
        }
        "assistant" => {
            let Some(content) = value.get("content").and_then(|v| v.as_array()) else {
                return;
            };
            for (index, block) in content.iter().enumerate() {
                let is_text = block.get("type").and_then(|v| v.as_str()) == Some("text");
                if !is_text {
                    continue;
                }
                if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                    let text = text.trim();
                    if !text.is_empty() {
                        out.push(Doc {
                            id: format!("{}:{}", id, index),
                            session_id: session_id.to_string(),
                            time_created,
                            source: "v2",
                            body: text.to_string(),
                        });
                    }
                }
            }
        }
        _ => {}
    }
}

/// 旧 part 的正文：`$.text`（text part）。
fn json_text(data: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(data).ok()?;
    let text = value.get("text")?.as_str()?.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

/// 写入文档与 FTS。`INSERT OR IGNORE` 保证重复水位区间幂等。
fn insert_docs(conn: &Connection, docs: &[Doc]) -> Result<(), String> {
    if docs.is_empty() {
        return Ok(());
    }
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("无法写入搜索索引：{}", e))?;
    let result = (|| -> rusqlite::Result<()> {
        {
            let mut insert_doc = conn.prepare(
                "INSERT OR IGNORE INTO docs (id, session_id, time_created, source, body) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )?;
            let mut insert_fts =
                conn.prepare("INSERT INTO docs_fts (rowid, body) VALUES (?1, ?2)")?;
            for doc in docs {
                let inserted = insert_doc.execute(params![
                    doc.id,
                    doc.session_id,
                    doc.time_created,
                    doc.source,
                    doc.body
                ])?;
                if inserted == 1 {
                    insert_fts.execute(params![conn.last_insert_rowid(), doc.body])?;
                }
            }
        }
        Ok(())
    })();
    match result {
        Ok(()) => conn
            .execute_batch("COMMIT")
            .map_err(|e| format!("无法写入搜索索引：{}", e)),
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(format!("无法写入搜索索引：{}", e))
        }
    }
}

/// 清理已删除会话的文档（含 FTS 行）。
fn prune(conn: &Connection, source: &Connection, mode: SchemaMode) -> Result<usize, String> {
    let valid = valid_session_ids(source, mode)?;

    let stale: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT DISTINCT session_id FROM docs")
            .map_err(|e| format!("无法读取索引会话：{}", e))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| format!("无法读取索引会话：{}", e))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| format!("无法读取索引会话：{}", e))?;
        rows.into_iter()
            .filter(|id| !valid.contains(id))
            .collect()
    };

    let mut removed = 0usize;
    for session_id in stale {
        let rows: Vec<(i64, String)> = {
            let mut stmt = conn
                .prepare("SELECT rowid, body FROM docs WHERE session_id = ?1")
                .map_err(|e| format!("无法读取待清理文档：{}", e))?;
            let rows = stmt
                .query_map([session_id.as_str()], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| format!("无法读取待清理文档：{}", e))?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|e| format!("无法读取待清理文档：{}", e))?;
            rows
        };
        if rows.is_empty() {
            continue;
        }
        conn.execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| format!("无法清理搜索索引：{}", e))?;
        let result = (|| -> rusqlite::Result<()> {
            {
                // contentless FTS5 的删除必须提供原始正文。
                let mut delete_fts = conn.prepare(
                    "INSERT INTO docs_fts (docs_fts, rowid, body) VALUES ('delete', ?1, ?2)",
                )?;
                for (rowid, body) in &rows {
                    delete_fts.execute(params![rowid, body])?;
                }
                conn.execute("DELETE FROM docs WHERE session_id = ?1", [session_id.as_str()])?;
            }
            Ok(())
        })();
        match result {
            Ok(()) => {
                conn.execute_batch("COMMIT")
                    .map_err(|e| format!("无法清理搜索索引：{}", e))?;
                removed += rows.len();
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(format!("无法清理搜索索引：{}", e));
            }
        }
    }
    Ok(removed)
}

/// 有效的会话 id 集合（用于清理已删除会话）。
fn valid_session_ids(conn: &Connection, mode: SchemaMode) -> Result<HashSet<String>, String> {
    let sql = match mode {
        SchemaMode::V1 => "SELECT id FROM session",
        SchemaMode::V2Fresh => "SELECT id FROM session_v2",
        _ => "SELECT id FROM session_v2 UNION SELECT id FROM session",
    };
    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| format!("无法读取会话列表：{}", e))?;
    let ids = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("无法读取会话列表：{}", e))?
        .collect::<rusqlite::Result<HashSet<_>>>()
        .map_err(|e| format!("无法读取会话列表：{}", e))?;
    Ok(ids)
}

// ─── 测试 ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{self, DbState};
    use crate::schema::fixtures;

    /// 测试用临时工作区：源库 + sidecar + 已打开的 DbState。
    struct Fixture {
        dir: PathBuf,
        db_path: String,
        sidecar: PathBuf,
        state: DbState,
    }

    impl Fixture {
        fn new(tag: &str, schemas: &[&str]) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let dir = std::env::temp_dir().join(format!(
                "ocw-search-{}-{}-{}",
                tag,
                std::process::id(),
                nanos
            ));
            std::fs::create_dir_all(&dir).expect("temp dir");
            let db_path = dir.join("opencode.db");
            {
                let conn = Connection::open(&db_path).expect("source db");
                for schema in schemas {
                    conn.execute_batch(schema).expect("fixture schema");
                }
            }
            let db_path = db_path.to_string_lossy().to_string();
            let state = DbState::new();
            db::open(&state, &db_path).expect("db opens");
            Fixture {
                sidecar: dir.join(INDEX_FILE_NAME),
                dir,
                db_path,
                state,
            }
        }

        fn source(&self) -> Connection {
            Connection::open(&self.db_path).expect("source conn")
        }

        fn index(&self) -> SearchIndex {
            let index = SearchIndex::new();
            index.set_sidecar(self.sidecar.clone());
            index
        }

        /// 同步构建（测试里不走后台线程），并把状态置为 ready。
        fn build(&self, index: &SearchIndex) -> BuildOutcome {
            let outcome = build(&self.state, index, &self.sidecar, &|_, _, _| {})
                .expect("index builds");
            index.finish(outcome.watermark, outcome.indexed, outcome.total);
            outcome
        }

        fn search(&self, index: &SearchIndex, keyword: &str) -> Vec<SearchResult> {
            let pool = self.state.clone_inner();
            let conn = db::get_db(&pool).expect("pool conn");
            search(&conn, index, keyword)
        }

        fn doc_count(&self) -> i64 {
            let conn = Connection::open_with_flags(
                &self.sidecar,
                OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .expect("sidecar");
            conn.query_row("SELECT COUNT(*) FROM docs", [], |row| row.get(0))
                .expect("doc count")
        }

        fn docs_of(&self, session_id: &str) -> i64 {
            let conn = Connection::open_with_flags(
                &self.sidecar,
                OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .expect("sidecar");
            conn.query_row(
                "SELECT COUNT(*) FROM docs WHERE session_id = ?1",
                [session_id],
                |row| row.get(0),
            )
            .expect("session doc count")
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = db::close(&self.state);
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn recent(offset_ms: i64) -> i64 {
        now_ms() - 60_000 + offset_ms
    }

    fn insert_session_v2(conn: &Connection, id: &str, title: &str) {
        conn.execute(
            "INSERT INTO session_v2 (id, project_id, slug, directory, title, version, time_created, time_updated)
             VALUES (?1, 'proj', ?2, '/tmp/project', ?3, '2.1.2', 1000, 2000)",
            params![id, format!("slug-{id}"), title],
        )
        .expect("v2 session");
    }

    fn insert_message_v2(conn: &Connection, id: &str, session_id: &str, kind: &str, seq: i64, ts: i64, data: &str) {
        conn.execute(
            "INSERT INTO session_message (id, session_id, \"type\", seq, time_created, time_updated, data)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, session_id, kind, seq, ts, ts, data],
        )
        .expect("v2 message");
    }

    fn insert_legacy_session(conn: &Connection, id: &str, title: &str) {
        conn.execute(
            "INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
             VALUES (?1, 'proj', ?2, '/tmp/project', ?3, '1.3.5', 1000, 2000)",
            params![id, format!("slug-{id}"), title],
        )
        .expect("legacy session");
    }

    fn insert_legacy_message(conn: &Connection, id: &str, session_id: &str, ts: i64) {
        conn.execute(
            "INSERT INTO message (id, session_id, time_created, time_updated, data)
             VALUES (?1, ?2, ?3, ?3, '{}')",
            params![id, session_id, ts],
        )
        .expect("legacy message");
    }

    fn insert_legacy_part(conn: &Connection, id: &str, message_id: &str, session_id: &str, ts: i64, text: &str) {
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
             VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
            params![
                id,
                message_id,
                session_id,
                ts,
                serde_json::json!({ "type": "text", "text": text }).to_string()
            ],
        )
        .expect("legacy part");
    }

    /// v2 夹具：一条 user 正文 + 一条 assistant（text / reasoning / tool 混合）。
    fn v2_fixture(tag: &str) -> Fixture {
        let fixture = Fixture::new(tag, &[fixtures::v2_schema()]);
        let conn = fixture.source();
        insert_session_v2(&conn, "ses_a", "会话A");
        insert_message_v2(
            &conn,
            "msg_u1",
            "ses_a",
            "user",
            1,
            recent(-2000),
            r#"{"text":"项目数据库兼容性升级说明"}"#,
        );
        insert_message_v2(
            &conn,
            "msg_a1",
            "ses_a",
            "assistant",
            2,
            recent(-1000),
            r#"{"content":[{"type":"text","text":"我们讨论了兼容层改造方案"},{"type":"reasoning","text":"推理独有词汇"},{"type":"tool","text":"工具独有词汇"}]}"#,
        );
        fixture
    }

    #[test]
    fn v2_index_recalls_chinese_substring_and_skips_reasoning() {
        let fixture = v2_fixture("v2-recall");
        let index = fixture.index();
        let outcome = fixture.build(&index);

        assert!(outcome.indexed >= 2);
        assert!(outcome.watermark > 0);
        assert_eq!(index.status().state, IndexState::Ready);
        // 3 个文档：user 正文 + assistant 的 text 块（reasoning/tool 不入索引）。
        assert_eq!(fixture.doc_count(), 2);

        let hits = fixture.search(&index, "兼容性");
        assert_eq!(hits.len(), 1, "中文子串应命中 user 正文");
        assert_eq!(hits[0].session_id, "ses_a");
        assert_eq!(hits[0].session_title, "会话A");

        // assistant 的 text 块以子串方式召回。
        let hits = fixture.search(&index, "讨论了兼容");
        assert_eq!(hits.len(), 1);

        // reasoning / tool 正文不入索引：ready 状态下空结果就是权威结果。
        assert!(fixture.search(&index, "推理独有词汇").is_empty());
        assert!(fixture.search(&index, "工具独有词汇").is_empty());
    }

    #[test]
    fn short_keyword_falls_back_to_like() {
        let fixture = v2_fixture("v2-short");
        let index = fixture.index();
        fixture.build(&index);

        // 2 字符 < trigram 下限 → 走 LIKE（30 天窗口）。
        let hits = fixture.search(&index, "兼容");
        assert!(!hits.is_empty(), "短关键词应回退 LIKE 并命中");
        assert!(hits.iter().all(|hit| hit.content.chars().count() <= SNIPPET_CHARS));
    }

    #[test]
    fn unready_index_falls_back_to_like() {
        let fixture = v2_fixture("v2-unready");
        let index = fixture.index(); // 未 build

        assert_eq!(index.status().state, IndexState::None);
        assert!(index.ready_sidecar().is_none());

        let hits = fixture.search(&index, "兼容性");
        assert!(!hits.is_empty(), "索引未就绪时应回退 LIKE");
    }

    #[test]
    fn incremental_build_picks_up_new_messages() {
        let fixture = v2_fixture("v2-incremental");
        let index = fixture.index();
        fixture.build(&index);
        let first = index.status();
        assert!(fixture.search(&index, "后续补充条目").is_empty());

        {
            let conn = fixture.source();
            insert_message_v2(
                &conn,
                "msg_u2",
                "ses_a",
                "user",
                3,
                now_ms(),
                r#"{"text":"后续补充条目的正文"}"#,
            );
        }

        let outcome = fixture.build(&index);
        let second = index.status();
        assert!(outcome.watermark >= first.watermark);
        assert!(second.watermark > first.watermark);
        assert!(!fixture.search(&index, "补充条目").is_empty());
    }

    #[test]
    fn prune_removes_documents_of_deleted_sessions() {
        let fixture = Fixture::new("v2-prune", &[fixtures::v2_schema()]);
        {
            let conn = fixture.source();
            insert_session_v2(&conn, "ses_keep", "保留会话");
            insert_session_v2(&conn, "ses_gone", "删除会话");
            insert_message_v2(
                &conn,
                "msg_keep",
                "ses_keep",
                "user",
                1,
                recent(-3000),
                r#"{"text":"保留会话的正文"}"#,
            );
            insert_message_v2(
                &conn,
                "msg_gone",
                "ses_gone",
                "user",
                2,
                recent(-2000),
                r#"{"text":"即将删除的会话正文"}"#,
            );
        }
        let index = fixture.index();
        fixture.build(&index);
        assert_eq!(fixture.docs_of("ses_gone"), 1);
        assert!(!fixture.search(&index, "删除的会话正文").is_empty());

        {
            let conn = fixture.source();
            conn.execute_batch(
                "DELETE FROM session_message WHERE session_id = 'ses_gone';
                 DELETE FROM session_v2 WHERE id = 'ses_gone';",
            )
            .expect("delete session");
        }

        fixture.build(&index);
        assert_eq!(fixture.docs_of("ses_gone"), 0, "已删除会话的文档应被清理");
        assert!(fixture.search(&index, "删除的会话正文").is_empty());
        assert!(!fixture.search(&index, "保留会话的正文").is_empty());
    }

    #[test]
    fn mixed_index_adds_legacy_only_content_only_once() {
        let fixture = Fixture::new(
            "mixed",
            &[fixtures::v1_schema(), fixtures::v2_schema()],
        );
        {
            let conn = fixture.source();
            insert_session_v2(&conn, "ses_v2", "新会话");
            insert_message_v2(
                &conn,
                "msg_u1",
                "ses_v2",
                "user",
                1,
                recent(-3000),
                r#"{"text":"v2 正文内容"}"#,
            );
            // 旧结构里同一消息的重复 part（v2-only：不再入索引）。
            insert_legacy_part(&conn, "p_dup", "msg_u1", "ses_v2", recent(-3000), "重复旧结构内容");

            // legacy-only 会话正文：v2-only 收口后不再入索引。
            insert_legacy_session(&conn, "ses_legacy", "遗留会话");
            insert_legacy_message(&conn, "msg_legacy", "ses_legacy", recent(-1000));
            insert_legacy_part(
                &conn,
                "p_legacy",
                "msg_legacy",
                "ses_legacy",
                recent(-1000),
                "遗留会话专属内容",
            );
        }

        let index = fixture.index();
        fixture.build(&index);

        // v2-only 收口：旧表正文（重复 part、legacy-only 会话）一律不入索引。
        assert!(fixture.search(&index, "专属内容").is_empty());
        assert!(fixture.search(&index, "重复旧结构").is_empty());
        assert_eq!(fixture.doc_count(), 1, "只索引 v2 消息");
    }

    #[test]
    fn v1_index_reads_legacy_parts() {
        let fixture = Fixture::new("v1", &[fixtures::v1_schema()]);
        {
            let conn = fixture.source();
            insert_legacy_session(&conn, "ses_v1", "旧库会话");
            insert_legacy_message(&conn, "msg_v1", "ses_v1", recent(-1000));
            insert_legacy_part(
                &conn,
                "p_v1",
                "msg_v1",
                "ses_v1",
                recent(-1000),
                "旧库正文检索目标",
            );
        }

        let index = fixture.index();
        fixture.build(&index);

        let hits = fixture.search(&index, "正文检索");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "p_v1");
        assert_eq!(hits[0].session_title, "旧库会话");
    }

    #[test]
    fn snippet_is_bounded_to_200_chars() {
        let fixture = Fixture::new("snippet", &[fixtures::v2_schema()]);
        let body = format!("{}关键字{}", "前".repeat(300), "后".repeat(300));
        {
            let conn = fixture.source();
            insert_session_v2(&conn, "ses_s", "长文本");
            insert_message_v2(
                &conn,
                "msg_s",
                "ses_s",
                "user",
                1,
                recent(-1000),
                &serde_json::json!({ "text": body }).to_string(),
            );
        }

        let index = fixture.index();
        fixture.build(&index);
        let hits = fixture.search(&index, "关键字");
        assert_eq!(hits.len(), 1);
        assert!(
            hits[0].content.chars().count() <= SNIPPET_CHARS,
            "snippet 应不超过 200 字，实际 {}",
            hits[0].content.chars().count()
        );
        assert!(hits[0].content.contains("关键字"));
    }

    #[test]
    fn build_does_not_modify_source_database() {
        let fixture = v2_fixture("read-only");
        let index = fixture.index();
        let before = std::fs::metadata(&fixture.db_path).expect("metadata");
        let size_before = before.len();
        let mtime_before = before.modified().ok();

        fixture.build(&index);

        let after = std::fs::metadata(&fixture.db_path).expect("metadata");
        assert_eq!(after.len(), size_before, "构建索引不得改动源库大小");
        assert_eq!(
            after.modified().ok(),
            mtime_before,
            "构建索引不得写源库"
        );
    }

    #[test]
    fn rebuild_after_sidecar_removal_is_idempotent() {
        let fixture = v2_fixture("rebuild");
        let index = fixture.index();
        let first = fixture.build(&index);
        let docs = fixture.doc_count();

        // 删除 sidecar（含 WAL/SHM），模拟用户手动清理。
        let _ = std::fs::remove_file(&fixture.sidecar);
        let _ = std::fs::remove_file(fixture.sidecar.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(fixture.sidecar.with_extension("sqlite-shm"));

        let index = fixture.index();
        let second = fixture.build(&index);
        assert_eq!(fixture.doc_count(), docs, "重建后文档数应一致");
        assert_eq!(second.watermark, first.watermark);
        assert_eq!(index.status().state, IndexState::Ready);
        assert!(!fixture.search(&index, "兼容性").is_empty());
    }

    #[test]
    fn match_expression_escapes_quotes_and_wildcards() {
        let fixture = Fixture::new("escape", &[fixtures::v2_schema()]);
        {
            let conn = fixture.source();
            insert_session_v2(&conn, "ses_e", "转义");
            insert_message_v2(
                &conn,
                "msg_e",
                "ses_e",
                "user",
                1,
                recent(-1000),
                r#"{"text":"他说 \"hi\" 然后离开"}"#,
            );
        }
        let index = fixture.index();
        fixture.build(&index);

        // 关键词带引号：MATCH 表达式必须转义而不是报语法错误。
        let hits = fixture.search(&index, "\"hi\"");
        assert_eq!(hits.len(), 1);

        // `%` / `_` 在 LIKE 回退里按字面量处理。
        assert!(fixture.search(&index, "%%%").is_empty());
    }

    #[test]
    fn empty_keyword_returns_no_results() {
        let fixture = v2_fixture("empty");
        let index = fixture.index();
        fixture.build(&index);
        assert!(fixture.search(&index, "   ").is_empty());
    }

    #[test]
    fn status_serializes_to_shared_contract() {
        let status = SearchIndexStatus {
            state: IndexState::Building,
            indexed: 3,
            total: 10,
            watermark: 42,
            error: None,
        };
        let json = serde_json::to_value(&status).expect("status serializes");
        assert_eq!(json["state"], "building");
        assert_eq!(json["indexed"], 3);
        assert_eq!(json["total"], 10);
        assert_eq!(json["watermark"], 42);
        assert!(json["error"].is_null());
    }

    #[test]
    fn snippet_keeps_short_bodies_intact() {
        assert_eq!(snippet("短正文", "正文"), "短正文");
        assert_eq!(snippet("", "正文"), "");
        assert!(snippet(&"字".repeat(500), "字").chars().count() <= SNIPPET_CHARS);
    }
}
