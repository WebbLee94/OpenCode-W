//! Phase 1 schema 探测的夹具集成测试（crate 内 `#[cfg(test)]` 模块）。
//!
//! 直接跑**受版本管理的真实夹具**：`test-data/v2-fresh.db`、`test-data/v2-mixed.db`、
//! `test-data/test.db`，验证探测模式、`session` 兼容视图、尾消息集合与统计口径。
//!
//! ## 为什么放在 crate 内
//!
//! `opencode-w` 是 bin-only crate（没有 `src/lib.rs`），`tests/` 下的集成测试无法
//! `use opencode_w::...`。此前用 `#[path]` 把 `schema`/`db` 编进测试 crate，代价是
//! 两个模块的 `#[cfg(test)]` 单测被重复执行，且 `db.rs` 一旦新增 `crate::compat::*`
//! 之类的依赖就会编译失败。改为普通子模块后：
//!
//! - 只在本 crate 的测试构建中编译（`#[cfg(test)] mod fixture_tests;`），不进入产物；
//! - 路径统一用 `crate::` / `super::`，与生产代码同源，无需 stub、无重复执行；
//! - 不改任何生产函数，唯一的生产侧改动是 `schema/mod.rs` 里的一行 `mod` 声明。
//!
//! ## 夹具缺失时
//!
//! `test-data/*.db` 被 .gitignore 忽略，CI 上必须由 `Generate test fixtures` 步骤生成。
//!
//! - 检测到 `CI` 环境变量（GitHub Actions 默认注入 `CI=true`）：直接 panic，
//!   避免「夹具缺失 → 测试静默跳过 → 假绿」，报错文案指向 Generate test fixtures 步骤。
//! - 本地开发：打印 `[skip]` 与补齐命令后返回，保持可离线开发。
//! - `npm run generate-fixture:v2` → v2-fresh.db / v2-mixed.db
//! - `npm run generate-fixture`    → test.db（v1）
//!
//! 夹具一律先复制到临时目录再开库：`crate::db::open` 会设置 WAL，直接开仓库内文件会污染工作区。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OpenFlags};

use super::{fixtures, MigrationPhase, SchemaMode};

// ---------------------------------------------------------------------------
// 临时目录：夹具一律先复制再用，避免 crate::db::open 的 WAL 设置/连接写回仓库文件
// ---------------------------------------------------------------------------

/// 夹具缺失时的处置策略。
///
/// CI（GitHub Actions 注入 `CI=true`）里夹具缺失必须失败：否则测试会静默跳过，
/// 日志看起来仍是「全部通过」。本地保留 `[skip]`，方便没有夹具时继续开发。
fn missing_fixture_error(file: &str, generate_with: &str, ci: bool) -> Option<String> {
    if ci {
        Some(format!(
            "夹具缺失，检查 Generate test fixtures 步骤：缺少 test-data/{file}（本地可先执行 `{generate_with}`）"
        ))
    } else {
        None
    }
}

fn ci_env_present() -> bool {
    std::env::var_os("CI").is_some()
}

struct TempDb {
    dir: PathBuf,
    path: PathBuf,
}

impl TempDb {
    fn new(label: &str) -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time is after the Unix epoch")
            .as_nanos();
        let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "opencode-w-fixture-it-{label}-{}-{nanos}-{counter}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir is created");
        let path = dir.join("fixture.db");
        TempDb { dir, path }
    }

    /// 复制 `test-data/<file>`。
    ///
    /// 缺失时：CI 环境直接 panic（防止假绿）；本地打印 `[skip]` 并返回 `None`。
    fn copy_fixture(label: &str, file: &str, generate_with: &str) -> Option<Self> {
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../test-data")
            .join(file);
        if !source.is_file() {
            if let Some(message) = missing_fixture_error(file, generate_with, ci_env_present()) {
                panic!("{message}");
            }
            eprintln!(
                "[skip] 缺少夹具 {file}（已被 .gitignore 忽略）：先执行 `{generate_with}` 后重跑 cargo test"
            );
            return None;
        }
        let temp = Self::new(label);
        std::fs::copy(&source, &temp.path).expect("fixture is copied to temp dir");
        Some(temp)
    }

    /// 用给定 DDL 造一个临时库（已存在同名文件时覆盖）。
    fn create(label: &str, sql: &str) -> Self {
        let temp = Self::new(label);
        let conn = Connection::open(&temp.path).expect("temp database is created");
        conn.execute_batch(sql).expect("temp schema applies");
        temp
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

// ---------------------------------------------------------------------------
// 断言辅助
// ---------------------------------------------------------------------------

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |row| row.get(0))
        .unwrap_or_else(|error| panic!("查询失败：{sql} → {error}"))
}

fn duplicate_session_ids(conn: &Connection) -> i64 {
    count(
        conn,
        "SELECT COUNT(*) FROM (SELECT id FROM session GROUP BY id HAVING COUNT(*) > 1)",
    )
}

// ---------------------------------------------------------------------------
// 1. v1 夹具：仍然走 V1 路径，统计与旧口径一致
// ---------------------------------------------------------------------------

#[test]
fn v1_fixture_stays_v1_and_keeps_legacy_statistics() {
    // 开/关库会失效 fork_stats 缓存，与缓存测试串行执行。
    let _cache_guard = crate::commands::fork_stats::test_serial_guard();
    let Some(temp) = TempDb::copy_fixture("v1", "test.db", "npm run generate-fixture") else {
        return;
    };
    let state = crate::db::DbState::new();
    crate::db::open(&state, temp.path_str()).expect("v1 fixture opens");

    let info = state.schema().expect("schema is stored on open");
    assert_eq!(info.mode, SchemaMode::V1, "只有旧表时必须判为 v1");
    assert_eq!(info.migration_phase, MigrationPhase::None);
    assert!(info.has_legacy_tables);
    assert_eq!(info.v2_session_count, 0);
    assert!(info.unsupported_reason.is_none());

    // V1 模式不创建同名 TEMP VIEW，读 SQL 直接命中旧表。
    {
        let pool = crate::db::get_pool(&state.0).expect("pool is available");
        let conn = pool.get().expect("pooled connection");
        let views = count(
            &conn,
            "SELECT COUNT(*) FROM sqlite_temp_master WHERE type = 'view' AND name = 'session'",
        );
        assert_eq!(views, 0, "v1 不应创建 session 视图");
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM session"), 5);
    }

    // 旧口径：part_count = part 表行数（generate-fixture.ts 固定生成 80 行）。
    let stats = crate::db::get_stats(&state.clone_inner());
    assert_eq!(stats.error, None);
    assert_eq!(stats.session_count, 5);
    assert_eq!(stats.root_session_count, 3);
    assert_eq!(stats.child_session_count, 2);
    assert_eq!(stats.project_count, 3);
    assert_eq!(stats.part_count, 80, "v1 仍按 part 行数统计");

    crate::db::close(&state).expect("state closes");
}

// ---------------------------------------------------------------------------
// 2. v2-fresh 夹具：无旧表，视图 6 行且不重复
// ---------------------------------------------------------------------------

#[test]
fn v2_fresh_fixture_detects_v2_without_legacy_tables() {
    // 开/关库会失效 fork_stats 缓存，与缓存测试串行执行。
    let _cache_guard = crate::commands::fork_stats::test_serial_guard();
    let Some(temp) = TempDb::copy_fixture("fresh", "v2-fresh.db", "npm run generate-fixture:v2")
    else {
        return;
    };

    // 只读探测本身不得改动夹具内容（SEC-001：detect 不建表、不改表、不写 kv）。
    let bytes_before = std::fs::read(&temp.path).expect("fixture is readable");
    {
        let probe = Connection::open_with_flags(&temp.path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("read-only probe opens");
        let probed = super::detect(&probe).expect("read-only detect succeeds");
        assert_eq!(probed.mode, SchemaMode::V2Fresh);
        assert_eq!(probed.migration_phase, MigrationPhase::Completed);
        assert_eq!(probed.v2_session_count, 6);
        assert!(probed.unsupported_reason.is_none());
    }
    let bytes_after = std::fs::read(&temp.path).expect("fixture is readable");
    assert_eq!(bytes_before, bytes_after, "detect 不得修改数据库文件内容");


    let state = crate::db::DbState::new();
    crate::db::open(&state, temp.path_str()).expect("v2-fresh fixture opens");

    let info = state.schema().expect("schema is stored on open");
    assert_eq!(info.mode, SchemaMode::V2Fresh);
    assert!(!info.has_legacy_tables);
    assert_eq!(info.migration_phase, MigrationPhase::Completed);
    assert_eq!(info.v2_session_count, 6);

    {
        let pool = crate::db::get_pool(&state.0).expect("pool is available");
        let conn = pool.get().expect("pooled connection");

        // 视图：session_v2 全量 6 行（4 个 v2-only + 2 个混合会话）。
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM session"), 6);
        assert_eq!(duplicate_session_ids(&conn), 0, "视图不得出现重复 id");
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM session WHERE parent_id IS NULL"),
            5
        );
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM session WHERE parent_id IS NOT NULL"),
            1
        );

        // 夹具里确实没有旧表：part_count 的 20 只可能来自 session_message。
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' \
                 AND name IN ('session', 'message', 'part')"
            ),
            0,
            "v2-fresh 不应包含任何旧表"
        );
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM session_message"), 20);

        // title 非空直出；parent 关系保留。
        let title: String = conn
            .query_row(
                "SELECT title FROM session WHERE id = 'ses_fresh_v2only_0001'",
                [],
                |row| row.get(0),
            )
            .expect("v2 session readable through view");
        assert_eq!(title, "v2-fresh 会话 1：完整消息类型覆盖");
    }

    let stats = crate::db::get_stats(&state.clone_inner());
    assert_eq!(stats.error, None);
    assert_eq!(stats.session_count, 6);
    assert_eq!(stats.root_session_count, 5);
    assert_eq!(stats.child_session_count, 1);
    assert_eq!(stats.project_count, 1);
    // 1ef21af：v2 的 part_count 语义改为「session_message 行数」，避免全量 JSON 聚合。
    // 夹具 20 行消息 → 20（不是 content 元素数 15+7=22，也不是 19）。
    assert_eq!(stats.part_count, 20, "v2 的 part_count = 消息行数");

    crate::db::close(&state).expect("state closes");
}

// ---------------------------------------------------------------------------
// 3. v2-mixed 夹具：数据面只操作 v2 表（v2-only 收口）
// ---------------------------------------------------------------------------

#[test]
fn v2_mixed_fixture_v2_only_view_and_statistics() {
    // 开/关库会失效 fork_stats 缓存，与缓存测试串行执行。
    let _cache_guard = crate::commands::fork_stats::test_serial_guard();
    let Some(temp) = TempDb::copy_fixture("mixed", "v2-mixed.db", "npm run generate-fixture:v2")
    else {
        return;
    };
    let state = crate::db::DbState::new();
    crate::db::open(&state, temp.path_str()).expect("v2-mixed fixture opens");

    let info = state.schema().expect("schema is stored on open");
    assert_eq!(info.mode, SchemaMode::V2Mixed);
    assert!(info.has_legacy_tables);
    assert_eq!(info.migration_phase, MigrationPhase::Completed);
    assert_eq!(info.v2_session_count, 6);

    {
        let pool = crate::db::get_pool(&state.0).expect("pool is available");
        let conn = pool.get().expect("pooled connection");

        // v2-only 收口：视图 = 6 个 v2 会话；旧表行（同 id 副本 + legacy-only）不可见。
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM session"), 6);
        assert_eq!(duplicate_session_ids(&conn), 0, "同 ID 会话不得重复出现");
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM session WHERE parent_id IS NULL"),
            5
        );
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM session WHERE parent_id IS NOT NULL"),
            1
        );
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM session WHERE id = 'ses_mixed_legacy_0301'"
            ),
            0,
            "legacy-only 会话不再是 OpenCode-W 的读/清理对象"
        );

        // 同 ID 会话以 v2 为权威来源：标题取 v2 而非旧表「（旧表副本）」。
        let shared_title: String = conn
            .query_row(
                "SELECT title FROM session WHERE id = 'ses_mixed_both_0201'",
                [],
                |row| row.get(0),
            )
            .expect("shared session is visible once");
        assert_eq!(
            shared_title, "v2-mixed 会话 3：v2 与旧表都有（含同 ID 消息与旧表尾消息）",
            "共享 id 必须取 v2 行，不能出现旧表副本"
        );

        // 不丢尾数据：2 条尾消息存在于旧表、且不在 session_message。
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM main.message WHERE id IN \
                 ('ses_mixed_both_0201_msg_tail_00', 'ses_mixed_both_0202_msg_tail_00')"
            ),
            2,
            "尾消息必须仍在旧表可读"
        );
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM main.session_message WHERE id IN \
                 ('ses_mixed_both_0201_msg_tail_00', 'ses_mixed_both_0202_msg_tail_00')"
            ),
            0,
            "尾消息不应出现在 v2 表中"
        );

        // 同 ID 消息 3 条（去重验证的原始数据）。
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM main.message m WHERE EXISTS \
                 (SELECT 1 FROM main.session_message sm WHERE sm.id = m.id)"
            ),
            3
        );
    }

    // 每条池连接都必须自带 session 视图（with_init 生效）。
    {
        let pool = crate::db::get_pool(&state.0).expect("pool is available");
        let first = pool.get().expect("pooled connection 1");
        let second = pool.get().expect("pooled connection 2");
        for conn in [&first, &second] {
            assert_eq!(
                count(
                    conn,
                    "SELECT COUNT(*) FROM sqlite_temp_master WHERE type = 'view' AND name = 'session'"
                ),
                1,
                "每条池连接都要有 session 视图"
            );
            assert_eq!(count(conn, "SELECT COUNT(*) FROM session"), 6);
        }
    }

    let stats = crate::db::get_stats(&state.clone_inner());
    assert_eq!(stats.error, None);
    assert_eq!(stats.session_count, 6, "统计走视图：v2-only");
    assert_eq!(stats.root_session_count, 5);
    assert_eq!(stats.child_session_count, 1);
    assert_eq!(stats.project_count, 1, "legacy-only 的 project_id 不计入");
    // v2-only：part_count 只数 session_message 行数。
    assert_eq!(stats.part_count, 20, "v2 的 part_count = 消息行数");

    crate::db::close(&state).expect("state closes");
}

// ---------------------------------------------------------------------------
// 4. 缺表 / 缺列 → Unsupported，crate::db::open 返回中文错误且 DbState 保持未打开
// ---------------------------------------------------------------------------

#[test]
fn unsupported_database_is_rejected_and_state_stays_closed() {
    // 开/关库会失效 fork_stats 缓存，与缓存测试串行执行。
    let _cache_guard = crate::commands::fork_stats::test_serial_guard();
    // 场景 A：只有一张无关表（旧表与 v2 表都缺）。
    let missing_all = TempDb::create("missing-all", "CREATE TABLE marker (value TEXT);");
    let state = crate::db::DbState::new();
    let error = crate::db::open(&state, missing_all.path_str()).expect_err("unsupported file is rejected");
    assert!(
        error.contains("该文件不是受支持的 OpenCode 数据库"),
        "错误信息应为可操作中文：{error}"
    );
    assert!(error.contains("缺少"), "错误信息应说明缺什么：{error}");
    assert!(!state.is_open(), "Unsupported 时不得建立连接池");
    assert!(state.schema().is_none(), "Unsupported 时不得缓存 schema");
    assert!(state.path().is_none(), "Unsupported 时不得记录路径");

    // 场景 B：v2 库但缺 session_message 表。
    let missing_message = TempDb::create(
        "missing-message",
        fixtures::v2_schema(),
    );
    {
        let conn = Connection::open(&missing_message.path).expect("temp db opens");
        conn.execute_batch("DROP TABLE session_message;")
            .expect("session_message drops");
    }
    let state = crate::db::DbState::new();
    let error =
        crate::db::open(&state, missing_message.path_str()).expect_err("missing v2 table is rejected");
    assert!(error.contains("该文件不是受支持的 OpenCode 数据库"), "{error}");
    assert!(error.contains("session_message"), "需指出缺失的表名：{error}");
    assert!(!state.is_open());
    assert!(state.schema().is_none());

    // 场景 C：v2 库但缺关键列（探测必须报告列名）。
    let missing_column = TempDb::create(
        "missing-column",
        fixtures::v2_schema(),
    );
    {
        let conn = Connection::open(&missing_column.path).expect("temp db opens");
        conn.execute_batch("ALTER TABLE session_v2 DROP COLUMN fork_session_id;")
            .expect("fork_session_id drops");
        let info = super::detect(&conn).expect("unsupported database still detects");
        assert_eq!(info.mode, SchemaMode::Unsupported);
        let reason = info.unsupported_reason.expect("reason is present");
        assert!(
            reason.contains("session_v2.fork_session_id"),
            "需指出缺失列：{reason}"
        );
    }
    let state = crate::db::DbState::new();
    let error = crate::db::open(&state, missing_column.path_str()).expect_err("missing column is rejected");
    assert!(error.contains("该文件不是受支持的 OpenCode 数据库"), "{error}");
    assert!(error.contains("fork_session_id"), "需指出缺失列：{error}");
    assert!(!state.is_open());
    assert!(state.schema().is_none());
}

// ---------------------------------------------------------------------------
// 5. migration.phase = running → 可只读浏览，但写命令必须被拒绝
// ---------------------------------------------------------------------------

#[test]
fn migration_running_fixture_is_read_only_and_rejects_writes() {
    // 开/关库会失效 fork_stats 缓存，与缓存测试串行执行。
    let _cache_guard = crate::commands::fork_stats::test_serial_guard();
    let temp = TempDb::create(
        "running",
        &format!(
            "{} \
             INSERT INTO kv (key, value, time_created) \
             VALUES ('migration.v1-v2', '{{\"phase\":\"running\"}}', 1); \
             INSERT INTO session_v2 \
               (id, project_id, slug, directory, title, version, time_created, time_updated) \
             VALUES ('ses_running', 'proj', 'running', '/tmp/running', '迁移中会话', '2.1.2', 1000, 2000);",
            fixtures::v2_schema()
        ),
    );

    let state = crate::db::DbState::new();
    crate::db::open(&state, temp.path_str()).expect("running migration still opens for read-only browse");

    let info = state.schema().expect("schema is stored");
    assert_eq!(info.mode, SchemaMode::V2Fresh);
    assert_eq!(info.migration_phase, MigrationPhase::Running);
    assert!(state.is_open());
    assert!(state.is_read_only(), "迁移中必须标记为只读");

    // rename / move / delete / cleanup / restore 的统一闸门。
    let error = crate::db::ensure_writable(&state).expect_err("write must be rejected");
    assert_eq!(error, crate::db::READ_ONLY_MESSAGE);
    assert!(error.contains("正在迁移数据库"), "{error}");

    {
        let pool = crate::db::get_pool(&state.0).expect("pool is available");
        let conn = pool.get().expect("pooled connection");
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM session"),
            1,
            "迁移中仍可只读浏览"
        );
    }

    crate::db::close(&state).expect("state closes");
    assert!(!state.is_open());
    assert!(!state.is_read_only(), "关闭后不再是只读状态");
    assert!(state.schema().is_none());
}

#[test]
fn failed_migration_is_also_read_only() {
    let _cache_guard = crate::commands::fork_stats::test_serial_guard();
    let temp = TempDb::create(
        "failed",
        &format!(
            "{} \
             INSERT INTO kv (key, value, time_created) \
             VALUES ('migration.v1-v2', '{{\"phase\":\"failed\"}}', 1);",
            fixtures::v2_schema()
        ),
    );

    let state = crate::db::DbState::new();
    crate::db::open(&state, temp.path_str()).expect("failed migration still opens read-only");

    let info = state.schema().expect("schema is stored");
    assert_eq!(info.migration_phase, MigrationPhase::Failed);
    assert!(state.is_read_only(), "迁移失败同样禁止写入");
    assert_eq!(
        crate::db::ensure_writable(&state),
        Err(crate::db::READ_ONLY_MESSAGE.to_string())
    );

    crate::db::close(&state).expect("state closes");
}

// ---------------------------------------------------------------------------
// 6. 夹具缺失策略：CI 失败、本地跳过
// ---------------------------------------------------------------------------

#[test]
fn missing_fixture_fails_on_ci_and_skips_locally() {
    let message = missing_fixture_error("v2-mixed.db", "npm run generate-fixture:v2", true)
        .expect("CI 缺少夹具必须报错");
    assert!(message.contains("Generate test fixtures"), "{message}");
    assert!(message.contains("v2-mixed.db"), "{message}");

    assert!(
        missing_fixture_error("v2-mixed.db", "npm run generate-fixture:v2", false).is_none(),
        "本地开发允许跳过"
    );
}
