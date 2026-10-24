use tauri::{AppHandle, Manager, State};

use crate::db::{self, DbState};
use crate::models::dto::IpcResult;
use crate::schema::SchemaInfoDTO;
use crate::security;

/// database:open — validate and open a database file.
///
/// Mirrors electron/main.ts DATABASE_OPEN handler:
///   1. validate_db_path (path traversal protection)
///   2. validate_db_extension (.db / .sqlite / .sqlite3 only)
///   3. db::open (opens connection, sets WAL + foreign_keys pragmas)
///
/// 前端调用：`invokeSafe('database:open', filePath)` — 单字符串参数，
/// ipc.ts 包装为 `{ value: filePath }`，Tauri 匹配到 `value` 命名参数。
///
/// 此命令保持同步 — 打开数据库很快，且后续操作依赖连接建立完成。
#[tauri::command]
pub fn database_open(app: AppHandle, db: State<DbState>, value: String) -> IpcResult<String> {
    let path = value;
    let validated = match security::validate_db_path(&path) {
        Ok(p) => p,
        Err(e) => return IpcResult::err(e),
    };
    if let Err(e) = security::validate_db_extension(&validated) {
        return IpcResult::err(e);
    }

    let path_str = validated.to_string_lossy().to_string();
    match db::open(&db, &path_str) {
        Ok(abs_path) => {
            // 换了库就重新建立/增量更新全文索引（后台线程，不阻塞返回）。
            let db_state = db.inner().clone();
            let index = app.state::<crate::search::SearchIndex>().inner().clone();
            crate::search::ensure(&app, &db_state, &index);
            IpcResult::ok(abs_path)
        }
        Err(e) => IpcResult::err(e),
    }
}

/// database:info — 返回当前库的 schema 形态与迁移阶段。
///
/// 探测在 `db::open` 时完成（只读连接 + `sqlite_master` / `kv`），默认只读取
/// 缓存，因此命令很轻量。
///
/// `refresh`（TASK-051）：传 `true` 时用**新的只读连接**重新探测，供设置页
/// 「重新检测」使用；缺省 / `false` 保持只读缓存的既有行为。重新探测
/// **不重建连接池**，正在进行的读操作不会被打断。
///
/// 重新探测只更新**探测快照**，**不改生效形态**（PR-2 安全修复 P2-13）：
/// 命令仍按开库时的形态路由，UI 展示探测到的新形态。
///
/// `unsupported` 也要拿得到信息（TASK-051）：`db::open` 探测失败时不会写
/// schema 缓存，但设置页仍要显示 `mode` 与 `unsupportedReason`。因此探测结果
/// **原样返回**（`mode = unsupported` + 原因），**不转成错误**。
///
/// 探测在 14.8 GB 真库上要扫尾消息集合，可能耗时上百毫秒到数秒，因此命令
/// 走 `spawn_blocking`，不阻塞主线程。
///
/// 前端调用：`invokeSafe('database:info', { refresh: true })` —— Tauri 会把
/// payload 里的 `refresh` 字段匹配到同名命令参数；不传时该参数为 `None`。
#[tauri::command]
pub async fn database_info(app: AppHandle, refresh: Option<bool>) -> IpcResult<SchemaInfoDTO> {
    let state = app.state::<DbState>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || match schema_info(&state, refresh) {
        Ok(info) => IpcResult::ok(info),
        Err(e) => IpcResult::err(e),
    })
    .await
    .unwrap_or_else(|e| IpcResult::err(format!("thread error: {}", e)))
}

/// `database:info` 的实际逻辑（与 Tauri 命令分离，便于单测）。
///
/// - `refresh = false`：优先返回**探测快照**（最近一次「重新检测」的结果），
///   没有则返回**生效形态**（开库时探测出来的）；两者都没有才现场探测；
/// - `refresh = true`：用只读连接重新探测，返回**探测快照**（没有则生效形态）；
/// - 探测结果**原样返回**：`mode = unsupported` 与 `unsupportedReason` 都要
///   交给前端展示，不能转成错误；
/// - 两者都没有 → 「没有已连接的数据库」。
///
/// **生效形态与探测快照必须分开**（PR-2 安全修复 P2-13）：同名 `session` 是
/// TEMP VIEW，按连接生效。运行期形态变化时命令仍按生效形态路由，UI 则展示
/// 探测到的最新形态并提示用户重新打开数据库。
fn schema_info(db: &DbState, refresh: Option<bool>) -> Result<SchemaInfoDTO, String> {
    if refresh != Some(true) {
        if let Some(info) = db.detected_schema() {
            return Ok(info);
        }
        if let Some(info) = db.schema() {
            return Ok(info);
        }
    }
    db.refresh_schema()
}

/// database:vacuum — run VACUUM and return before/after sizes.
///
/// 使用 spawn_blocking 避免阻塞主线程（VACUUM 在大数据库上可能很慢）。
#[tauri::command]
pub async fn database_vacuum(app: AppHandle) -> IpcResult<db::VacuumResult> {
    let state = app.state::<DbState>();
    if let Err(e) = db::ensure_writable(&state) {
        return IpcResult::err(e);
    }
    let db = state.clone_inner();
    tauri::async_runtime::spawn_blocking(move || {
        match db::vacuum(&db) {
            Ok(result) => IpcResult::ok(result),
            Err(e) => IpcResult::err(e),
        }
    })
    .await
    .unwrap_or_else(|e| IpcResult::err(format!("thread error: {}", e)))
}

/// database:checkpoint — run WAL checkpoint (TRUNCATE mode).
///
/// 使用 spawn_blocking 避免阻塞主线程。
#[tauri::command]
pub async fn database_checkpoint(app: AppHandle) -> IpcResult<bool> {
    let state = app.state::<DbState>();
    if let Err(e) = db::ensure_writable(&state) {
        return IpcResult::err(e);
    }
    let db = state.clone_inner();
    tauri::async_runtime::spawn_blocking(move || {
        match db::checkpoint(&db) {
            Ok(()) => IpcResult::ok(true),
            Err(e) => IpcResult::err(e),
        }
    })
    .await
    .unwrap_or_else(|e| IpcResult::err(format!("thread error: {}", e)))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use rusqlite::Connection;

    use super::schema_info;
    use crate::db::DbState;
    use crate::schema::SchemaMode;

    static FIXTURE_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn fixture_path(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time is after the Unix epoch")
            .as_nanos();
        let counter = FIXTURE_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "opencode-w-database-{label}-{nonce}-{counter}.db"
        ))
    }

    /// 一个缺少 `session` / `session_message` 的库 → 探测结果是 unsupported。
    fn unsupported_db(path: &PathBuf) {
        let conn = Connection::open(path).expect("fixture database opens");
        conn.execute_batch("CREATE TABLE marker (value TEXT);")
            .expect("marker table applies");
    }

    #[test]
    fn no_database_and_no_attempt_reports_that_there_is_none() {
        let state = DbState::new();
        let error = schema_info(&state, None).expect_err("没有库时必须报错");
        assert!(error.contains("没有已连接的数据库"), "{error}");
        let error = schema_info(&state, Some(true)).expect_err("没有库时必须报错");
        assert!(error.contains("没有已连接的数据库"), "{error}");
    }

    /// 缺表临时库 → `database_info(refresh=true)` 必须给出 mode=unsupported 与
    /// 非空原因，且**不得**打开连接池。
    ///
    /// 这正是「应用启动时自动打开一个不受支持的库」的场景：`db::open` 返回
    /// Err、从未 set_path，但 `last_attempt_path` 记下了路径，所以这里拿到的是
    /// 「无法识别的数据库格式 + 原因」，而不是「没有已连接的数据库」。
    #[test]
    fn unsupported_database_is_reported_after_a_failed_open() {
        let path = fixture_path("unsupported");
        unsupported_db(&path);
        let state = DbState::new();

        // PR-1 契约：unsupported 的打开仍然返回 Err，不得改成 Ok。
        let error = crate::db::open(&state, path.to_str().expect("UTF-8 path"))
            .expect_err("不受支持的库必须被拒绝");
        assert!(error.contains("受支持的 OpenCode 数据库"), "{error}");
        assert!(!state.is_open(), "探测失败不得打开连接池");
        assert!(
            state.schema().is_none(),
            "探测失败不得写入 schema 缓存"
        );
        assert_eq!(
            state.last_attempt_path().as_deref(),
            std::fs::canonicalize(&path)
                .expect("path resolves")
                .to_str(),
            "必须记住本次尝试的路径"
        );

        // refresh=true：返回 unsupported + 原因，且不打开连接池。
        let info = schema_info(&state, Some(true)).expect("重新探测必须成功");
        assert_eq!(info.mode, SchemaMode::Unsupported);
        let reason = info.unsupported_reason.expect("必须有原因");
        assert!(!reason.trim().is_empty(), "原因不能为空");
        assert!(!state.is_open(), "重新探测不得打开连接池");

        // 缓存缺失时（不传 refresh）同样要拿得到 unsupported 信息。
        let state2 = DbState::new();
        assert!(crate::db::open(&state2, path.to_str().expect("UTF-8 path")).is_err());
        let info = schema_info(&state2, None).expect("缓存缺失时应重新探测");
        assert_eq!(info.mode, SchemaMode::Unsupported);
        assert!(info.unsupported_reason.is_some());

        crate::db::remove_fixture_file_if_exists(&path);
    }

    /// 已打开的库：默认直接返回缓存，不重新探测。
    #[test]
    fn an_open_database_returns_the_cached_schema_without_probing() {
        // 开库会失效 fork_stats 缓存，与缓存测试串行执行。
        let _cache_guard = crate::commands::fork_stats::test_serial_guard();
        let path = fixture_path("v1");
        {
            let conn = Connection::open(&path).expect("fixture database opens");
            conn.execute_batch(crate::schema::fixtures::v1_schema())
                .expect("v1 schema applies");
        }
        let state = DbState::new();
        crate::db::open(&state, path.to_str().expect("UTF-8 path")).expect("v1 opens");

        let info = schema_info(&state, None).expect("缓存必须可用");
        assert_eq!(info.mode, SchemaMode::V1);

        // refresh=true 重新探测同一个库，结果一致。
        let refreshed = schema_info(&state, Some(true)).expect("重新探测必须成功");
        assert_eq!(refreshed.mode, SchemaMode::V1);

        // 先关掉连接池再删夹具：Windows 不允许删除仍被句柄占用的文件。
        crate::db::close(&state).expect("state closes fixture");
        crate::db::remove_fixture_file_if_exists(&path);
    }

    /// v2-mixed 夹具：`refresh=false` 命中缓存，`refresh=true` 重新探测不报错。
    #[test]
    fn v2_mixed_fixture_refresh_hits_the_cache_and_reprobes_cleanly() {
        // 开/关库会失效 fork_stats 缓存，与缓存测试串行执行。
        let _cache_guard = crate::commands::fork_stats::test_serial_guard();
        // 夹具被 .gitignore 忽略：缺失时跳过（CI 会先生成）。
        let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../test-data/v2-mixed.db");
        if !source.is_file() {
            eprintln!("[skip] 缺少夹具 v2-mixed.db（先执行 `npm run generate-fixture:v2`）");
            return;
        }
        let path = fixture_path("v2-mixed");
        std::fs::copy(&source, &path).expect("fixture is copied");
        let state = DbState::new();
        crate::db::open(&state, path.to_str().expect("UTF-8 path")).expect("v2-mixed opens");

        // refresh=false：命中开库时的缓存。
        let cached = schema_info(&state, None).expect("缓存必须可用");
        assert_eq!(cached.mode, SchemaMode::V2Mixed);
        assert_eq!(cached.v2_session_count, 6);

        // refresh=true：重新探测，不能报错，形态与计数应一致。
        let refreshed = schema_info(&state, Some(true)).expect("重新探测必须成功");
        assert_eq!(refreshed.mode, SchemaMode::V2Mixed);
        assert_eq!(refreshed.v2_session_count, 6);
        assert!(state.is_open(), "重新探测不得关闭连接池");

        // 先关掉连接池再删夹具：Windows 不允许删除仍被句柄占用的文件。
        crate::db::close(&state).expect("state closes fixture");
        crate::db::remove_fixture_file_if_exists(&path);
    }

    /// P2-13：探测快照与生效形态分离。
    ///
    /// v1 库在运行期出现 v2 表 → `refresh=true` 返回**新形态**（UI 展示），
    /// 但生效形态不变（命令仍按池内旧视图路由）。
    #[test]
    fn a_refresh_reports_the_detected_schema_without_changing_the_active_one() {
        // 开/关库会失效 fork_stats 缓存，与缓存测试串行执行。
        let _cache_guard = crate::commands::fork_stats::test_serial_guard();
        let path = fixture_path("p2-13");
        {
            let conn = Connection::open(&path).expect("fixture database opens");
            conn.execute_batch(crate::schema::fixtures::v1_schema())
                .expect("v1 schema applies");
        }
        let state = DbState::new();
        crate::db::open(&state, path.to_str().expect("UTF-8 path")).expect("v1 opens");
        assert_eq!(
            state.schema().expect("生效形态已记录").mode,
            SchemaMode::V1
        );

        // 运行期出现 v2 表。
        {
            let conn = Connection::open(&path).expect("fixture reopens");
            conn.execute_batch(crate::schema::fixtures::v2_schema())
                .expect("v2 schema applies");
        }

        let refreshed = schema_info(&state, Some(true)).expect("重新探测必须成功");
        assert_eq!(refreshed.mode, SchemaMode::V2Mixed, "探测看到新形态");
        assert_eq!(
            state.schema().expect("生效形态").mode,
            SchemaMode::V1,
            "生效形态不得被刷新覆盖：命令要按池内旧视图路由"
        );
        assert_eq!(
            state
                .detected_schema()
                .expect("探测快照已更新")
                .mode,
            SchemaMode::V2Mixed
        );

        // 后续的普通查询继续给 UI 展示探测到的形态（不与生效形态来回跳）。
        let cached = schema_info(&state, None).expect("缓存必须可用");
        assert_eq!(cached.mode, SchemaMode::V2Mixed);

        crate::db::close(&state).expect("state closes fixture");
        crate::db::remove_fixture_file_if_exists(&path);
    }
}
