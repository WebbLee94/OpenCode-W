//! OpenCode 数据库 schema 探测与进程内兼容视图。
//!
//! 探测只读：仅查询 `main.sqlite_master`、`main.kv` 的 `migration.v1-v2` 记录，
//! 以及按主键求差集的计数；不建表、不改表、不写 `kv`（SEC-001）。
//!
//! v2 模式下在**每条池连接**上创建同名 `TEMP VIEW "session"`，
//! 让既有读 SQL（`FROM session`）无需改动即可命中 v2 数据。
//!
//! 收口（v2-only）：视图只投影 `session_v2`。v1 → v2 迁移留
//! 在旧表里的冻结副本（legacy-only 会话、同 id 副本、尾消息）不再是
//! OpenCode-W 需要读或清理的对象——v1 → v2 迁移由 OpenCode 自己负责，
//! 因此 v2-mixed 与 v2-fresh 在数据面上行为一致：只操作 v2 表。
//! `message` / `part` 没有（也从未有）同名视图。

use std::collections::BTreeSet;

use rusqlite::{Connection, OptionalExtension};

/// `session` 兼容视图暴露的列集合（v1 结构）。
///
/// 现有读 SQL 依赖这些列名；视图按两端表的实际可用列逐列补齐，
/// 缺失列以 `NULL` 占位，保证 v1/v2 使用同一份 SQL。
const SESSION_COLUMNS: &[&str] = &[
    "id",
    "project_id",
    "parent_id",
    "slug",
    "directory",
    "title",
    "version",
    "share_url",
    "summary_additions",
    "summary_deletions",
    "summary_files",
    "summary_diffs",
    "revert",
    "permission",
    "time_created",
    "time_updated",
    "time_compacting",
    "time_archived",
    "workspace_id",
    "path",
    "agent",
    "model",
    "cost",
    "tokens_input",
    "tokens_output",
    "tokens_reasoning",
    "tokens_cache_read",
    "tokens_cache_write",
    "metadata",
];

const V2_SESSION_TABLE: &str = "session_v2";
const V2_MESSAGE_TABLE: &str = "session_message";
const LEGACY_SESSION_TABLE: &str = "session";
const LEGACY_MESSAGE_TABLE: &str = "message";
const LEGACY_PART_TABLE: &str = "part";
const KV_TABLE: &str = "kv";
const MIGRATION_KEY: &str = "migration.v1-v2";

/// v2 表必须提供的列。缺少任意一列说明不是受支持的 v2 结构
/// （例如未来小版本改名），按 `Unsupported` 处理并报告列名。
const V2_SESSION_REQUIRED_COLUMNS: &[&str] = &[
    "id",
    "project_id",
    "slug",
    "directory",
    "version",
    "time_created",
    "time_updated",
    "fork_session_id",
];
const V2_MESSAGE_REQUIRED_COLUMNS: &[&str] = &[
    "id",
    "session_id",
    "type",
    "seq",
    "data",
    "time_created",
];

/// 当前数据库的 schema 形态。
///
/// 判断依据是表/列的存在性与主键差集，**不使用版本号**（RISK-001）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum SchemaMode {
    /// 只有旧 `session` / `message` / `part` 表。
    #[serde(rename = "v1")]
    V1,
    /// 只有 v2 `session_v2` / `session_message` 表。
    #[serde(rename = "v2")]
    V2Fresh,
    /// v2 表与旧表并存（迁移后保留旧表）。
    #[serde(rename = "v2-mixed")]
    V2Mixed,
    /// 缺少必需的表或列。
    #[serde(rename = "unsupported")]
    Unsupported,
}

impl SchemaMode {
    /// 是否需要同名 `session` 视图（仅 v2 数据）。
    fn needs_session_view(self) -> bool {
        matches!(self, SchemaMode::V2Fresh | SchemaMode::V2Mixed)
    }

    /// 是否读取 v2 表（供统计分支使用）。
    pub fn is_v2(self) -> bool {
        self.needs_session_view()
    }
}

/// `kv` 中 `migration.v1-v2` 记录的迁移阶段。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MigrationPhase {
    /// 没有记录（v1 库或尚未迁移）。
    None,
    Running,
    Completed,
    Failed,
    /// 记录存在但无法解析。
    Unknown,
}

/// 探测结果，也是跨 IPC 暴露的 `SchemaInfoDTO`。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaInfo {
    pub mode: SchemaMode,
    pub migration_phase: MigrationPhase,
    /// 库里存在旧 `session` / `message` / `part` 表（v1 库或迁移后保留旧表的
    /// v2-mixed 库）。仅作呈现用途；v2 形态下旧表是冻结副本，数据面只操作 v2 表。
    pub has_legacy_tables: bool,
    pub v2_session_count: i64,
    pub unsupported_reason: Option<String>,
}

/// 跨 IPC 边界的 DTO 名称。与 `SchemaInfo` 同构，避免维护两套映射。
pub type SchemaInfoDTO = SchemaInfo;

impl SchemaInfo {
    fn unsupported(
        migration_phase: MigrationPhase,
        has_legacy_tables: bool,
        reason: String,
    ) -> Self {
        SchemaInfo {
            mode: SchemaMode::Unsupported,
            migration_phase,
            has_legacy_tables,
            v2_session_count: 0,
            unsupported_reason: Some(reason),
        }
    }
}

/// 探测过程中的 SQLite 错误。
#[derive(Debug)]
pub struct SchemaError {
    message: String,
}

impl std::fmt::Display for SchemaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SchemaError {}

impl From<rusqlite::Error> for SchemaError {
    fn from(error: rusqlite::Error) -> Self {
        SchemaError {
            message: error.to_string(),
        }
    }
}

/// 探测当前连接对应的 OpenCode 数据库形态。
///
/// 只读取 `sqlite_master`、`kv` 与主键差集，不读取业务内容。
pub fn detect(conn: &Connection) -> Result<SchemaInfo, SchemaError> {
    let tables = existing_tables(conn)?;
    let has_legacy_tables = has_any_legacy_table(&tables);
    let migration_phase = read_migration_phase(conn, tables.contains(KV_TABLE))?;

    if !tables.contains(V2_SESSION_TABLE) && !tables.contains(V2_MESSAGE_TABLE) {
        let missing: Vec<&str> = [LEGACY_SESSION_TABLE, LEGACY_MESSAGE_TABLE, LEGACY_PART_TABLE]
            .into_iter()
            .filter(|table| !tables.contains(*table))
            .collect();
        if !missing.is_empty() {
            return Ok(SchemaInfo::unsupported(
                migration_phase,
                has_legacy_tables,
                format!("缺少 {} 表", missing.join("、")),
            ));
        }

        // v1 路径：不做任何额外查询，计数全部沿用既有 SQL。
        return Ok(SchemaInfo {
            mode: SchemaMode::V1,
            migration_phase,
            has_legacy_tables: true,
            v2_session_count: 0,
            unsupported_reason: None,
        });
    }

    let missing_tables: Vec<&str> = [V2_SESSION_TABLE, V2_MESSAGE_TABLE]
        .into_iter()
        .filter(|table| !tables.contains(*table))
        .collect();
    if !missing_tables.is_empty() {
        return Ok(SchemaInfo::unsupported(
            migration_phase,
            has_legacy_tables,
            format!("缺少 {} 表", missing_tables.join("、")),
        ));
    }

    let session_columns = table_columns(conn, V2_SESSION_TABLE)?;
    let message_columns = table_columns(conn, V2_MESSAGE_TABLE)?;
    let mut missing_columns: Vec<String> = Vec::new();
    for column in V2_SESSION_REQUIRED_COLUMNS {
        if !session_columns
            .iter()
            .any(|available| available.as_str() == *column)
        {
            missing_columns.push(format!("{V2_SESSION_TABLE}.{column}"));
        }
    }
    for column in V2_MESSAGE_REQUIRED_COLUMNS {
        if !message_columns
            .iter()
            .any(|available| available.as_str() == *column)
        {
            missing_columns.push(format!("{V2_MESSAGE_TABLE}.{column}"));
        }
    }
    if !missing_columns.is_empty() {
        return Ok(SchemaInfo::unsupported(
            migration_phase,
            has_legacy_tables,
            format!("缺少必要列：{}", missing_columns.join("、")),
        ));
    }

    let v2_session_count = count_v2_sessions(conn)?;

    Ok(SchemaInfo {
        mode: if has_legacy_tables {
            SchemaMode::V2Mixed
        } else {
            SchemaMode::V2Fresh
        },
        migration_phase,
        has_legacy_tables,
        v2_session_count,
        unsupported_reason: None,
    })
}

/// 写操作后刷新缓存里的计数（TASK-026）。
///
/// 复用与 [`detect`] 同一条 SQL，避免写路径再跑一遍全表扫描：
/// `v2_session_count` = `main.session_v2` 行数。
///
/// v1 库没有这个计数，直接返回（保持 `detect` 的 v1 口径）。
pub fn refresh_counts(conn: &Connection, info: &mut SchemaInfo) -> Result<(), SchemaError> {
    if !info.mode.is_v2() {
        return Ok(());
    }
    info.v2_session_count = count_v2_sessions(conn)?;
    Ok(())
}

/// `main.session_v2` 行数（v1 库为 0）。
fn count_v2_sessions(conn: &Connection) -> rusqlite::Result<i64> {
    scalar_count(conn, "SELECT COUNT(*) FROM main.session_v2")
}

/// 廉价模式探测（只查 `sqlite_master`，不做计数）。
///
/// 供统计等热路径使用；列级校验只发生在 `detect`（开库时）。
pub fn detect_mode(conn: &Connection) -> Result<SchemaMode, SchemaError> {
    Ok(classify(&existing_tables(conn)?))
}

/// 在连接上创建 v2 兼容的 `TEMP VIEW "session"`。
///
/// 由池的 `with_init` 调用，因此每条池连接都拥有该视图；视图只存在于
/// 连接的 temp schema 中，不会写入用户数据库（SEC-001）。
///
/// 收口（v2-only）：只投影 `session_v2`，不再并集旧 `session` 行
/// （旧表是冻结副本，legacy-only 会话不再是 OpenCode-W 的读/清理对象）。
pub fn apply_session_view(conn: &Connection, info: &SchemaInfo) -> rusqlite::Result<()> {
    if !info.mode.needs_session_view() {
        return Ok(());
    }

    let v2_columns = table_columns(conn, V2_SESSION_TABLE)?;
    if v2_columns.is_empty() {
        return Ok(());
    }

    conn.execute_batch(&build_session_view_sql(&v2_columns))
}

fn classify(tables: &BTreeSet<String>) -> SchemaMode {
    let has_v2 = tables.contains(V2_SESSION_TABLE) || tables.contains(V2_MESSAGE_TABLE);
    if has_v2 {
        if has_any_legacy_table(tables) {
            SchemaMode::V2Mixed
        } else {
            SchemaMode::V2Fresh
        }
    } else if tables.contains(LEGACY_SESSION_TABLE)
        && tables.contains(LEGACY_MESSAGE_TABLE)
        && tables.contains(LEGACY_PART_TABLE)
    {
        SchemaMode::V1
    } else {
        SchemaMode::Unsupported
    }
}

fn has_any_legacy_table(tables: &BTreeSet<String>) -> bool {
    tables.contains(LEGACY_SESSION_TABLE)
        || tables.contains(LEGACY_MESSAGE_TABLE)
        || tables.contains(LEGACY_PART_TABLE)
}

fn existing_tables(conn: &Connection) -> rusqlite::Result<BTreeSet<String>> {
    let mut stmt =
        conn.prepare("SELECT name FROM main.sqlite_master WHERE type IN ('table', 'view')")?;
    let names = stmt.query_map([], |row| row.get::<_, String>(0))?;
    let mut tables = BTreeSet::new();
    for name in names {
        tables.insert(name?);
    }
    Ok(tables)
}

/// 表名只来自本模块常量，禁止拼接外部输入（SEC-003）。
fn table_columns(conn: &Connection, table: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA main.table_info(\"{table}\")"))?;
    let columns = stmt.query_map([], |row| row.get::<_, String>(1))?;
    let mut names = Vec::new();
    for column in columns {
        names.push(column?);
    }
    Ok(names)
}

fn scalar_count(conn: &Connection, sql: &str) -> rusqlite::Result<i64> {
    conn.query_row(sql, [], |row| row.get(0))
}

fn read_migration_phase(
    conn: &Connection,
    has_kv_table: bool,
) -> rusqlite::Result<MigrationPhase> {
    if !has_kv_table {
        return Ok(MigrationPhase::None);
    }

    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM main.kv WHERE key = ?1",
            [MIGRATION_KEY],
            |row| row.get(0),
        )
        .optional()?;

    let Some(raw) = raw else {
        return Ok(MigrationPhase::None);
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Ok(MigrationPhase::Unknown);
    };

    Ok(match value.get("phase").and_then(|phase| phase.as_str()) {
        Some("completed") => MigrationPhase::Completed,
        Some("running") => MigrationPhase::Running,
        Some("failed") => MigrationPhase::Failed,
        _ => MigrationPhase::Unknown,
    })
}

/// 生成视图 DDL（v2-only）。
///
/// - `title` 使用 `COALESCE(title, slug)`：v2 的 `title` 可空，slug 一定有值；
/// - v2 缺失的列以 `NULL AS "列名"` 补齐，保证与 v1 读 SQL 的列序一致。
fn build_session_view_sql(v2_columns: &[String]) -> String {
    let mut sql = String::from("DROP VIEW IF EXISTS temp.\"session\";\n");
    sql.push_str("CREATE TEMP VIEW \"session\" AS\nSELECT ");
    sql.push_str(&projection("v", v2_columns));
    sql.push_str(&format!("\nFROM main.\"{V2_SESSION_TABLE}\" AS v"));

    sql
}

fn projection(alias: &str, columns: &[String]) -> String {
    let has_slug = columns.iter().any(|available| available.as_str() == "slug");
    SESSION_COLUMNS
        .iter()
        .map(|&column| {
            let present = columns.iter().any(|available| available.as_str() == column);
            if column == "title" {
                if present && has_slug {
                    format!("COALESCE({alias}.\"title\", {alias}.\"slug\") AS \"title\"")
                } else if has_slug {
                    format!("{alias}.\"slug\" AS \"title\"")
                } else {
                    String::from("NULL AS \"title\"")
                }
            } else if present {
                format!("{alias}.\"{column}\" AS \"{column}\"")
            } else {
                format!("NULL AS \"{column}\"")
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
pub(crate) mod fixtures {
    /// 最小 v1 结构：`session` / `message` / `part`（列与真实 v1 库一致）。
    pub fn v1_schema() -> &'static str {
        "CREATE TABLE session (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            parent_id TEXT,
            slug TEXT NOT NULL,
            directory TEXT NOT NULL,
            title TEXT NOT NULL,
            version TEXT NOT NULL,
            share_url TEXT,
            summary_additions INTEGER,
            summary_deletions INTEGER,
            summary_files INTEGER,
            summary_diffs TEXT,
            revert TEXT,
            permission TEXT,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            time_compacting INTEGER,
            time_archived INTEGER,
            workspace_id TEXT,
            path TEXT,
            agent TEXT,
            model TEXT,
            cost REAL DEFAULT 0 NOT NULL,
            tokens_input INTEGER DEFAULT 0 NOT NULL,
            tokens_output INTEGER DEFAULT 0 NOT NULL,
            tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
            tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
            tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
            metadata TEXT
        );
        CREATE TABLE message (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            data TEXT NOT NULL
        );
        CREATE TABLE part (
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            data TEXT NOT NULL
        );"
    }

    /// v2 结构：`session_v2` / `session_message`，列与真实 v2.1.2 库一致。
    pub fn v2_schema() -> &'static str {
        "CREATE TABLE session_v2 (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            workspace_id TEXT,
            parent_id TEXT,
            fork_session_id TEXT,
            fork_boundary TEXT,
            slug TEXT NOT NULL,
            directory TEXT NOT NULL,
            path TEXT,
            title TEXT,
            version TEXT NOT NULL,
            share_url TEXT,
            summary_additions INTEGER,
            summary_deletions INTEGER,
            summary_files INTEGER,
            summary_diffs TEXT,
            metadata TEXT,
            cost REAL DEFAULT 0 NOT NULL,
            tokens_input INTEGER DEFAULT 0 NOT NULL,
            tokens_output INTEGER DEFAULT 0 NOT NULL,
            tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
            tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
            tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
            revert TEXT,
            permission TEXT,
            agent TEXT,
            model TEXT,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            time_compacting INTEGER,
            time_archived INTEGER,
            time_suspended INTEGER,
            resume_attempts INTEGER DEFAULT 0 NOT NULL,
            time_idle INTEGER,
            time_viewed INTEGER,
            idle_outcome TEXT
        );
        CREATE TABLE session_message (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            type TEXT NOT NULL,
            seq INTEGER NOT NULL,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            data TEXT NOT NULL
        );
        CREATE TABLE kv (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            time_created INTEGER NOT NULL
        );"
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::{
        apply_session_view, detect, detect_mode, fixtures, MigrationPhase, SchemaInfo, SchemaMode,
    };

    fn connect(schema: Option<&str>) -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory database opens");
        if let Some(schema) = schema {
            conn.execute_batch(schema).expect("fixture schema applies");
        }
        conn
    }

    fn insert_session(conn: &Connection, id: &str, parent_id: Option<&str>) {
        conn.execute(
            "INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
             VALUES (?1, 'proj', ?2, ?3, '/tmp/project', ?4, '1.3.5', 1000, 2000)",
            rusqlite::params![id, parent_id, format!("slug-{id}"), format!("title-{id}")],
        )
        .expect("legacy session inserts");
    }

    fn insert_v2_session(conn: &Connection, id: &str, parent_id: Option<&str>, title: Option<&str>) {
        conn.execute(
            "INSERT INTO session_v2 (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
             VALUES (?1, 'proj', ?2, ?3, '/tmp/project', ?4, '2.1.2', 1000, 2000)",
            rusqlite::params![id, parent_id, format!("slug-{id}"), title],
        )
        .expect("v2 session inserts");
    }

    fn insert_v2_message(conn: &Connection, id: &str, session_id: &str, kind: &str, seq: i64) {
        conn.execute(
            "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
             VALUES (?1, ?2, ?3, ?4, 1000, 2000, ?5)",
            rusqlite::params![id, session_id, kind, seq, "{\"content\":[]}".to_string()],
        )
        .expect("v2 message inserts");
    }

    #[test]
    fn v1_database_stays_v1_without_extra_count_queries() {
        let conn = connect(Some(fixtures::v1_schema()));
        insert_session(&conn, "ses_root", None);
        insert_session(&conn, "ses_child", Some("ses_root"));

        let info = detect(&conn).expect("v1 database detects");

        assert_eq!(info.mode, SchemaMode::V1);
        assert_eq!(info.migration_phase, MigrationPhase::None);
        assert!(info.has_legacy_tables);
        assert_eq!(info.v2_session_count, 0);
        assert!(info.unsupported_reason.is_none());
        assert_eq!(detect_mode(&conn).expect("mode detects"), SchemaMode::V1);
    }

    #[test]
    fn schema_info_serializes_to_the_shared_ipc_contract() {
        let info = SchemaInfo {
            mode: SchemaMode::V2Mixed,
            migration_phase: MigrationPhase::Running,
            has_legacy_tables: true,
            v2_session_count: 6,
            unsupported_reason: None,
        };

        let json = serde_json::to_value(&info).expect("schema info serializes");

        assert_eq!(json["mode"], "v2-mixed");
        assert_eq!(json["migrationPhase"], "running");
        assert_eq!(json["hasLegacyTables"], true);
        assert_eq!(json["v2SessionCount"], 6);
        assert!(json["unsupportedReason"].is_null());

        for (mode, expected) in [
            (SchemaMode::V1, "v1"),
            (SchemaMode::V2Fresh, "v2"),
            (SchemaMode::V2Mixed, "v2-mixed"),
            (SchemaMode::Unsupported, "unsupported"),
        ] {
            let value = serde_json::to_value(mode).expect("mode serializes");
            assert_eq!(value, expected);
        }
        for (phase, expected) in [
            (MigrationPhase::None, "none"),
            (MigrationPhase::Running, "running"),
            (MigrationPhase::Completed, "completed"),
            (MigrationPhase::Failed, "failed"),
            (MigrationPhase::Unknown, "unknown"),
        ] {
            let value = serde_json::to_value(phase).expect("phase serializes");
            assert_eq!(value, expected);
        }
    }

    #[test]
    fn v2_fresh_database_is_detected_without_legacy_tables() {
        let conn = connect(Some(fixtures::v2_schema()));
        insert_v2_session(&conn, "ses_v2", None, Some("v2 title"));
        conn.execute(
            "INSERT INTO kv (key, value, time_created) VALUES ('migration.v1-v2', '{\"phase\":\"completed\"}', 1)",
            [],
        )
        .expect("kv row inserts");

        let info = detect(&conn).expect("v2 database detects");

        assert_eq!(info.mode, SchemaMode::V2Fresh);
        assert_eq!(info.migration_phase, MigrationPhase::Completed);
        assert!(!info.has_legacy_tables);
        assert_eq!(info.v2_session_count, 1);
        assert_eq!(detect_mode(&conn).expect("mode detects"), SchemaMode::V2Fresh);
    }

    #[test]
    fn mixed_database_is_detected_but_view_stays_v2_only() {
        let conn = connect(Some(fixtures::v1_schema()));
        conn.execute_batch(fixtures::v2_schema()).expect("v2 schema applies");
        insert_v2_session(&conn, "ses_v2", None, Some("v2 title"));
        insert_session(&conn, "ses_v2", None);
        insert_session(&conn, "ses_legacy_only", None);
        insert_v2_message(&conn, "msg_v2", "ses_v2", "assistant", 1);
        conn.execute(
            "INSERT INTO message (id, session_id, time_created, time_updated, data)
             VALUES ('msg_tail_in_migrated', 'ses_v2', 3000, 3000, '{}'),
                    ('msg_legacy_only_session', 'ses_legacy_only', 3000, 3000, '{}')",
            [],
        )
        .expect("legacy messages insert");

        let info = detect(&conn).expect("mixed database detects");

        assert_eq!(info.mode, SchemaMode::V2Mixed);
        assert_eq!(info.migration_phase, MigrationPhase::None);
        assert!(info.has_legacy_tables);
        assert_eq!(info.v2_session_count, 1);

        // v2-only 收口后的视图：旧表副本（同 id 或 legacy-only）一律不可见。
        apply_session_view(&conn, &info).expect("session view applies");
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM session", [], |row| row.get(0))
            .expect("view counts");
        assert_eq!(rows, 1, "视图只暴露 session_v2 行");

        let legacy_visible: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM session WHERE id IN ('ses_legacy_only', 'ses_v2_missing')",
                [],
                |row| row.get(0),
            )
            .expect("legacy-only probe");
        assert_eq!(legacy_visible, 0, "legacy-only 会话不再是 OpenCode-W 的对象");
    }

    #[test]
    fn mixed_view_reads_session_v2_only_and_v2_wins_on_shared_ids() {
        let conn = connect(Some(fixtures::v1_schema()));
        conn.execute_batch(fixtures::v2_schema()).expect("v2 schema applies");
        insert_v2_session(&conn, "ses_shared", None, Some("v2 title"));
        insert_v2_session(&conn, "ses_v2_only", Some("ses_shared"), None);
        insert_session(&conn, "ses_shared", None);
        insert_session(&conn, "ses_legacy_only", None);

        let info = detect(&conn).expect("mixed database detects");
        apply_session_view(&conn, &info).expect("session view applies");

        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM session", [], |row| row.get(0))
            .expect("view counts");
        assert_eq!(rows, 2, "只暴露 session_v2 的两行，旧表行不可见");

        let duplicated: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM (SELECT id FROM session GROUP BY id HAVING COUNT(*) > 1)",
                [],
                |row| row.get(0),
            )
            .expect("duplicate probe");
        assert_eq!(duplicated, 0);

        let fallback_title: String = conn
            .query_row(
                "SELECT title FROM session WHERE id = 'ses_v2_only'",
                [],
                |row| row.get(0),
            )
            .expect("v2 session is readable");
        assert_eq!(fallback_title, "slug-ses_v2_only", "title 为空时回退 slug");

        let v2_title: String = conn
            .query_row("SELECT title FROM session WHERE id = 'ses_shared'", [], |row| {
                row.get(0)
            })
            .expect("shared session is readable");
        assert_eq!(v2_title, "v2 title", "共享 id 以 v2 为权威来源");
    }

    #[test]
    fn fresh_v2_view_reads_session_v2_only() {
        let conn = connect(Some(fixtures::v2_schema()));
        insert_v2_session(&conn, "ses_a", None, Some("a"));
        insert_v2_session(&conn, "ses_b", Some("ses_a"), None);

        let info = detect(&conn).expect("v2 database detects");
        apply_session_view(&conn, &info).expect("session view applies");

        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM session", [], |row| row.get(0))
            .expect("view counts");
        assert_eq!(rows, 2);
        let roots: i64 = conn
            .query_row("SELECT COUNT(*) FROM session WHERE parent_id IS NULL", [], |row| {
                row.get(0)
            })
            .expect("root count");
        assert_eq!(roots, 1);
    }

    #[test]
    fn v1_database_gets_no_session_view() {
        let conn = connect(Some(fixtures::v1_schema()));
        insert_session(&conn, "ses_root", None);

        let info = detect(&conn).expect("v1 database detects");
        apply_session_view(&conn, &info).expect("apply is a no-op");

        let temp_views: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_temp_master WHERE type = 'view'",
                [],
                |row| row.get(0),
            )
            .expect("temp master is queryable");
        assert_eq!(temp_views, 0);
    }

    #[test]
    fn missing_columns_are_reported_as_unsupported_with_the_column_name() {
        let conn = connect(Some(fixtures::v2_schema()));
        conn.execute_batch("ALTER TABLE session_v2 DROP COLUMN fork_session_id;")
            .expect("column drops");

        let info = detect(&conn).expect("unsupported database still detects");

        assert_eq!(info.mode, SchemaMode::Unsupported);
        let reason = info.unsupported_reason.expect("reason is present");
        assert!(reason.contains("session_v2.fork_session_id"), "reason: {reason}");
    }

    #[test]
    fn missing_tables_are_reported_as_unsupported() {
        let conn = connect(Some("CREATE TABLE marker (value TEXT);"));

        let info = detect(&conn).expect("unsupported database still detects");

        assert_eq!(info.mode, SchemaMode::Unsupported);
        let reason = info.unsupported_reason.expect("reason is present");
        assert!(reason.contains("session") && reason.contains("message"), "reason: {reason}");
        assert_eq!(
            detect_mode(&conn).expect("mode detects"),
            SchemaMode::Unsupported
        );
    }

    #[test]
    fn migration_phase_is_read_from_kv() {
        let conn = connect(Some(fixtures::v2_schema()));
        conn.execute(
            "INSERT INTO kv (key, value, time_created) VALUES ('migration.v1-v2', '{\"phase\":\"running\"}', 1)",
            [],
        )
        .expect("kv row inserts");

        assert_eq!(
            detect(&conn).expect("detects").migration_phase,
            MigrationPhase::Running
        );

        conn.execute(
            "UPDATE kv SET value = '{\"phase\":\"failed\"}' WHERE key = 'migration.v1-v2'",
            [],
        )
        .expect("kv row updates");
        assert_eq!(
            detect(&conn).expect("detects").migration_phase,
            MigrationPhase::Failed
        );

        conn.execute(
            "UPDATE kv SET value = 'not json' WHERE key = 'migration.v1-v2'",
            [],
        )
        .expect("kv row updates");
        assert_eq!(
            detect(&conn).expect("detects").migration_phase,
            MigrationPhase::Unknown
        );
    }
}

/// 基于 `test-data/` 真实夹具的探测/视图集成测试。
///
/// 仅在本 crate 的测试构建中编译，不进入产物；夹具缺失时测试会打印 `[skip]`。
#[cfg(test)]
mod fixture_tests;
