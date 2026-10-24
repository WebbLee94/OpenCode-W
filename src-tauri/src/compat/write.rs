//! 写路径兼容层：v1 / v2 / 混合库的删除、重命名、移动。
//!
//! 约束（Phase 3 方案 / RISK-004 / RISK-005）：
//!
//! - **只写真实表**。v2 模式下 `session` 是同名 TEMP VIEW，任何写操作都必须
//!   显式带上 `main.` 前缀，否则会撞上 `cannot modify session because it is a
//!   view`；`session_v2` / `session_message` 没有视图，直接写真实表。
//! - **删除顺序固定**（单事务内）：
//!   v2 形态：子会话递归 → `session_message`（v2）→ `session_v2`；
//!   纯 v1 库：`part` → `message` → `session`（legacy，1.3.5 行为不变）。
//!   先删子表再删父表：既避免触发外键级联导致计数失真，也保证中途失败时
//!   整单回滚。
//! - **v2-only 收口**：v2 形态不再做 legacy 双删，旧表冻结副本不触碰。
//! - **参数化**。所有取值都是绑定参数；集合条件用 `json_each(?)` 展开，
//!   避免会话数量多时撞上 SQLite 的变量上限。表名与列名只来自本模块常量，
//!   禁止拼接外部输入（SEC-003）。
//! - **不建表、不改表、不建索引、不写 `kv`**（SEC-001）。

use std::collections::BTreeSet;
use std::path::Path;

use rusqlite::{Connection, OptionalExtension};

use crate::compat::{json_array, table_exists};
use crate::models::dto::CleanupSideDTO;

/// v2 会话表（真实表）。
const V2_SESSION_TABLE: &str = "main.session_v2";
/// v2 消息表（真实表）。
const V2_MESSAGE_TABLE: &str = "main.session_message";
/// 旧会话表（v2 模式下同名 TEMP VIEW 的来源，必须写 `main.`）。
const LEGACY_SESSION_TABLE: &str = "main.session";
/// 旧消息表。
const LEGACY_MESSAGE_TABLE: &str = "main.message";
/// 旧内容块表。
const LEGACY_PART_TABLE: &str = "main.part";
/// 项目维表（v1 / v2 结构一致）。
const PROJECT_TABLE: &str = "main.project";

/// 删除结果：v2 数据与旧版副本分别计数。
///
/// v2-only 收口：v2 形态（fresh / mixed）**只删 v2 表**，旧表是迁移后的冻结
/// 副本——OpenCode-W 不再做 legacy 双删，legacy-only / 尾消息不再是清理对象。
/// legacy 侧计数只在纯 v1 库（v1 是唯一内容源，保持 1.3.5 行为）非零。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DeleteOutcome {
    /// 逻辑会话数：两侧去重后的会话个数（同一个 id 只算一次）。
    pub sessions: i64,
    /// v2 侧：`session_v2` 实际删除行数。
    pub v2_session_rows: i64,
    /// v2 侧：`session_message` 实际删除行数。
    pub v2_message_rows: i64,
    /// v2 侧：`session_message.data` 字节数。
    pub v2_bytes: i64,
    /// 旧版侧：`session` 实际删除行数（仅纯 v1 库非零）。
    pub legacy_session_rows: i64,
    /// 旧版侧：`message` 实际删除行数（仅纯 v1 库非零）。
    pub legacy_message_rows: i64,
    /// 旧版侧：`part` 实际删除行数（仅纯 v1 库非零）。
    pub legacy_part_rows: i64,
    /// 旧版侧：`part.data` 尺寸（仅纯 v1 库非零，保留 1.3.5 口径）。
    pub legacy_bytes: i64,
}

impl DeleteOutcome {
    /// 顶层消息数：v2 侧 + v1 侧。
    pub fn messages(&self) -> i64 {
        self.v2_message_rows + self.legacy_message_rows
    }

    /// 顶层内容块数：v2 消息行数 + 旧版 `part` 行数。
    ///
    /// v2 没有 `part` 表：内容块数按**消息行数**统计（与 TASK-006 / 仪表盘
    /// `part_count` 口径一致），不再解析 JSON。
    pub fn parts(&self) -> i64 {
        self.v2_message_rows + self.legacy_part_rows
    }

    /// 顶层字节数：v2 消息体积 + 旧版 `part` 体积。
    pub fn bytes(&self) -> i64 {
        self.v2_bytes + self.legacy_bytes
    }

    /// v2 数据侧的明细。
    pub fn v2_side(&self) -> CleanupSideDTO {
        CleanupSideDTO {
            session_count: self.v2_session_rows,
            message_count: self.v2_message_rows,
            part_count: self.v2_message_rows,
            estimated_size: self.v2_bytes,
        }
    }

    /// 旧版副本侧的明细（仅纯 v1 库非零）。
    pub fn legacy_side(&self) -> CleanupSideDTO {
        CleanupSideDTO {
            session_count: self.legacy_session_rows,
            message_count: self.legacy_message_rows,
            part_count: self.legacy_part_rows,
            estimated_size: self.legacy_bytes,
        }
    }
}

// ─── 表存在性 ──────────────────────────────────────────────────────────────

/// 当前库具备哪些写路径相关的表。
#[derive(Debug, Clone, Copy, Default)]
struct Tables {
    v2_session: bool,
    v2_message: bool,
    legacy_session: bool,
    legacy_message: bool,
    legacy_part: bool,
}

fn detect_tables(conn: &Connection) -> Result<Tables, String> {
    let check = |name: &str| -> Result<bool, String> {
        table_exists(conn, name).map_err(|e| e.to_string())
    };
    Ok(Tables {
        v2_session: check("session_v2")?,
        v2_message: check("session_message")?,
        legacy_session: check("session")?,
        legacy_message: check("message")?,
        legacy_part: check("part")?,
    })
}

// ─── 会话定位 ──────────────────────────────────────────────────────────────

/// 会话是否已经迁移到 v2（`session_v2` 里有这个 id）。
///
/// 判定只看 v2 表的成员关系，不依赖库整体模式：混合库里两种会话并存。
pub fn is_v2_session(conn: &Connection, session_id: &str) -> Result<bool, String> {
    if !table_exists(conn, "session_v2").map_err(|e| e.to_string())? {
        return Ok(false);
    }
    let hit = conn
        .query_row(
            "SELECT 1 FROM main.session_v2 WHERE id = ?1",
            [session_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(hit.is_some())
}

// ─── 删除 ──────────────────────────────────────────────────────────────────

/// 删除会话及其全部内容（v1 / v2 通用）。
///
/// 语义：
/// - 递归删除子会话（v2 用 `session_v2.parent_id`，v1 用 `session.parent_id`）；
/// - v2 形态只删 v2 行（旧表是冻结副本，不做 legacy 双删）；
/// - 全过程在单个事务内，任一步失败整单回滚，COMMIT 失败同样回滚。
///
/// `roots` 是用户选中的会话 id（通常是根会话）。
pub fn delete_sessions(conn: &Connection, roots: &[String]) -> Result<DeleteOutcome, String> {
    if roots.is_empty() {
        return Ok(DeleteOutcome::default());
    }
    let targets = collect_targets(conn, roots)?;
    delete_target_set(conn, &targets)
}

/// 删除**精确指定的**会话集合：**不递归、不展开后代**。
///
/// 与 [`delete_sessions`] 的区别：后者把根会话的 v2 后代一并纳入删除集合；
/// 本函数只删传入的 id。清理执行用它保证「删的就是预览里看到的那些会话」——
/// 用户在预览里取消勾选的会话绝不会被连带删除（PR-2 安全修复 P1-1）。
///
/// `sessions:delete` 保持既有递归语义（单个会话删除要连带清掉子树）。
pub fn delete_sessions_exact(conn: &Connection, ids: &[String]) -> Result<DeleteOutcome, String> {
    if ids.is_empty() {
        return Ok(DeleteOutcome::default());
    }
    let targets: BTreeSet<String> = ids.iter().cloned().collect();
    delete_target_set(conn, &targets)
}

/// 在单个事务内删除给定的会话集合（集合已确定，不再展开）。
fn delete_target_set(
    conn: &Connection,
    targets: &BTreeSet<String>,
) -> Result<DeleteOutcome, String> {
    if targets.is_empty() {
        return Ok(DeleteOutcome::default());
    }
    let tables = detect_tables(conn)?;
    let ids: Vec<String> = targets.iter().cloned().collect();
    let ids_json = json_array(&ids);

    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("开启删除事务失败：{}", e))?;

    match delete_in_transaction(conn, &ids_json, &tables) {
        Ok(outcome) => match conn.execute_batch("COMMIT") {
            Ok(()) => Ok(outcome),
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(format!("提交删除事务失败：{}", error))
            }
        },
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

/// 事务内完成「统计 → 按序删除」。
///
/// v2-only 收口：只要库里有 v2 表（fresh / mixed），所有统计与删除都只碰
/// v2 表；旧表冻结副本不再触碰。纯 v1 库走原有全表流程（1.3.5 行为不变）。
fn delete_in_transaction(
    conn: &Connection,
    ids_json: &str,
    tables: &Tables,
) -> Result<DeleteOutcome, String> {
    let is_v2_tables = tables.v2_session || tables.v2_message;

    // 逻辑会话数：v2-only 时只数 v2 表；纯 v1 库数旧表。
    let sessions = count_logical_sessions(conn, ids_json, tables, is_v2_tables)?;

    // v2 侧统计：只需字节数；内容块数按消息行数算，不再解析 JSON
    // （14.8 GB 真库上 json_array_length 全扫要 11.6 s）。
    //
    // 用 `octet_length`（字节数，与清理预览同口径）：只读记录头、不读 overflow 页。
    let v2_bytes = if tables.v2_message {
        conn.query_row(
            &format!(
                "SELECT COALESCE(SUM(octet_length(data)), 0) FROM {V2_MESSAGE_TABLE}
                 WHERE session_id IN (SELECT value FROM json_each(?1))"
            ),
            [ids_json],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| e.to_string())?
    } else {
        0
    };

    // legacy 侧统计与删除只在纯 v1 库执行（`is_v2_tables` 为 false）。
    let legacy_bytes = if is_v2_tables {
        0
    } else if tables.legacy_part {
        // 纯 v1 库：字符数，逐字保留 1.3.5 的历史口径。
        conn.query_row(
            &format!(
                "SELECT COALESCE(SUM(LENGTH(data)), 0) FROM {LEGACY_PART_TABLE}
                 WHERE session_id IN (SELECT value FROM json_each(?1))"
            ),
            [ids_json],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| e.to_string())?
    } else {
        0
    };

    // 删除顺序（纯 v1 库）：part → message → session（遗留）→ v2 表（不存在则跳过）。
    // v2 形态下后三段 legacy 删除为零行——直接跳过，不再触碰旧表。
    let deleted_legacy_parts = if !is_v2_tables && tables.legacy_part {
        conn.execute(
            &format!(
                "DELETE FROM {LEGACY_PART_TABLE}
                 WHERE session_id IN (SELECT value FROM json_each(?1))"
            ),
            [ids_json],
        )
        .map_err(|e| e.to_string())? as i64
    } else {
        0
    };
    let deleted_legacy_messages = if !is_v2_tables && tables.legacy_message {
        conn.execute(
            &format!(
                "DELETE FROM {LEGACY_MESSAGE_TABLE}
                 WHERE session_id IN (SELECT value FROM json_each(?1))"
            ),
            [ids_json],
        )
        .map_err(|e| e.to_string())? as i64
    } else {
        0
    };
    let deleted_legacy_sessions = if !is_v2_tables && tables.legacy_session {
        conn.execute(
            &format!(
                "DELETE FROM {LEGACY_SESSION_TABLE}
                 WHERE id IN (SELECT value FROM json_each(?1))"
            ),
            [ids_json],
        )
        .map_err(|e| e.to_string())? as i64
    } else {
        0
    };
    let deleted_v2_messages = if tables.v2_message {
        conn.execute(
            &format!(
                "DELETE FROM {V2_MESSAGE_TABLE}
                 WHERE session_id IN (SELECT value FROM json_each(?1))"
            ),
            [ids_json],
        )
        .map_err(|e| e.to_string())? as i64
    } else {
        0
    };
    let deleted_v2_sessions = if tables.v2_session {
        conn.execute(
            &format!(
                "DELETE FROM {V2_SESSION_TABLE}
                 WHERE id IN (SELECT value FROM json_each(?1))"
            ),
            [ids_json],
        )
        .map_err(|e| e.to_string())? as i64
    } else {
        0
    };

    Ok(DeleteOutcome {
        sessions,
        v2_session_rows: deleted_v2_sessions,
        v2_message_rows: deleted_v2_messages,
        v2_bytes,
        legacy_session_rows: deleted_legacy_sessions,
        legacy_message_rows: deleted_legacy_messages,
        legacy_part_rows: deleted_legacy_parts,
        legacy_bytes,
    })
}

/// 逻辑会话数：v2 形态只数 `session_v2`；纯 v1 库数旧表。
fn count_logical_sessions(
    conn: &Connection,
    ids_json: &str,
    tables: &Tables,
    is_v2_tables: bool,
) -> Result<i64, String> {
    let (table, is_legacy) = if is_v2_tables {
        (V2_SESSION_TABLE, !tables.v2_session)
    } else {
        (LEGACY_SESSION_TABLE, !tables.legacy_session)
    };
    if is_legacy {
        return Ok(0);
    }
    conn.query_row(
        &format!("SELECT COUNT(*) FROM {table} WHERE id IN (SELECT value FROM json_each(?1))"),
        [ids_json],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

/// 收集待删除的会话 id：用户选中的会话 + v2 会话树上的全部后代。
///
/// **v1 不递归**：1.3.5 的删除只删所选会话，递归会连带删掉子会话，属于用户
/// 未预期的数据删除，违反「v1 零回归」。v2 递归是新能力，同时避免 v2 孤儿
/// 会话（子会话的 parent_id 指向已删除的父会话）。
///
/// 旧表副本按同一个 id 集合清理的历史决策已随 v2-only 收口取消：
/// v2 形态不再触碰旧表（legacy-only / 尾消息不是清理对象）。
pub fn collect_targets(
    conn: &Connection,
    roots: &[String],
) -> Result<BTreeSet<String>, String> {
    let mut targets: BTreeSet<String> = roots.iter().cloned().collect();
    if roots.is_empty() {
        return Ok(targets);
    }
    let tables = detect_tables(conn)?;
    if tables.v2_session {
        let roots_json = json_array(roots);
        collect_descendants(conn, V2_SESSION_TABLE, &roots_json, &mut targets)?;
    }
    Ok(targets)
}

/// 递归收集某棵会话树里 root 的全部后代。
///
/// 表名只来自本模块常量；root 集合通过 `json_each(?)` 绑定。
fn collect_descendants(
    conn: &Connection,
    table: &str,
    roots_json: &str,
    out: &mut BTreeSet<String>,
) -> Result<(), String> {
    let sql = format!(
        "WITH RECURSIVE subtree(id) AS (
             SELECT s.id FROM {table} s
              WHERE s.parent_id IN (SELECT value FROM json_each(?1))
             UNION
             SELECT s.id FROM {table} s JOIN subtree t ON s.parent_id = t.id
         ) SELECT id FROM subtree"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([roots_json], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    for row in rows {
        out.insert(row.map_err(|e| e.to_string())?);
    }
    Ok(())
}

// ─── 重命名 ────────────────────────────────────────────────────────────────

/// 重命名会话。
///
/// - v2 会话：`UPDATE main.session_v2 SET title = ?, time_updated = ?`，
///   写前先校验会话存在；
/// - 旧表会话（含混合库里的 legacy-only）：`UPDATE main.session SET title = ?`，
///   与 1.3.5 行为一致（不校验存在性）。
pub fn rename_session(
    conn: &Connection,
    session_id: &str,
    title: &str,
) -> Result<bool, String> {
    if is_v2_session(conn, session_id)? {
        let exists: Option<i64> = conn
            .query_row(
                &format!("SELECT 1 FROM {V2_SESSION_TABLE} WHERE id = ?1"),
                [session_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if exists.is_none() {
            return Err(format!("会话不存在：{}", session_id));
        }
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            &format!(
                "UPDATE {V2_SESSION_TABLE} SET title = ?1, time_updated = ?2 WHERE id = ?3"
            ),
            rusqlite::params![title, now, session_id],
        )
        .map_err(|e| e.to_string())?;
        return Ok(true);
    }

    conn.execute(
        &format!("UPDATE {LEGACY_SESSION_TABLE} SET title = ?1 WHERE id = ?2"),
        rusqlite::params![title, session_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(true)
}

// ─── 移动 ──────────────────────────────────────────────────────────────────

/// 移动会话到新目录。
///
/// - `directory` 必须是已解析的绝对路径，`project_id` 由调用方算出；
/// - `project` 行插入与会话更新在同一个事务里，避免留下孤立 project 行；
/// - 仅根会话（`parent_id IS NULL`）会被移动；
/// - v2 会话写 `main.session_v2`，旧表会话写 `main.session`（混合库必需）。
pub fn move_sessions(
    conn: &Connection,
    session_ids: &[String],
    directory: &str,
    project_id: &str,
) -> Result<i64, String> {
    if session_ids.is_empty() {
        return Ok(0);
    }

    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("开启移动事务失败：{}", e))?;

    let result = (|| -> Result<i64, String> {
        ensure_project_row(conn, project_id, directory)?;

        let (v2_ids, legacy_ids) = split_by_dialect(conn, session_ids)?;

        let mut changed = 0i64;
        if !v2_ids.is_empty() {
            changed += conn
                .execute(
                    "UPDATE main.session_v2 SET directory = ?1, project_id = ?2
                     WHERE id IN (SELECT value FROM json_each(?3)) AND parent_id IS NULL",
                    rusqlite::params![directory, project_id, json_array(&v2_ids)],
                )
                .map_err(|e| e.to_string())? as i64;
        }
        if !legacy_ids.is_empty() {
            changed += conn
                .execute(
                    "UPDATE main.session SET directory = ?1, project_id = ?2
                     WHERE id IN (SELECT value FROM json_each(?3)) AND parent_id IS NULL",
                    rusqlite::params![directory, project_id, json_array(&legacy_ids)],
                )
                .map_err(|e| e.to_string())? as i64;
        }
        Ok(changed)
    })();
    match result {
        Ok(changed) => match conn.execute_batch("COMMIT") {
            Ok(()) => Ok(changed),
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(format!("提交移动事务失败：{}", error))
            }
        },
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

/// 把会话 id 拆成「v2 会话」与「旧表会话」两组。
fn split_by_dialect(
    conn: &Connection,
    session_ids: &[String],
) -> Result<(Vec<String>, Vec<String>), String> {
    if !table_exists(conn, "session_v2").map_err(|e| e.to_string())? {
        return Ok((Vec::new(), session_ids.to_vec()));
    }
    let mut stmt = conn
        .prepare(&format!(
            "SELECT id FROM {V2_SESSION_TABLE} WHERE id IN (SELECT value FROM json_each(?1))"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([json_array(session_ids)], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut v2_ids: BTreeSet<String> = BTreeSet::new();
    for row in rows {
        v2_ids.insert(row.map_err(|e| e.to_string())?);
    }
    let legacy_ids = session_ids
        .iter()
        .filter(|id| !v2_ids.contains(*id))
        .cloned()
        .collect();
    Ok((v2_ids.into_iter().collect(), legacy_ids))
}

/// 确保 `project` 行存在（v1 / v2 的 `project` 表结构一致，插入逻辑复用）。
fn ensure_project_row(
    conn: &Connection,
    project_id: &str,
    directory: &str,
) -> Result<(), String> {
    let existing: Option<String> = conn
        .query_row(
            &format!("SELECT id FROM {PROJECT_TABLE} WHERE id = ?"),
            [project_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    if existing.is_some() {
        return Ok(());
    }

    let now = chrono::Utc::now().timestamp_millis();
    let name = Path::new(directory)
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| directory.to_string());
    conn.execute(
        &format!(
            "INSERT INTO {PROJECT_TABLE}
                (id, worktree, name, time_created, time_updated, sandboxes, commands)
             VALUES (?, ?, ?, ?, ?, ?, ?)"
        ),
        rusqlite::params![project_id, directory, name, now, now, "[]", "[]"],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use rusqlite::Connection;

    use super::{collect_targets, delete_sessions, delete_sessions_exact};

    /// 同一进程内并行的测试可能拿到同一纳秒时间戳，目录名必须唯一。
    static FIXTURE_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TempFixture {
        dir: PathBuf,
    }

    impl Drop for TempFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    /// 夹具缺失时：CI 下直接失败（避免静默 skip 造成假绿），本地保留 `[skip]`。
    fn missing_fixture(file: &str) -> Option<String> {
        if std::env::var_os("CI").is_some() {
            Some(format!(
                "夹具缺失，检查 Generate test fixtures 步骤：缺少 test-data/{file}（本地可先执行 `npm run generate-fixture` 或 `npm run generate-fixture:v2`）"
            ))
        } else {
            None
        }
    }

    fn fixture(file: &str) -> Option<(TempFixture, Connection)> {
        let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../test-data")
            .join(file);
        if !source.is_file() {
            if let Some(error) = missing_fixture(file) {
                panic!("{error}");
            }
            eprintln!("[skip] 缺少夹具 {file}");
            return None;
        }
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time is after the Unix epoch")
            .as_nanos();
        let counter = FIXTURE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "ocw-write-it-{}-{counter}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("temp dir is created");
        let path = dir.join("fixture.db");
        fs::copy(&source, &path).expect("fixture is copied");
        let conn = Connection::open(&path).expect("fixture opens");
        Some((TempFixture { dir }, conn))
    }

    /// v2 会话树递归子会话，旧表不递归（保持 1.3.5 语义）。
    #[test]
    fn collect_targets_recurses_only_on_the_v2_session_tree() {
        // v2：父会话 0101 的子会话 0102 必须进目标集合。
        let Some((_guard, conn)) = fixture("v2-mixed.db") else {
            return;
        };
        let targets = collect_targets(&conn, &["ses_mixed_v2only_0101".to_string()])
            .expect("目标集合计算失败");
        assert!(targets.contains("ses_mixed_v2only_0101"));
        assert!(
            targets.contains("ses_mixed_v2only_0102"),
            "v2 递归：子会话必须进目标集合"
        );

        // v1：父会话的两个子会话不得进目标集合。
        let Some((_guard, conn)) = fixture("test.db") else {
            return;
        };
        let targets = collect_targets(&conn, &["96c5a5bc-4237-4b07-ac06-a7efab9cf637".to_string()])
            .expect("目标集合计算失败");
        assert_eq!(targets.len(), 1, "v1 不递归：只包含所选会话");
        assert!(!targets.contains("ff6feeb6-8bf6-4cff-9791-23c056973e36"));
        assert!(!targets.contains("bd565d35-bd33-4cc1-bcf3-04c39e8e5417"));
    }

    /// 精确删除**不递归**：只删传入的 id，v2 后代必须保留。
    ///
    /// `delete_sessions`（会话删除）保持递归语义；清理执行用精确删除，
    /// 避免用户取消勾选的会话的子会话被连带删除（PR-2 安全修复 P1-1）。
    #[test]
    fn delete_sessions_exact_does_not_recurse_into_v2_descendants() {
        let Some((_guard, conn)) = fixture("v2-mixed.db") else {
            return;
        };

        let outcome =
            delete_sessions_exact(&conn, &["ses_mixed_v2only_0101".to_string()])
                .expect("删除必须成功");
        assert_eq!(outcome.sessions, 1, "只删所给的那一个会话");

        let parent: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM main.session_v2 WHERE id = 'ses_mixed_v2only_0101'",
                [],
                |row| row.get(0),
            )
            .expect("row count");
        assert_eq!(parent, 0, "所给会话必须被删除");

        let child: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM main.session_v2 WHERE id = 'ses_mixed_v2only_0102'",
                [],
                |row| row.get(0),
            )
            .expect("row count");
        assert_eq!(child, 1, "精确删除不得递归删掉 v2 后代");
    }

    /// 删除中途失败必须整单回滚，不能留下删了一半的库。
    #[test]
    fn delete_rolls_back_when_a_step_fails() {
        let Some((_guard, conn)) = fixture("v2-mixed.db") else {
            return;
        };
        conn.execute_batch(
            "CREATE TRIGGER fail_session_v2_delete BEFORE DELETE ON session_v2
             BEGIN SELECT RAISE(ABORT, 'boom'); END;",
        )
        .expect("trigger creates");

        let error = delete_sessions(&conn, &["ses_mixed_both_0201".to_string()])
            .expect_err("删除必须失败");
        assert!(error.contains("boom"), "{error}");

        // 旧表行也不能被删掉：整单回滚。
        let legacy_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM main.message WHERE session_id = 'ses_mixed_both_0201'",
                [],
                |row| row.get(0),
            )
            .expect("row count");
        assert_eq!(legacy_rows, 3, "失败后旧表行必须回滚");

        let v2_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM main.session_message WHERE session_id = 'ses_mixed_both_0201'",
                [],
                |row| row.get(0),
            )
            .expect("row count");
        assert_eq!(v2_rows, 4, "失败后 v2 消息必须回滚");
    }
}
