//! OpenCode 数据库 v1 / v2 方言兼容层。
//!
//! `schema` 模块负责「这个库是什么形态」（v1 / v2 / 混合）并给 `session` 建同名
//! TEMP VIEW；本模块负责**按会话**解析方言，并把 v2 的
//! `session_message.data` 结构翻译成前端既有的 DTO：
//!
//! ```text
//! session_v2 命中  -> Dialect::V2     -> content[] 解析
//! 否则             -> Dialect::Legacy -> 沿用原有 v1 SQL（行为零改动）
//! ```
//!
//! 收口（v2-only）：v2 模式下旧表是迁移后的冻结副本，旧表独有会话不在
//! 列表/搜索/清理范围内；尾消息合并已取消（`SchemaInfo` 不再提供尾 id）。
//!
//! 约束：
//! - 读路径（`messages` / `parts` / `todos`）只读。不建表、不改表、不建索引、
//!   不写 `kv`（SEC-001）。
//! - 写路径集中在 `write` 模块：只写真实表（写 `session` 必须带 `main.` 前缀，
//!   否则会撞上 TEMP VIEW），所有取值参数化（SEC-003）。
//! - 旧表尾消息合并已随 v2-only 收口取消：v2 模式不再读旧表，`Dialect::Legacy`
//!   只在纯 v1 库下由列表入口自然出现。
//! - v1 输出必须逐字段不变：所有 v2 分支都在独立模块/函数中实现，
//!   legacy 分支保持原有 SQL 原样。

use std::collections::BTreeSet;

use rusqlite::{Connection, OptionalExtension};

use crate::models::dto::SessionShareDTO;
use crate::schema::{self, SchemaInfo, SchemaMode};

pub mod messages;
pub mod parts;
pub mod todos;
pub mod write;

/// v2 会话表（带 schema 前缀，供格式化拼接使用；名字只来自编译期常量）。
pub const V2_SESSION_TABLE: &str = "main.session_v2";

const V2_SESSION_NAME: &str = "session_v2";
const LEGACY_MESSAGE_NAME: &str = "message";
const LEGACY_SHARE_NAME: &str = "session_share";

/// 单个会话的消息方言。判定依据只有「`session_v2` 是否有这个 id」，
/// 不依赖版本号、不依赖库整体模式（混合库里两种会话并存）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    /// 会话已迁移到 v2：消息读 `session_message`。
    V2,
    /// 会话只存在于旧表：消息读 `message` / `part`（现有 v1 路径）。
    Legacy,
}

/// 一次命令执行期间共享的兼容上下文。
///
/// 由 [`env`] 从 `DbState` 缓存的 [`SchemaInfo`] 构造，避免每条命令重复探测。
#[derive(Debug, Clone)]
pub struct Env {
    pub mode: SchemaMode,
    pub has_legacy_tables: bool,
}

impl Env {
    /// 是否需要走 v2 表（v1 库为 false，混合库为 true）。
    pub fn is_v2(&self) -> bool {
        self.mode.is_v2()
    }
}

/// 由开库时缓存的 `SchemaInfo` 构造兼容上下文。
///
/// `schema` 为空（例如连接不是经 `db::open` 建立）时退化为廉价探测，
/// 保证命令仍能工作而不是 panic。
pub fn env(conn: &Connection, schema: Option<&SchemaInfo>) -> Env {
    match schema {
        Some(info) if info.mode != SchemaMode::Unsupported => Env {
            mode: info.mode,
            has_legacy_tables: info.has_legacy_tables,
        },
        _ => {
            let mode = schema::detect_mode(conn).unwrap_or(SchemaMode::V1);
            Env {
                mode,
                has_legacy_tables: table_exists(conn, LEGACY_MESSAGE_NAME).unwrap_or(false),
            }
        }
    }
}

/// 会话方言：`session_v2` 命中 → [`Dialect::V2`]，否则 [`Dialect::Legacy`]。
pub fn resolve_dialect(conn: &Connection, session_id: &str) -> rusqlite::Result<Dialect> {
    if !table_exists(conn, V2_SESSION_NAME)? {
        return Ok(Dialect::Legacy);
    }
    let hit = conn
        .query_row(
            &format!("SELECT 1 FROM {V2_SESSION_TABLE} WHERE id = ?1"),
            [session_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    Ok(if hit.is_some() {
        Dialect::V2
    } else {
        Dialect::Legacy
    })
}

/// 批量判定哪些会话属于 v2 方言（一次查询，避免 N 次往返）。
pub fn v2_session_ids_in(
    conn: &Connection,
    session_ids: &[String],
) -> rusqlite::Result<BTreeSet<String>> {
    let mut found = BTreeSet::new();
    if session_ids.is_empty() || !table_exists(conn, V2_SESSION_NAME)? {
        return Ok(found);
    }
    let mut stmt = conn.prepare(&format!(
        "SELECT id FROM {V2_SESSION_TABLE} WHERE id IN (SELECT value FROM json_each(?1))"
    ))?;
    let rows = stmt.query_map([json_array(session_ids)], |row| row.get::<_, String>(0))?;
    for row in rows {
        found.insert(row?);
    }
    Ok(found)
}

/// v2 分享信息：`session_v2.share_url`。
///
/// v2 没有 `session_share` 表，`id` / `secret` 没有对应字段，返回 `None`
/// （前端 `SessionShareDTO` 已允许可空）。`time_created` 取会话创建时间，
/// 与 v1 `session_share.time_created` 语义一致（不是 `time_updated`）。
pub fn v2_share(conn: &Connection, session_id: &str) -> rusqlite::Result<Option<SessionShareDTO>> {
    if !table_exists(conn, V2_SESSION_NAME)? {
        return Ok(None);
    }
    let row = conn
        .query_row(
            &format!("SELECT share_url, time_created FROM {V2_SESSION_TABLE} WHERE id = ?1"),
            [session_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, i64>(1)?,
                ))
            },
        )
        .optional()?;

    let Some((url, time_created)) = row else {
        return Ok(None);
    };
    let Some(url) = url.filter(|url| !url.trim().is_empty()) else {
        return Ok(None);
    };
    Ok(Some(SessionShareDTO {
        session_id: session_id.to_string(),
        id: None,
        secret: None,
        url,
        time_created,
    }))
}

/// v2 会话标题：`COALESCE(title, slug)`（与 `session` 视图口径一致）。
pub fn v2_session_title(conn: &Connection, session_id: &str) -> rusqlite::Result<Option<String>> {
    if !table_exists(conn, V2_SESSION_NAME)? {
        return Ok(None);
    }
    conn.query_row(
        &format!("SELECT COALESCE(title, slug) FROM {V2_SESSION_TABLE} WHERE id = ?1"),
        [session_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
}

/// 旧分享表是否存在。
pub fn has_legacy_share_table(conn: &Connection) -> bool {
    table_exists(conn, LEGACY_SHARE_NAME).unwrap_or(false)
}

/// 只查 `main.sqlite_master` 的表/视图存在性（不读业务数据）。
pub fn table_exists(conn: &Connection, name: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT 1 FROM main.sqlite_master WHERE type IN ('table', 'view') AND name = ?1",
        [name],
        |row| row.get::<_, i64>(0),
    )
    .optional()
    .map(|hit| hit.is_some())
}

/// 序列化为 JSON 数组，供 `json_each(?)` 使用（值仍是参数，不是拼接）。
pub fn json_array(values: &[String]) -> String {
    serde_json::to_string(values).unwrap_or_else(|_| String::from("[]"))
}

#[cfg(test)]
pub(crate) mod test_support {
    use rusqlite::Connection;

    use crate::schema::{self, fixtures, SchemaInfo};

    /// 内存里的 v2-fresh 库（已建好 schema，不含旧表）。
    pub fn v2_fresh() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory database opens");
        conn.execute_batch(fixtures::v2_schema())
            .expect("v2 schema applies");
        conn
    }

    /// 内存里的混合库：v2 表 + 旧 `session` / `message` / `part` 表。
    pub fn v2_mixed() -> Connection {
        let conn = v2_fresh();
        conn.execute_batch(fixtures::v1_schema())
            .expect("legacy schema applies");
        conn
    }

    /// 建立与 `db::open` 等价的兼容上下文（含 `session` TEMP VIEW）。
    pub fn open_env(conn: &Connection) -> SchemaInfo {
        let info = schema::detect(conn).expect("schema detects");
        schema::apply_session_view(conn, &info).expect("session view applies");
        info
    }

    pub fn insert_v2_session(conn: &Connection, id: &str, title: Option<&str>) {
        conn.execute(
            "INSERT INTO session_v2 (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
             VALUES (?1, 'proj', NULL, ?2, '/tmp/project', ?3, '2.1.2', 1000, 2000)",
            rusqlite::params![id, format!("slug-{id}"), title],
        )
        .expect("v2 session inserts");
    }

    pub fn insert_v2_message(
        conn: &Connection,
        id: &str,
        session_id: &str,
        kind: &str,
        seq: i64,
        time_created: i64,
        data: &str,
    ) {
        conn.execute(
            "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)",
            rusqlite::params![id, session_id, kind, seq, time_created, data],
        )
        .expect("v2 message inserts");
    }

    pub fn insert_legacy_session(conn: &Connection, id: &str) {
        // 兼容层会创建同名 TEMP VIEW `session`，因此显式写入 main.session。
        conn.execute(
            "INSERT INTO main.session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
             VALUES (?1, 'proj', NULL, ?2, '/tmp/project', ?3, '1.3.5', 1000, 2000)",
            rusqlite::params![id, format!("slug-{id}"), format!("title-{id}")],
        )
        .expect("legacy session inserts");
    }

    pub fn insert_legacy_message(
        conn: &Connection,
        id: &str,
        session_id: &str,
        time_created: i64,
        role: &str,
    ) {
        conn.execute(
            "INSERT INTO message (id, session_id, time_created, time_updated, data)
             VALUES (?1, ?2, ?3, ?3, ?4)",
            rusqlite::params![id, session_id, time_created, format!("{{\"role\":\"{role}\"}}")],
        )
        .expect("legacy message inserts");
    }

    pub fn insert_legacy_part(
        conn: &Connection,
        id: &str,
        message_id: &str,
        session_id: &str,
        data: &str,
    ) {
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
             VALUES (?1, ?2, ?3, 0, 0, ?4)",
            rusqlite::params![id, message_id, session_id, data],
        )
        .expect("legacy part inserts");
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{insert_v2_session, open_env, v2_mixed};
    use super::{env, resolve_dialect, v2_share, Dialect};

    #[test]
    fn dialect_uses_session_v2_membership_not_database_mode() {
        let conn = v2_mixed();
        open_env(&conn);
        insert_v2_session(&conn, "ses_migrated", Some("迁移会话"));
        conn.execute(
            "INSERT INTO main.session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
             VALUES ('ses_legacy', 'proj', NULL, 'slug', '/tmp', '旧会话', '1.3.5', 1, 2)",
            [],
        )
        .expect("legacy session inserts");

        assert_eq!(
            resolve_dialect(&conn, "ses_migrated").expect("dialect resolves"),
            Dialect::V2
        );
        assert_eq!(
            resolve_dialect(&conn, "ses_legacy").expect("dialect resolves"),
            Dialect::Legacy
        );
        assert_eq!(
            resolve_dialect(&conn, "ses_missing").expect("dialect resolves"),
            Dialect::Legacy
        );
    }

    #[test]
    fn v1_database_resolves_every_session_to_legacy() {
        let conn = v2_mixed();
        conn.execute_batch("DROP TABLE session_message; DROP TABLE session_v2;")
            .expect("v2 tables drop");
        let info = open_env(&conn);

        let compat = env(&conn, Some(&info));
        assert!(!compat.is_v2());
        assert_eq!(
            resolve_dialect(&conn, "anything").expect("dialect resolves"),
            Dialect::Legacy
        );
    }

    #[test]
    fn share_reads_session_v2_share_url_without_id_and_secret() {
        let conn = v2_mixed();
        open_env(&conn);
        insert_v2_session(&conn, "ses_shared", Some("分享会话"));
        conn.execute(
            "UPDATE session_v2 SET share_url = 'https://opncd.ai/s/abc', time_updated = 4242 WHERE id = 'ses_shared'",
            [],
        )
        .expect("share url updates");
        insert_v2_session(&conn, "ses_unshared", Some("未分享会话"));

        let share = v2_share(&conn, "ses_shared")
            .expect("share query runs")
            .expect("share row is returned");
        assert_eq!(share.session_id, "ses_shared");
        assert_eq!(share.url, "https://opncd.ai/s/abc");
        assert_eq!(share.time_created, 1000, "取会话创建时间而非 time_updated");
        assert!(share.id.is_none());
        assert!(share.secret.is_none());

        assert!(v2_share(&conn, "ses_unshared")
            .expect("share query runs")
            .is_none());
        assert!(v2_share(&conn, "ses_missing")
            .expect("share query runs")
            .is_none());
    }
}
