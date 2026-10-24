#![allow(dead_code)]

use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::ops::Deref;
use std::path::Path;
use std::sync::{Arc, Mutex};

use crate::schema::{MigrationPhase, SchemaInfo, SchemaMode};

// ─── 测试夹具清理（跨平台）─────────────────────────────────────────────
//
// Windows 不允许删除仍被句柄打开的文件；r2d2 连接池是**异步**回收连接的，
// 因此 `close()` 之后立刻 `remove_file` 仍可能拿到
// “The process cannot access the file because it is being used by another process”。
//
// 统一策略：
// - 先尝试删除，明显不是「文件被占用」的错误立即失败；
// - 命中「文件被占用」（Windows sharing violation / lock violation / access denied）
//   时重试约 5 秒（100 × 50ms），等待句柄释放；
// - 仍失败：**非 Windows 平台继续 panic**（保留 macOS/Linux 的严格性，
//   能发现真实的句柄泄漏）；Windows 平台打印警告后放过
//   （夹具在临时目录、文件名唯一，残留无害）。

/// 删除测试夹具文件（存在即删）。
#[cfg(test)]
pub(crate) fn remove_fixture_file(path: &Path) {
    remove_fixture_with_retry(path, "fixture database is removed", || {
        std::fs::remove_file(path)
    });
}

/// 删除测试夹具文件；文件不存在时静默跳过（`-wal` / `-shm` 侧车文件常用）。
#[cfg(test)]
pub(crate) fn remove_fixture_file_if_exists(path: &Path) {
    remove_fixture_with_retry(path, "fixture file is removed", || {
        match std::fs::remove_file(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            other => other,
        }
    });
}

/// 递归删除测试夹具目录。
#[cfg(test)]
pub(crate) fn remove_fixture_dir(path: &Path) {
    remove_fixture_with_retry(path, "fixture directory is removed", || {
        std::fs::remove_dir_all(path)
    });
}

/// 带重试的删除：见文件顶部说明。
#[cfg(test)]
fn remove_fixture_with_retry<F>(path: &Path, label: &str, mut remove: F)
where
    F: FnMut() -> std::io::Result<()>,
{
    const RETRIES: usize = 100;
    const RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(50);

    let mut last_error = None;
    for attempt in 0..=RETRIES {
        match remove() {
            Ok(()) => return,
            Err(error) => {
                let retryable = is_file_in_use(&error);
                last_error = Some(error);
                if !retryable || attempt == RETRIES {
                    break;
                }
                std::thread::sleep(RETRY_DELAY);
            }
        }
    }

    let error = last_error.expect("删除失败时一定拿到错误");
    if cfg!(target_os = "windows") {
        eprintln!(
            "[warn] {label}: Windows 仍占用该文件，跳过清理（残留无害）：{path:?}（{error}）"
        );
    } else {
        panic!("{label}: {error}");
    }
}

/// 错误是否表示「文件仍被其他句柄占用」。
#[cfg(test)]
fn is_file_in_use(error: &std::io::Error) -> bool {
    if cfg!(target_os = "windows") {
        // ERROR_ACCESS_DENIED(5) / ERROR_SHARING_VIOLATION(32) / ERROR_LOCK_VIOLATION(33)
        matches!(error.raw_os_error(), Some(5 | 32 | 33))
    } else {
        // EBUSY(16) / ETXTBSY(26)
        matches!(error.raw_os_error(), Some(16 | 26))
    }
}

/// Get a pooled connection from the database state.
///
/// The Mutex is held only briefly to clone the Pool; the actual connection
/// is acquired from the pool after releasing the lock, allowing parallel reads.
pub fn get_conn(
    state: &Mutex<Option<Pool<SqliteConnectionManager>>>,
) -> Result<impl Deref<Target = Connection> + '_ + Send, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let pool = guard
        .as_ref()
        .ok_or_else(|| String::from("No database currently open"))?
        .clone();
    drop(guard);
    pool.get().map_err(|e| e.to_string())
}

/// Convenience wrapper: get a pooled connection from an `&Arc<Mutex<Option<Pool<...>>>>`.
/// Auto-derefs through Arc so callers can pass `&db` directly.
pub fn get_db(
    state: &Arc<Mutex<Option<Pool<SqliteConnectionManager>>>>,
) -> Result<impl Deref<Target = Connection> + '_, String> {
    get_conn(state.as_ref())
}

/// Tauri State for database connection pool management.
///
/// Wraps `Arc<Mutex<Option<r2d2::Pool>>>` to support interior mutability
/// for open/close while allowing parallel reads via `get_pool()`.
/// The Mutex is held only briefly (to clone the pool), not during SQL execution.
///
/// Also stores the resolved [`SchemaInfo`] so every command can branch on the
/// database dialect without re-probing, and so `database:info` is a cheap read.
///
/// 字段：
/// 1. 连接池（公开：`clone_inner` 供命令取连接）；
/// 2. 当前**已打开**的库路径；
/// 3. **当前生效的** schema（命令路由用它选方言）；
/// 4. 最近一次**打开尝试**的绝对路径（探测失败 / close 都不清除）；
/// 5. **最近一次探测到的** schema（UI 展示 / 比较用）。
///
/// 3 与 5 必须分开（PR-2 安全修复 P2-13）：同名 `session` 是 TEMP VIEW，
/// **按连接生效**。运行期形态变化（OpenCode 完成迁移）时，连接池里的视图
/// 仍是旧形态；若把探测结果写回「生效 schema」，命令就会按新 mode 路由到
/// 旧连接池上（v2-fresh 会 `no such table`，v1→v2-mixed 会静默少算）。
/// 因此：探测只更新「探测快照」，只有 `db::open` 成功才更新「生效 schema」。
#[derive(Clone)]
pub struct DbState(
    pub Arc<Mutex<Option<Pool<SqliteConnectionManager>>>>,
    Arc<Mutex<Option<String>>>,
    Arc<Mutex<Option<SchemaInfo>>>,
    Arc<Mutex<Option<String>>>,
    Arc<Mutex<Option<SchemaInfo>>>,
);

impl DbState {
    pub fn new() -> Self {
        DbState(
            Arc::new(Mutex::new(None)),
            Arc::new(Mutex::new(None)),
            Arc::new(Mutex::new(None)),
            Arc::new(Mutex::new(None)),
            Arc::new(Mutex::new(None)),
        )
    }

    /// Clone the Arc for move into spawn_blocking closures.
    pub fn clone_inner(&self) -> Arc<Mutex<Option<Pool<SqliteConnectionManager>>>> {
        Arc::clone(&self.0)
    }

    pub fn is_open(&self) -> bool {
        self.0.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    /// 迁移进行中或迁移失败时，数据库处于只读状态。
    ///
    /// `OpenCode` 迁移期间写入会破坏它自己的迁移事务，因此所有写命令都必须
    /// 先经过 [`ensure_writable`]。
    pub fn is_read_only(&self) -> bool {
        matches!(
            self.schema().map(|info| info.migration_phase),
            Some(MigrationPhase::Running | MigrationPhase::Failed)
        )
    }

    pub fn path(&self) -> Option<String> {
        self.1.lock().ok().and_then(|path| path.clone())
    }

    /// 最近一次「打开尝试」的绝对路径。
    ///
    /// 与 [`DbState::path`]（当前已打开的库）不同：**探测失败与 close 都不会
    /// 清除它**。用途：`db::open` 探测失败（例如库结构不受支持）时没有 schema
    /// 缓存，但设置页仍需要显示 `mode` 与 `unsupportedReason` —— 靠这个路径
    /// 可以再做一次只读探测（TASK-051）。
    pub fn last_attempt_path(&self) -> Option<String> {
        self.3.lock().ok().and_then(|path| path.clone())
    }

    /// **当前生效的** schema：开库时探测出来的形态，命令据此选方言。
    ///
    /// 只在 `db::open` 成功时更新。重新探测（[`DbState::refresh_schema`]）
    /// **不会**改它——连接池里的 TEMP VIEW 仍按旧形态建立。
    pub fn schema(&self) -> Option<SchemaInfo> {
        self.2.lock().ok().and_then(|schema| schema.clone())
    }

    /// **最近一次探测到的** schema：给 UI 展示与「形态是否变化」比较用。
    ///
    /// 与 [`DbState::schema`]（生效形态）分开：`database:info(refresh=true)`
    /// 返回它，让设置页看到「文件现在是什么样」；命令仍按生效形态路由。
    pub fn detected_schema(&self) -> Option<SchemaInfo> {
        self.4.lock().ok().and_then(|schema| schema.clone())
    }

    /// Store the validated path so path-only operations never lease a connection.
    fn set_path(&self, path: String) {
        if let Ok(mut current) = self.1.lock() {
            *current = Some(path);
        }
    }

    /// 记住本次打开尝试的路径（探测之前调用）。
    ///
    /// 探测失败时也要记住：设置页需要据此重新探测出「结构不受支持」的原因
    /// （TASK-051）。`close` 不会清除它。
    fn set_last_attempt_path(&self, path: String) {
        if let Ok(mut current) = self.3.lock() {
            *current = Some(path);
        }
    }

    fn clear_path(&self) {
        if let Ok(mut current) = self.1.lock() {
            *current = None;
        }
    }

    fn set_schema(&self, info: SchemaInfo) {
        if let Ok(mut current) = self.2.lock() {
            *current = Some(info);
        }
    }

    fn clear_schema(&self) {
        if let Ok(mut current) = self.2.lock() {
            *current = None;
        }
    }

    fn set_detected_schema(&self, info: SchemaInfo) {
        if let Ok(mut current) = self.4.lock() {
            *current = Some(info);
        }
    }

    fn clear_detected_schema(&self) {
        if let Ok(mut current) = self.4.lock() {
            *current = None;
        }
    }

    /// 写操作后刷新缓存的 [`SchemaInfo`] 计数与尾消息 id（TASK-026）。
    ///
    /// 缓存放在 `DbState` 里，因此刷新后**池内所有连接**与所有命令都能看到
    /// 同一份最新计数，不会出现「已删除的会话仍被算进 `v2SessionCount`」。
    /// 模式与迁移阶段不在此处改动：写操作不改变库的形态。
    ///
    /// 探测快照（[`DbState::detected_schema`]）在**形态一致**时同步刷新计数，
    /// 避免 UI 看到过期数字；形态不一致（运行期迁移）时保持探测时的快照不动。
    pub fn refresh_schema_counts(&self, conn: &Connection) -> Result<(), String> {
        let Some(mut info) = self.schema() else {
            return Ok(());
        };
        crate::schema::refresh_counts(conn, &mut info).map_err(|e| e.to_string())?;
        let mode = info.mode;
        self.set_schema(info);
        if let Some(mut detected) = self.detected_schema() {
            if detected.mode == mode && crate::schema::refresh_counts(conn, &mut detected).is_ok()
            {
                self.set_detected_schema(detected);
            }
        }
        Ok(())
    }

    /// 只读重新探测 schema（`database:info` 的 refresh 路径，TASK-051）。
    ///
    /// - 探测对象：优先 [`DbState::path`]（当前已打开的库），没有则用
    ///   [`DbState::last_attempt_path`]（最近一次打开尝试的路径）。
    ///   `db::open` 在**探测之前**就记下了它，因此「启动时自动打开一个
    ///   不受支持的库」这种场景（`db::open` 返回 Err、从未 set_path）也能
    ///   拿到 `mode = unsupported` 与原因，而不是「没有已连接的数据库」。
    /// - 用**新的只读连接**执行 `schema::detect`：不借用连接池的连接，探测与
    ///   业务查询互不干扰，也不会在用户库里产生任何写入（SEC-001）。
    /// - 返回值**原样包含** `mode = Unsupported` 与 `unsupportedReason`：
    ///   设置页要把它们显示成徽标，**不把 unsupported 转成 Err**。
    /// - **只更新探测快照**（[`DbState::detected_schema`]），**不改生效形态**
    ///   （[`DbState::schema`]）：同名 `session` 是 TEMP VIEW，按连接生效，
    ///   运行期形态变化时池内连接仍是旧形态。若把探测结果写回生效形态，
    ///   命令就会按新 mode 路由到旧连接池上（v2-fresh 会 `no such table`，
    ///   v1→v2-mixed 会静默少算）。形态变化需要重开连接池才生效
    ///   （前端会比较刷新前后的 mode 并提示用户「请重新打开数据库」）。
    /// - **不重建连接池**：正在进行的读操作继续用旧连接，不会被打断。
    pub fn refresh_schema(&self) -> Result<SchemaInfo, String> {
        let Some(path) = self.path().or_else(|| self.last_attempt_path()) else {
            return Err(String::from("没有已连接的数据库"));
        };
        let info = detect_schema_at(&path)?;
        self.set_detected_schema(info.clone());
        Ok(info)
    }
}

/// 只读闸门的统一错误文案（前端可直接展示）。
pub const READ_ONLY_MESSAGE: &str = "OpenCode 正在迁移数据库，暂时只读";

/// 写入命令的统一前置检查：迁移中 / 迁移失败时拒绝写操作。
///
/// 只看**开库时的缓存**：用于 UI 快速判断（例如按钮置灰）。缓存不会随
/// OpenCode 的迁移实时更新，因此写命令还必须在拿到连接后调用
/// [`ensure_writable_conn`] 做一次实时检查。
pub fn ensure_writable(state: &DbState) -> Result<(), String> {
    if state.is_read_only() {
        Err(READ_ONLY_MESSAGE.to_string())
    } else {
        Ok(())
    }
}

/// `kv` 表里迁移记录的键（与 `schema::detect` 保持一致）。
const MIGRATION_KEY: &str = "migration.v1-v2";

/// 写命令的**实时**迁移闸门：在连接上直接读 `main.kv` 的迁移阶段。
///
/// 为什么要实时查：用户可能先打开应用、之后 OpenCode 才启动迁移。此时
/// `DbState` 里的 schema 缓存仍是开库时的旧值（迁移前），只查缓存会放行
/// 写操作，而此时 OpenCode 正在写同一个库，写入会破坏它的迁移事务。
///
/// 判定口径与缓存检查一致（`running` / `failed` 拒绝写）：
/// - `kv` 表不存在 → v1 库，放行；
/// - `kv` 里没有 `migration.v1-v2` 记录 → 没有迁移在进行，放行；
/// - 阶段为 `running` / `failed` → 拒绝，返回 [`READ_ONLY_MESSAGE`]；
/// - **SQL 失败 → 保守拒绝**（无法确认状态时不得放行破坏性写入）。
///
/// 只读查询：不建表、不改表、不写 `kv`（SEC-001）。
pub fn ensure_writable_conn(conn: &Connection) -> Result<(), String> {
    let kv_exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM main.sqlite_master WHERE type = 'table' AND name = 'kv'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("无法确认数据库迁移状态，已阻止写入：{}", e))?;
    if kv_exists == 0 {
        // v1 库没有 kv 表：没有迁移状态可查，放行。
        return Ok(());
    }

    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM main.kv WHERE key = ?1",
            [MIGRATION_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("无法确认数据库迁移状态，已阻止写入：{}", e))?;
    let Some(raw) = raw else {
        // 没有迁移记录：放行。
        return Ok(());
    };

    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        // 记录存在但无法解析：与缓存检查保持一致（`unknown` 不阻断写入）。
        return Ok(());
    };

    match value.get("phase").and_then(|phase| phase.as_str()) {
        Some("running") | Some("failed") => Err(READ_ONLY_MESSAGE.to_string()),
        _ => Ok(()),
    }
}

/// Lock briefly and clone the Pool for parallel read access.
///
/// The Mutex is released immediately after cloning, allowing concurrent
/// threads to each obtain their own connection via `pool.get()`.
pub fn get_pool(
    state: &Mutex<Option<Pool<SqliteConnectionManager>>>,
) -> Result<Pool<SqliteConnectionManager>, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    guard
        .as_ref()
        .map(|p| p.clone())
        .ok_or_else(|| "No database currently open".into())
}

/// 用**只读连接**对指定路径做一次 schema 探测。
///
/// 只读探测：不建表、不改表、不写 `kv`（SEC-001 / SEC-004）。探测不到表结构
/// 时返回 `SchemaMode::Unsupported` 与原因，而不是报错——设置页要把它显示成
/// 徽标，而不是一句英文错误。
fn detect_schema_at(path: &str) -> Result<SchemaInfo, String> {
    let probe = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("无法以只读方式打开数据库文件：{}", e))?;
    crate::schema::detect(&probe).map_err(|e| format!("无法识别数据库结构：{}", e))
}

/// Open a database file and create a connection pool (4 connections, WAL mode).
///
/// 1. 用独立只读连接探测 schema（不改写用户库）。
/// 2. `Unsupported` 直接返回中文错误，避免后续命令各自报 `no such table`。
/// 3. v2 模式下把 `TEMP VIEW session` 放进 `with_init`，保证池内每条连接都有。
///
/// 探测**之前**就记住本次尝试的绝对路径：探测失败时没有 schema 缓存，
/// 设置页仍要靠这个路径重新探测出「结构不受支持」的原因（TASK-051）。
pub fn open(
    state: &DbState,
    db_path: &str,
) -> Result<String, String> {
    if !Path::new(db_path).exists() {
        return Err(format!("Database file not found: {}", db_path));
    }

    let abs_path = std::path::PathBuf::from(db_path)
        .canonicalize()
        .map_err(|e| format!("Database path could not be resolved: {}", e))?;
    let abs_path_str = abs_path.to_string_lossy().to_string();
    // 探测失败也要留下痕迹：设置页的「重新检测」需要据此给出 unsupported 原因。
    state.set_last_attempt_path(abs_path_str.clone());

    // Probe on a separate read-only connection so detection never writes.
    let info = detect_schema_at(&abs_path_str)?;
    if info.mode == SchemaMode::Unsupported {
        return Err(format!(
            "该文件不是受支持的 OpenCode 数据库（{}）",
            info.unsupported_reason
                .as_deref()
                .unwrap_or("缺少 session_message / session_v2 等表")
        ));
    }

    let view_info = info.clone();
    let manager = SqliteConnectionManager::file(&abs_path).with_init(move |conn| {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             PRAGMA cache_size = -64000;
             PRAGMA mmap_size = 268435456;
             PRAGMA synchronous = NORMAL;
             PRAGMA temp_store = MEMORY;
             PRAGMA threads = 4;
             PRAGMA busy_timeout = 5000;",
        )?;
        crate::schema::apply_session_view(conn, &view_info)
    });

    let pool = Pool::builder()
        .max_size(4)
        // 大库上的长查询可能占满 4 个连接；等待连接的上限要高于查询耗时，
        // 否则会直接报 pool timeout 而不是排队后完成。
        .connection_timeout(std::time::Duration::from_secs(180))
        .build(manager)
        .map_err(|e| e.to_string())?;

    // 先写 path / schema，最后发布 pool：
    // 不变式：pool 最后发布 → 任何持有 pool 的读者必然已看到 SchemaInfo
    //（tail_ids 非空），不会出现「pool 已可见、schema 仍为 None」而短暂
    // 丢尾消息的窗口；close 的顺序相反（先撤 pool，再清 path / schema）。
    state.set_path(abs_path_str.clone());
    state.set_schema(info);
    // 开库成功 → 生效形态与探测快照重新对齐（快照清空，下次探测再填）。
    state.clear_detected_schema();
    let mut lock = state.0.lock().map_err(|e| e.to_string())?;
    *lock = Some(pool);
    drop(lock);
    crate::commands::fork_stats::invalidate_cache();
    Ok(abs_path_str)
}

/// Close the current database pool.
pub fn close(
    state: &DbState,
) -> Result<(), String> {
    // 先撤掉 pool，再清 path / schema：新读者立即失败，不会读到半关闭状态。
    let mut lock = state.0.lock().map_err(|e| e.to_string())?;
    *lock = None;
    drop(lock);
    state.clear_path();
    state.clear_schema();
    state.clear_detected_schema();
    crate::commands::fork_stats::invalidate_cache();
    Ok(())
}

/// Lightweight health check for UI refreshes.
pub fn lightweight_health_check(
    state: &Mutex<Option<Pool<SqliteConnectionManager>>>,
) -> HealthInfo {
    let lock = match state.lock() {
        Ok(l) => l,
        Err(e) => {
            return HealthInfo {
                ok: false,
                page_count: 0,
                freelist_pages: 0,
                wal_size: 0,
                db_size: 0,
                current_path: None,
                error: Some(e.to_string()),
            };
        }
    };
    let pool = match lock.as_ref() {
        Some(pool) => pool.clone(),
        None => {
            return HealthInfo {
                ok: false,
                page_count: 0,
                freelist_pages: 0,
                wal_size: 0,
                db_size: 0,
                current_path: None,
                error: Some("No database open".into()),
            };
        }
    };
    drop(lock);
    let conn = match pool.get() {
        Ok(c) => c,
        Err(e) => {
            return HealthInfo {
                ok: false,
                page_count: 0,
                freelist_pages: 0,
                wal_size: 0,
                db_size: 0,
                current_path: None,
                error: Some(e.to_string()),
            };
        }
    };

    lightweight_health_from_connection(&conn)
}

fn lightweight_health_from_connection(conn: &Connection) -> HealthInfo {
    let page_count: i64 = conn
        .query_row("PRAGMA page_count", [], |row| row.get(0))
        .unwrap_or(0);
    let freelist_count: i64 = conn
        .query_row("PRAGMA freelist_count", [], |row| row.get(0))
        .unwrap_or(0);

    let current_path = conn.path().map(|p| p.to_string());

    // WAL file size
    let wal_size = current_path
        .as_ref()
        .and_then(|p| {
            let wal_path = format!("{}-wal", p);
            std::fs::metadata(&wal_path).ok().map(|m| m.len() as i64)
        })
        .unwrap_or(0);

    // Database file size
    let db_size = current_path
        .as_ref()
        .and_then(|p| std::fs::metadata(p).ok().map(|m| m.len() as i64))
        .unwrap_or(0);

    HealthInfo {
        ok: true,
        page_count,
        freelist_pages: freelist_count,
        wal_size,
        db_size,
        current_path: current_path.clone(),
        error: None,
    }
}

/// Run SQLite's full integrity diagnostic on explicit user request.
pub fn integrity_check(
    state: &Mutex<Option<Pool<SqliteConnectionManager>>>,
) -> IntegrityCheckResult {
    let lock = match state.lock() {
        Ok(lock) => lock,
        Err(error) => return IntegrityCheckResult::error(error.to_string()),
    };
    let pool = match lock.as_ref() {
        Some(pool) => pool.clone(),
        None => return IntegrityCheckResult::error("No database open".into()),
    };
    drop(lock);
    let conn = match pool.get() {
        Ok(conn) => conn,
        Err(error) => return IntegrityCheckResult::error(error.to_string()),
    };

    let result = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0));
    match result {
        Ok(result) => IntegrityCheckResult {
            ok: result == "ok",
            result: Some(result),
            error: None,
        },
        Err(error) => IntegrityCheckResult::error(error.to_string()),
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthInfo {
    pub ok: bool,
    pub page_count: i64,
    pub freelist_pages: i64,
    pub wal_size: i64,
    pub db_size: i64,
    pub current_path: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityCheckResult {
    pub ok: bool,
    pub result: Option<String>,
    pub error: Option<String>,
}

impl IntegrityCheckResult {
    fn error(error: String) -> Self {
        Self {
            ok: false,
            result: None,
            error: Some(error),
        }
    }
}

#[cfg(test)]
mod health_tests {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use rusqlite::Connection;

    use super::{
        close, integrity_check, lightweight_health_check, open, remove_fixture_file, DbState,
    };

    static FIXTURE_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn fixture_path() -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time is after the Unix epoch")
            .as_nanos();
        let counter = FIXTURE_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("opencode-w-health-{nonce}-{counter}.db"))
    }

    /// Minimal v1 fixture: `db::open` now rejects files without OpenCode tables.
    fn create_v1_fixture(path: &std::path::Path) -> Connection {
        let conn = Connection::open(path).expect("fixture database opens");
        conn.execute_batch(crate::schema::fixtures::v1_schema())
            .expect("v1 schema applies");
        conn
    }

    #[test]
    fn lightweight_health_uses_the_production_state_pool_path_without_diagnostic_result() {
        // Given: an opened fixture database with a known path.
        // 开库会 invalidate fork_stats 缓存，与 fork_stats 的缓存测试串行执行。
        let _cache_guard = crate::commands::fork_stats::test_serial_guard();
        let path = fixture_path();
        create_v1_fixture(&path);
        let state = DbState::new();
        open(&state, path.to_str().expect("UTF-8 fixture path")).expect("state opens fixture");

        // When: the UI health path refreshes its snapshot.
        let health = lightweight_health_check(&state.clone_inner());

        // Then: it reports the lightweight connection and file statistics.
        assert!(health.ok);
        assert_eq!(
            std::path::Path::new(health.current_path.as_deref().expect("health has a path"))
                .file_name(),
            path.file_name()
        );
        assert!(health.page_count >= 0);

        close(&state).expect("state closes fixture");
        remove_fixture_file(&path);
    }

    #[test]
    fn explicit_integrity_diagnostic_runs_only_when_requested() {
        // Given: an opened fixture database.
        // 开库会 invalidate fork_stats 缓存，与 fork_stats 的缓存测试串行执行。
        let _cache_guard = crate::commands::fork_stats::test_serial_guard();
        let path = fixture_path();
        create_v1_fixture(&path);
        let state = DbState::new();
        open(&state, path.to_str().expect("UTF-8 fixture path")).expect("state opens fixture");

        // When: the maintenance diagnostic is explicitly requested.
        let diagnostic = integrity_check(&state.clone_inner());

        // Then: SQLite's integrity result is returned to the caller.
        assert!(diagnostic.ok);
        assert_eq!(diagnostic.result.as_deref(), Some("ok"));

        close(&state).expect("state closes fixture");
        remove_fixture_file(&path);
    }
}

/// Database statistics (mirrors shared/types.ts DatabaseStats).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseStats {
    pub db_size: i64,
    pub root_session_count: i64,
    pub child_session_count: i64,
    pub session_count: i64,
    pub project_count: i64,
    pub part_count: i64,
    pub freelist_size: i64,
    pub wal_size: i64,
    pub error: Option<String>,
}

/// Get full database statistics.
pub fn get_stats(
    state: &Mutex<Option<Pool<SqliteConnectionManager>>>,
) -> DatabaseStats {
    let lock = match state.lock() {
        Ok(l) => l,
        Err(e) => {
            return DatabaseStats {
                db_size: 0,
                root_session_count: 0,
                child_session_count: 0,
                session_count: 0,
                project_count: 0,
                part_count: 0,
                freelist_size: 0,
                wal_size: 0,
                error: Some(e.to_string()),
            };
        }
    };
    let pool = match lock.as_ref() {
        Some(p) => p,
        None => {
            return DatabaseStats {
                db_size: 0,
                root_session_count: 0,
                child_session_count: 0,
                session_count: 0,
                project_count: 0,
                part_count: 0,
                freelist_size: 0,
                wal_size: 0,
                error: Some("No database open".into()),
            };
        }
    };
    let conn = match pool.get() {
        Ok(c) => c,
        Err(e) => {
            return DatabaseStats {
                db_size: 0,
                root_session_count: 0,
                child_session_count: 0,
                session_count: 0,
                project_count: 0,
                part_count: 0,
                freelist_size: 0,
                wal_size: 0,
                error: Some(e.to_string()),
            };
        }
    };

    let current_path = conn.path().map(|p| p.to_string());

    // v2 库没有 `part` 表：`part_count` 语义改为「消息行数」（session_message 行数），
    // 只做一次 COUNT，避免全量 JSON 扫描（参考库 14.8GB 上需 ~30s）。
    // v1 分支保持逐字不变；Dashboard 标签在 v2 下由 PR-3 改为「消息行数」。
    let mode = crate::schema::detect_mode(&conn).unwrap_or(SchemaMode::V1);

    // File sizes
    let (db_size, wal_size) = current_path
        .as_ref()
        .map(|p| {
            let db_sz =
                std::fs::metadata(p).ok().map(|m| m.len() as i64).unwrap_or(0);
            let wal_path = format!("{}-wal", p);
            let wal_sz = std::fs::metadata(&wal_path)
                .ok()
                .map(|m| m.len() as i64)
                .unwrap_or(0);
            (db_sz, wal_sz)
        })
        .unwrap_or((0, 0));

    // Session counts
    let root_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) as cnt FROM session WHERE parent_id IS NULL",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let child_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) as cnt FROM session WHERE parent_id IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let project_count: i64 = conn
        .query_row(
            "SELECT COUNT(DISTINCT project_id) as cnt FROM session WHERE project_id IS NOT NULL AND project_id != ''",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let part_count: i64 = if mode.is_v2() {
        conn.query_row("SELECT COUNT(*) FROM session_message", [], |row| row.get(0))
            .unwrap_or(0)
    } else {
        conn.query_row("SELECT COUNT(*) as cnt FROM part", [], |row| row.get(0))
            .unwrap_or(0)
    };
    let freelist_count: i64 = conn
        .query_row("PRAGMA freelist_count", [], |row| row.get(0))
        .unwrap_or(0);
    let page_size: i64 = conn
        .query_row("PRAGMA page_size", [], |row| row.get(0))
        .unwrap_or(4096);

    DatabaseStats {
        db_size,
        root_session_count: root_count,
        child_session_count: child_count,
        session_count: root_count + child_count,
        project_count,
        part_count,
        freelist_size: freelist_count * page_size,
        wal_size,
        error: None,
    }
}

/// VACUUM 失败时的只读诊断快照（拼成单行日志，供两处 VACUUM 调用共用）。
///
/// 只读：`pragma_database_list`、`temp.sqlite_master`、`main.sqlite_master`，
/// 不写任何数据、不改 schema。背景：清理后 VACUUM 在真库上出现过一次
/// 「views may not be indexed」，独立复跑无法复现——这类失败与库内对象
/// （TEMP 兼容视图、视图上的索引、FTS5 外部内容表、ATTACH 的 sidecar）
/// 强相关，把上下文一并打进日志，未来同类失败可直接定位触发点。
pub(crate) fn vacuum_context_summary(conn: &Connection) -> String {
    // 执行只读查询，把首列拼成字符串列表；查询失败也留痕而不是吞掉。
    let readonly_name_list = |sql: &str, limit: usize| -> Vec<String> {
        let mut values: Vec<String> = Vec::new();
        let outcome = (|| -> rusqlite::Result<()> {
            let mut stmt = conn.prepare(sql)?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                let value: String = row.get(0)?;
                values.push(value);
            }
            Ok(())
        })();
        if let Err(e) = outcome {
            values.push(format!("<查询失败: {e}>"));
        }
        if values.len() > limit {
            let extra = values.len() - limit;
            values.truncate(limit);
            values.push(format!("…(+{extra})"));
        }
        values
    };

    fn byte_size(path: &Path) -> i64 {
        std::fs::metadata(path)
            .map(|meta| meta.len() as i64)
            .unwrap_or(0)
    }

    let path = conn.path().unwrap_or("").to_string();
    let db_size = if path.is_empty() {
        0
    } else {
        byte_size(Path::new(&path))
    };
    let wal_size = if path.is_empty() {
        0
    } else {
        byte_size(Path::new(&format!("{path}-wal")))
    };
    let join = |values: Vec<String>| values.join(",");

    format!(
        "path={path} dbSize={db_size}B walSize={wal_size}B \
         databases=[{}] tempViews=[{}] viewIndexes=[{}] fts5Tables=[{}]",
        join(readonly_name_list(
            "SELECT CAST(seq AS TEXT) || ':' || name || ':' || COALESCE(file, '') \
             FROM pragma_database_list",
            8,
        )),
        join(readonly_name_list(
            "SELECT name FROM temp.sqlite_master WHERE type = 'view' ORDER BY name",
            8,
        )),
        join(readonly_name_list(
            "SELECT COALESCE(name, '') || '->' || COALESCE(tbl_name, '') \
             FROM main.sqlite_master \
             WHERE type = 'index' \
               AND tbl_name IN (SELECT name FROM main.sqlite_master WHERE type = 'view')",
            8,
        )),
        join(readonly_name_list(
            "SELECT name FROM main.sqlite_master \
             WHERE type = 'table' AND COALESCE(sql, '') LIKE '%fts5%' ORDER BY name",
            8,
        )),
    )
}

/// 在连接上执行 VACUUM，规避 TEMP VIEW 引发的 "views may not be indexed"。
///
/// 机制（SQLite 3.51 实测复现）：VACUUM 在临时库中按 `main.sqlite_master`
/// 原文重放 `CREATE INDEX` 等语句，未限定 schema 的表名按 temp → main
/// 顺序解析。若连接持有与 main 表**同名**的 TEMP VIEW（v2 兼容层的
/// `TEMP VIEW "session"` 与 legacy `session` 表正是同名），索引语句会命中
/// 视图而失败。TEMP 表同名无此问题（已实测），因此只处理视图：VACUUM 前
/// 记下并 DROP 全部 TEMP 视图，结束后（无论成败）按原文重建。
pub(crate) fn vacuum_with_temp_view_guard(conn: &Connection) -> Result<(), rusqlite::Error> {
    // 记下连接持有的全部 TEMP 视图（name, 原始 CREATE VIEW SQL）。
    let temp_views: Vec<(String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT name, sql FROM temp.sqlite_master \
             WHERE type = 'view' AND sql IS NOT NULL ORDER BY rowid",
        )?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    let vacuum = || -> Result<(), rusqlite::Error> {
        if temp_views.is_empty() {
            return conn.execute_batch("VACUUM");
        }
        // 视图名以双引号包裹并转义内部引号；名称来自 temp.sqlite_master，
        // 不是外部输入（SEC-003）。
        let drops = temp_views
            .iter()
            .map(|(name, _)| format!("DROP VIEW IF EXISTS temp.\"{}\";", name.replace('"', "\"\"")))
            .collect::<String>();
        conn.execute_batch(&drops)?;
        conn.execute_batch("VACUUM")
    };

    let outcome = vacuum();

    if !temp_views.is_empty() {
        // 无论 VACUUM 成败都按原文重建，保证连接状态与进入前一致。
        // 注意：temp.sqlite_master 存储的 SQL 已被 SQLite 规范化去掉 TEMP
        // 前缀（如 `CREATE VIEW session AS …`），直接重放会创建到 main
        // schema（同名冲突报错，不同名则污染用户库，违反 SEC-001），
        // 因此强制改写为 `CREATE TEMP VIEW`。
        let mut rebuild = String::new();
        for (_, sql) in &temp_views {
            if let Some(rest) = sql.trim_start().strip_prefix("CREATE VIEW") {
                rebuild.push_str("CREATE TEMP VIEW");
                rebuild.push_str(rest);
            } else {
                log::warn!("跳过无法识别的 TEMP 视图定义，不重放：{sql}");
                continue;
            }
            rebuild.push(';');
        }
        if !rebuild.is_empty() {
            if let Err(e) = conn.execute_batch(&rebuild) {
                log::error!(
                    "VACUUM 后重建 TEMP 视图失败（{} 个）：{}",
                    temp_views.len(),
                    e
                );
                if outcome.is_ok() {
                    return Err(e);
                }
            }
        }
    }

    outcome
}

/// Run VACUUM and return before/after sizes.
///
/// VACUUM 会重写整个库文件，迁移期间执行会破坏 OpenCode 的迁移事务，
/// 因此先过一遍实时迁移闸门（[`ensure_writable_conn`]）。
pub fn vacuum(
    state: &Mutex<Option<Pool<SqliteConnectionManager>>>,
) -> Result<VacuumResult, String> {
    let lock = state.lock().map_err(|e| e.to_string())?;
    let pool = lock.as_ref().ok_or("No database open")?;
    let conn = pool.get().map_err(|e| e.to_string())?;

    ensure_writable_conn(&conn)?;

    let current_path = conn.path().ok_or("No database path")?;
    let before_size = std::fs::metadata(current_path)
        .ok()
        .map(|m| m.len() as i64)
        .unwrap_or(0);

    if let Err(e) = vacuum_with_temp_view_guard(&conn) {
        // 失败必须有完整上下文：独立复跑往往无法复现，库内对象（临时视图 /
        // FTS5 表 / ATTACH 的 sidecar）是定位关键。
        log::warn!(
            "database:vacuum VACUUM 失败：error={} before={}B {}",
            e,
            before_size,
            vacuum_context_summary(&conn)
        );
        return Err(e.to_string());
    }

    let after_size = std::fs::metadata(current_path)
        .ok()
        .map(|m| m.len() as i64)
        .unwrap_or(0);

    Ok(VacuumResult {
        before: before_size,
        after: after_size,
        freed: before_size - after_size,
    })
}

#[cfg(test)]
mod vacuum_context_tests {
    use super::vacuum_context_summary;
    use rusqlite::Connection;

    #[test]
    fn summary_lists_databases_temp_views_and_fts5_tables() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TEMP VIEW temp_probe AS SELECT 1 AS one;
             CREATE VIRTUAL TABLE probe_fts USING fts5(body);",
        )
        .unwrap();

        let summary = vacuum_context_summary(&conn);
        assert!(summary.starts_with("path="), "{summary}");
        assert!(summary.contains("databases=[0:main:"), "{summary}");
        assert!(summary.contains("1:temp:"), "{summary}");
        assert!(summary.contains("tempViews=[temp_probe]"), "{summary}");
        assert!(summary.contains("viewIndexes=[]"), "{summary}");
        assert!(summary.contains("fts5Tables=[probe_fts]"), "{summary}");
    }
}

#[cfg(test)]
mod vacuum_guard_tests {
    use rusqlite::Connection;

    /// 复现线上失败（2026-10-23）：TEMP 视图与 main 表同名时，直接
    /// `VACUUM` 会报 "views may not be indexed"；带保护的封装应成功，
    /// 且结束后 TEMP 视图按原定义恢复。
    #[test]
    fn vacuum_succeeds_with_shadowing_temp_view_and_restores_it() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE session(id INTEGER PRIMARY KEY, x TEXT);
             CREATE INDEX idx_session_x ON session(x);
             INSERT INTO session VALUES (1, 'a');
             CREATE TEMP VIEW session AS SELECT * FROM main.session;",
        )
        .unwrap();

        // 未加保护时本条连接直接 VACUUM 复现失败：
        //   assert!(conn.execute_batch("VACUUM").is_err());
        super::vacuum_with_temp_view_guard(&conn).expect("vacuum should succeed");

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM temp.session", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1, "TEMP 视图应在 VACUUM 后恢复可用");
    }

    #[test]
    fn vacuum_without_temp_views_still_works() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t(id INTEGER PRIMARY KEY);")
            .unwrap();

        super::vacuum_with_temp_view_guard(&conn).expect("vacuum should succeed");
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct VacuumResult {
    pub before: i64,
    pub after: i64,
    pub freed: i64,
}

/// Run WAL checkpoint.
///
/// TRUNCATE 会改动 WAL 文件，迁移期间执行会与 OpenCode 抢锁，
/// 因此先过一遍实时迁移闸门（[`ensure_writable_conn`]）。
pub fn checkpoint(
    state: &Mutex<Option<Pool<SqliteConnectionManager>>>,
) -> Result<(), String> {
    let lock = state.lock().map_err(|e| e.to_string())?;
    let pool = lock.as_ref().ok_or("No database open")?;
    let conn = pool.get().map_err(|e| e.to_string())?;
    ensure_writable_conn(&conn)?;
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .map_err(|e| e.to_string())
}

/// Execute a raw query returning multiple rows.
pub fn raw_query<T, F>(
    state: &Mutex<Option<Pool<SqliteConnectionManager>>>,
    sql: &str,
    params: &[&dyn rusqlite::types::ToSql],
    mapper: F,
) -> Result<Vec<T>, String>
where
    F: FnMut(&rusqlite::Row) -> rusqlite::Result<T>,
{
    let lock = state.lock().map_err(|e| e.to_string())?;
    let pool = lock.as_ref().ok_or("No database open")?;
    let conn = pool.get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params, mapper).map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for row in rows {
        result.push(row.map_err(|e| e.to_string())?);
    }
    Ok(result)
}

/// Execute a raw query returning a single row.
pub fn raw_get<T, F>(
    state: &Mutex<Option<Pool<SqliteConnectionManager>>>,
    sql: &str,
    params: &[&dyn rusqlite::types::ToSql],
    mapper: F,
) -> Result<Option<T>, String>
where
    F: FnOnce(&rusqlite::Row) -> rusqlite::Result<T>,
{
    let lock = state.lock().map_err(|e| e.to_string())?;
    let pool = lock.as_ref().ok_or("No database open")?;
    let conn = pool.get().map_err(|e| e.to_string())?;
    let result = conn.query_row(sql, params, mapper).ok();
    Ok(result)
}

/// Execute a statement and return changes / last_insert_rowid.
pub fn run(
    state: &Mutex<Option<Pool<SqliteConnectionManager>>>,
    sql: &str,
    params: &[&dyn rusqlite::types::ToSql],
) -> Result<RunResult, String> {
    let lock = state.lock().map_err(|e| e.to_string())?;
    let pool = lock.as_ref().ok_or("No database open")?;
    let conn = pool.get().map_err(|e| e.to_string())?;
    let changes = conn.execute(sql, params).map_err(|e| e.to_string())?;
    let last_id = conn.last_insert_rowid();
    Ok(RunResult {
        changes: changes as i64,
        last_insert_rowid: last_id,
    })
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RunResult {
    pub changes: i64,
    pub last_insert_rowid: i64,
}

/// Execute a raw SQL string (no params, for DDL / PRAGMA).
pub fn raw_run(
    state: &Mutex<Option<Pool<SqliteConnectionManager>>>,
    sql: &str,
) -> Result<(), String> {
    let lock = state.lock().map_err(|e| e.to_string())?;
    let pool = lock.as_ref().ok_or("No database open")?;
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute_batch(sql).map_err(|e| e.to_string())
}

#[cfg(test)]
mod schema_integration_tests {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use rusqlite::Connection;

    use super::{
        close, get_pool, get_stats, open, remove_fixture_file, DbState,
    };
    use crate::schema::{fixtures, MigrationPhase, SchemaMode};

    static FIXTURE_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn fixture_path() -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time is after the Unix epoch")
            .as_nanos();
        let counter = FIXTURE_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("opencode-w-schema-{nonce}-{counter}.db"))
    }

    fn open_fixture(
        path: &std::path::Path,
        prepare: impl FnOnce(&Connection),
    ) -> DbState {
        {
            let conn = Connection::open(path).expect("fixture database opens");
            prepare(&conn);
        }
        let state = DbState::new();
        open(&state, path.to_str().expect("UTF-8 fixture path")).expect("state opens fixture");
        state
    }

    fn insert_legacy_session(conn: &Connection, id: &str, parent_id: Option<&str>) {
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

    fn insert_v2_message(conn: &Connection, id: &str, session_id: &str, kind: &str, seq: i64, blocks: usize) {
        let content: Vec<String> = (0..blocks)
            .map(|index| format!("{{\"type\":\"text\",\"text\":\"block-{index}\"}}"))
            .collect();
        let data = format!("{{\"content\":[{}]}}", content.join(","));
        conn.execute(
            "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
             VALUES (?1, ?2, ?3, ?4, 1000, 2000, ?5)",
            rusqlite::params![id, session_id, kind, seq, data],
        )
        .expect("v2 message inserts");
    }

    #[test]
    fn v1_statistics_keep_the_legacy_formula() {
        // 开库会 invalidate fork_stats 缓存，与 fork_stats 的缓存测试串行执行。
        let _cache_guard = crate::commands::fork_stats::test_serial_guard();
        let path = fixture_path();
        let state = open_fixture(&path, |conn| {
            conn.execute_batch(fixtures::v1_schema()).expect("v1 schema applies");
            insert_legacy_session(conn, "ses_root", None);
            insert_legacy_session(conn, "ses_child", Some("ses_root"));
            conn.execute_batch(
                "INSERT INTO message (id, session_id, time_created, time_updated, data)
                 VALUES ('msg_1', 'ses_root', 1000, 1000, '{}');
                 INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
                 VALUES ('prt_1', 'msg_1', 'ses_root', 1000, 1000, '{}'),
                        ('prt_2', 'msg_1', 'ses_root', 1000, 1000, '{}'),
                        ('prt_3', 'msg_1', 'ses_root', 1000, 1000, '{}');",
            )
            .expect("legacy rows insert");
        });

        assert_eq!(
            state.schema().expect("schema is stored").mode,
            SchemaMode::V1
        );

        let stats = get_stats(&state.clone_inner());

        assert_eq!(stats.error, None);
        assert_eq!(stats.root_session_count, 1);
        assert_eq!(stats.child_session_count, 1);
        assert_eq!(stats.session_count, 2);
        assert_eq!(stats.project_count, 1);
        assert_eq!(stats.part_count, 3, "v1 仍按 part 行数统计");

        close(&state).expect("state closes fixture");
        remove_fixture_file(&path);
    }

    #[test]
    fn v2_statistics_count_message_rows() {
        // 开库会 invalidate fork_stats 缓存，与 fork_stats 的缓存测试串行执行。
        let _cache_guard = crate::commands::fork_stats::test_serial_guard();
        let path = fixture_path();
        let state = open_fixture(&path, |conn| {
            conn.execute_batch(fixtures::v2_schema()).expect("v2 schema applies");
            insert_v2_session(conn, "ses_root", None, Some("root"));
            insert_v2_session(conn, "ses_child", Some("ses_root"), None);
            // v2 无 part 表，part_count 退化为 session_message 行数 → 3。
            insert_v2_message(conn, "msg_a", "ses_root", "assistant", 1, 2);
            insert_v2_message(conn, "msg_u", "ses_root", "user", 2, 1);
            insert_v2_message(conn, "msg_s", "ses_root", "system", 3, 0);
        });

        let schema = state.schema().expect("schema is stored");
        assert_eq!(schema.mode, SchemaMode::V2Fresh);
        assert_eq!(schema.v2_session_count, 2);

        let stats = get_stats(&state.clone_inner());

        assert_eq!(stats.error, None);
        assert_eq!(stats.root_session_count, 1);
        assert_eq!(stats.child_session_count, 1);
        assert_eq!(stats.session_count, 2);
        assert_eq!(stats.project_count, 1);
        assert_eq!(stats.part_count, 3, "v2 无 part 表，按 session_message 行数统计");

        close(&state).expect("state closes fixture");
        remove_fixture_file(&path);
    }

    #[test]
    fn every_pooled_connection_serves_the_mixed_session_view() {
        // 开库会 invalidate fork_stats 缓存，与 fork_stats 的缓存测试串行执行。
        let _cache_guard = crate::commands::fork_stats::test_serial_guard();
        let path = fixture_path();
        let state = open_fixture(&path, |conn| {
            conn.execute_batch(fixtures::v1_schema()).expect("v1 schema applies");
            conn.execute_batch(fixtures::v2_schema()).expect("v2 schema applies");
            insert_v2_session(conn, "ses_v2", None, Some("v2 title"));
            insert_legacy_session(conn, "ses_v2", None);
            insert_legacy_session(conn, "ses_legacy_only", None);
        });

        let schema = state.schema().expect("schema is stored");
        assert_eq!(schema.mode, SchemaMode::V2Mixed);
        assert!(schema.has_legacy_tables);

        let pool = get_pool(&state.0).expect("pool is available");
        let mut connections = Vec::new();
        for _ in 0..4 {
            connections.push(pool.get().expect("pooled connection"));
        }

        for conn in &connections {
            let views: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_temp_master WHERE type = 'view' AND name = 'session'",
                    [],
                    |row| row.get(0),
                )
                .expect("temp master is queryable");
            assert_eq!(views, 1, "每条池连接都有 session 视图");

            let rows: i64 = conn
                .query_row("SELECT COUNT(*) FROM session", [], |row| row.get(0))
                .expect("view counts");
            assert_eq!(rows, 1, "v2-only：视图只暴露 session_v2 行");
        }

        // 释放 4 条池连接，避免 get_stats 取连接时耗尽池（默认 30s 超时）。
        drop(connections);

        let stats = get_stats(&state.clone_inner());
        assert_eq!(stats.session_count, 1);
        assert_eq!(stats.root_session_count, 1);

        close(&state).expect("state closes fixture");
        remove_fixture_file(&path);
    }

    #[test]
    fn migration_running_still_opens_and_is_reported() {
        // 开库会 invalidate fork_stats 缓存，与 fork_stats 的缓存测试串行执行。
        let _cache_guard = crate::commands::fork_stats::test_serial_guard();
        let path = fixture_path();
        let state = open_fixture(&path, |conn| {
            conn.execute_batch(fixtures::v2_schema()).expect("v2 schema applies");
            conn.execute(
                "INSERT INTO kv (key, value, time_created) VALUES ('migration.v1-v2', '{\"phase\":\"running\"}', 1)",
                [],
            )
            .expect("kv row inserts");
        });

        let schema = state.schema().expect("schema is stored");
        assert_eq!(schema.migration_phase, MigrationPhase::Running);

        close(&state).expect("state closes fixture");
        remove_fixture_file(&path);
    }

    /// 写后一致性（TASK-026）：写完刷新缓存的计数。
    #[test]
    fn writing_refreshes_the_cached_schema_counts() {
        // 开库会 invalidate fork_stats 缓存，与 fork_stats 的缓存测试串行执行。
        let _cache_guard = crate::commands::fork_stats::test_serial_guard();
        let path = fixture_path();
        {
            let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../test-data/v2-mixed.db");
            if !source.is_file() {
                eprintln!("[skip] 缺少夹具 v2-mixed.db");
                return;
            }
            std::fs::copy(&source, &path).expect("fixture is copied");
        }
        let state = open_fixture(&path, |_| {});
        let schema = state.schema().expect("schema is stored");
        assert_eq!(schema.v2_session_count, 6);

        {
            let conn = get_pool(&state.0)
                .expect("pool is available")
                .get()
                .expect("pooled connection");
            crate::compat::write::delete_sessions(&conn, &["ses_mixed_both_0201".to_string()])
                .expect("删除必须成功");
            state
                .refresh_schema_counts(&conn)
                .expect("写后刷新必须成功");
        }

        let refreshed = state.schema().expect("schema is still cached");
        assert_eq!(refreshed.v2_session_count, 5, "少了一个 v2 会话");

        close(&state).expect("state closes fixture");
        remove_fixture_file(&path);
    }

    /// `database:info` 的 `refresh` 分支（TASK-051）：用新只读连接重新探测，
    /// 把结果写回**探测快照**，**不重建连接池**、**不改生效形态**。
    #[test]
    fn refresh_reprobes_the_schema_and_keeps_the_connection_pool() {
        // 开库会 invalidate fork_stats 缓存，与 fork_stats 的缓存测试串行执行。
        let _cache_guard = crate::commands::fork_stats::test_serial_guard();
        let path = fixture_path();
        let state = open_fixture(&path, |conn| {
            conn.execute_batch(fixtures::v1_schema()).expect("v1 schema applies");
            insert_legacy_session(conn, "ses_legacy_only", None);
        });
        assert_eq!(
            state.schema().expect("schema is stored").mode,
            SchemaMode::V1,
            "开库时只有旧表"
        );

        // 给池内每条连接打标记：刷新后标记还在，就说明连接池没有被重建。
        let pool = get_pool(&state.0).expect("pool is available");
        {
            let mut connections = Vec::new();
            for _ in 0..pool.max_size() {
                connections.push(pool.get().expect("pooled connection"));
            }
            for conn in &connections {
                conn.execute_batch("CREATE TEMP TABLE pool_marker (value TEXT);")
                    .expect("marker applies");
            }
        }

        // 模拟 OpenCode 在应用运行期间完成迁移：同一个文件里出现 v2 表。
        {
            let conn = Connection::open(&path).expect("fixture reopens");
            conn.execute_batch(fixtures::v2_schema()).expect("v2 schema applies");
            insert_v2_session(&conn, "ses_v2", None, Some("v2 title"));
        }

        let refreshed = state.refresh_schema().expect("重新探测必须成功");

        assert_eq!(
            refreshed.mode,
            SchemaMode::V2Mixed,
            "重新探测应看到迁移后的形态"
        );
        assert_eq!(
            state
                .detected_schema()
                .expect("探测快照已更新")
                .mode,
            SchemaMode::V2Mixed,
            "探测快照必须被更新"
        );
        assert_eq!(
            state.schema().expect("生效形态仍在").mode,
            SchemaMode::V1,
            "重新探测不得改生效形态：池内 TEMP VIEW 仍是旧的"
        );
        assert_eq!(refreshed.v2_session_count, 1);

        // 连接池没有被重建：之前打过标记的连接仍然在池里。
        {
            let mut connections = Vec::new();
            for _ in 0..pool.max_size() {
                connections.push(pool.get().expect("pooled connection"));
            }
            for conn in &connections {
                let markers: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM sqlite_temp_master WHERE type = 'table' AND name = 'pool_marker'",
                        [],
                        |row| row.get(0),
                    )
                    .expect("temp master is queryable");
                assert_eq!(markers, 1, "刷新不得重建连接池");
            }
        }

        // 必须先释放本地持有的 pool 副本：`close()` 只撤掉 state 里的那一份，
        // 本地的 `pool` 仍让连接池活着 → 文件句柄不释放（Windows 删不掉）。
        drop(pool);
        close(&state).expect("state closes fixture");
        remove_fixture_file(&path);
    }

    /// P2-13：探测与生效形态分离。
    ///
    /// v1 库在运行期出现 v2 表 → 探测返回新形态，但**生效形态不变**（命令仍按
    /// 旧形态路由）；重新 open 之后两者一致。
    #[test]
    fn detected_schema_and_active_schema_diverge_until_the_database_is_reopened() {
        // 开库会 invalidate fork_stats 缓存，与 fork_stats 的缓存测试串行执行。
        let _cache_guard = crate::commands::fork_stats::test_serial_guard();
        let path = fixture_path();
        let state = open_fixture(&path, |conn| {
            conn.execute_batch(fixtures::v1_schema()).expect("v1 schema applies");
            insert_legacy_session(conn, "ses_legacy_only", None);
        });
        assert_eq!(
            state.schema().expect("生效形态已记录").mode,
            SchemaMode::V1
        );
        assert!(
            state.detected_schema().is_none(),
            "刚开库时没有探测快照"
        );

        // 运行期出现 v2 表。
        {
            let conn = Connection::open(&path).expect("fixture reopens");
            conn.execute_batch(fixtures::v2_schema()).expect("v2 schema applies");
            insert_v2_session(&conn, "ses_v2", None, Some("v2 title"));
        }

        let detected = state.refresh_schema().expect("重新探测必须成功");
        assert_eq!(detected.mode, SchemaMode::V2Mixed, "探测看到新形态");
        assert_eq!(
            state.detected_schema().expect("探测快照").mode,
            SchemaMode::V2Mixed
        );
        assert_eq!(
            state.schema().expect("生效形态").mode,
            SchemaMode::V1,
            "生效形态必须保持旧形态：命令要按池内视图的实际形态路由"
        );

        // 重新 open：生效形态更新为新形态，探测快照清空，两者一致。
        open(&state, path.to_str().expect("UTF-8 fixture path")).expect("重新开库必须成功");
        assert_eq!(
            state.schema().expect("生效形态已更新").mode,
            SchemaMode::V2Mixed
        );
        assert!(
            state.detected_schema().is_none(),
            "重新开库必须清空探测快照"
        );

        close(&state).expect("state closes fixture");
        remove_fixture_file(&path);
    }

    /// 重新探测失败时保留原缓存（不把「可用」变成「未知」）。
    #[test]
    fn refresh_failure_keeps_the_previous_cached_schema() {
        // 开库会 invalidate fork_stats 缓存，与 fork_stats 的缓存测试串行执行。
        let _cache_guard = crate::commands::fork_stats::test_serial_guard();
        let path = fixture_path();
        let state = open_fixture(&path, |conn| {
            conn.execute_batch(fixtures::v1_schema()).expect("v1 schema applies");
            insert_legacy_session(conn, "ses_root", None);
        });
        let before = state.schema().expect("schema is stored");

        // 文件被移走 → 只读连接打不开 → 刷新必须报错且不改动缓存。
        //
        // 先**只丢连接池**、保留 schema 缓存：Windows 不允许删除仍被句柄占用
        // 的文件，而连接池里的连接正占着它。注意不能用 `close()` 代替——
        // `close()` 会把 schema 缓存一起清掉，本用例的语义恰恰是
        // 「刷新失败了，但缓存必须还在」。
        *state.0.lock().expect("pool lock is available") = None;
        remove_fixture_file(&path);

        let error = state.refresh_schema().expect_err("刷新必须失败");
        assert!(
            error.contains("只读") || error.contains("识别"),
            "错误文案要能说明原因：{error}"
        );
        assert_eq!(
            state.schema().expect("schema is still cached").mode,
            before.mode,
            "刷新失败不得改动缓存"
        );

        close(&state).expect("state closes fixture");
    }

    /// **从来没有打开过任何文件**（既没有 path，也没有 last_attempt_path）时，
    /// 刷新只能报「没有已连接的数据库」——注意这与「打开失败」是两回事：
    /// 打开失败时 `last_attempt_path` 已经记下了路径，能拿到 unsupported 原因。
    #[test]
    fn a_state_without_any_open_attempt_reports_no_database() {
        let state = DbState::new();
        assert!(state.path().is_none(), "没有打开过任何文件");
        assert!(
            state.last_attempt_path().is_none(),
            "没有打开尝试就没有路径"
        );
        let error = state.refresh_schema().expect_err("没有库时必须失败");
        assert!(error.contains("没有已连接的数据库"), "{error}");
    }

    /// 打开失败（探测不通过）后，`last_attempt_path` 必须留下来：
    /// 设置页要靠它显示「无法识别的数据库格式 + 原因」。
    #[test]
    fn a_failed_open_still_records_the_attempted_path() {
        let path = fixture_path();
        {
            let conn = Connection::open(&path).expect("fixture database opens");
            conn.execute_batch("CREATE TABLE marker (value TEXT);")
                .expect("marker table applies");
        }
        let state = DbState::new();

        let error = open(&state, path.to_str().expect("UTF-8 fixture path"))
            .expect_err("不受支持的库必须被拒绝");
        assert!(error.contains("受支持的 OpenCode 数据库"), "{error}");

        assert!(
            state.path().is_none(),
            "打开失败不得写入 path（库确实没打开）"
        );
        assert_eq!(
            state.last_attempt_path().as_deref(),
            std::fs::canonicalize(&path)
                .expect("path resolves")
                .to_str(),
            "打开失败也必须记住尝试路径"
        );

        // 探测结果照样拿得到：unsupported + 原因。
        let info = state.refresh_schema().expect("重新探测必须成功");
        assert_eq!(info.mode, SchemaMode::Unsupported);
        assert!(info.unsupported_reason.is_some());
        assert!(!state.is_open(), "探测不得打开连接池");

        let _ = std::fs::remove_file(path);
    }

    /// `close()` 只清 schema 与连接池，**不清** `last_attempt_path`：
    /// 关掉之后仍然能读到「上一次尝试的是哪个文件」。
    #[test]
    fn close_keeps_the_last_attempted_path() {
        // 开/关库会失效 fork_stats 缓存，与缓存测试串行执行。
        let _cache_guard = crate::commands::fork_stats::test_serial_guard();
        let path = fixture_path();
        {
            let conn = Connection::open(&path).expect("fixture database opens");
            conn.execute_batch(crate::schema::fixtures::v1_schema())
                .expect("v1 schema applies");
        }
        let state = DbState::new();
        open(&state, path.to_str().expect("UTF-8 fixture path")).expect("v1 opens");
        assert!(state.last_attempt_path().is_some());

        close(&state).expect("state closes fixture");

        assert!(state.path().is_none(), "close 必须清掉已打开的路径");
        assert!(state.schema().is_none(), "close 必须清掉 schema 缓存");
        assert!(!state.is_open(), "close 必须关掉连接池");
        assert!(
            state.last_attempt_path().is_some(),
            "close 不得清除 last_attempt_path"
        );

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn unsupported_files_are_rejected_with_a_actionable_chinese_error() {
        // 开库会 invalidate fork_stats 缓存，与 fork_stats 的缓存测试串行执行。
        let _cache_guard = crate::commands::fork_stats::test_serial_guard();
        let path = fixture_path();
        {
            let conn = Connection::open(&path).expect("fixture database opens");
            conn.execute_batch("CREATE TABLE marker (value TEXT);")
                .expect("marker table applies");
        }
        let state = DbState::new();

        let error = open(&state, path.to_str().expect("UTF-8 fixture path"))
            .expect_err("unsupported database is rejected");

        assert!(
            error.contains("不是受支持的 OpenCode 数据库"),
            "error: {error}"
        );
        assert!(!state.is_open());
        assert!(state.schema().is_none());

        remove_fixture_file(&path);
    }

    #[test]
    fn closing_clears_the_cached_schema() {        // 开库会 invalidate fork_stats 缓存，与 fork_stats 的缓存测试串行执行。
        let _cache_guard = crate::commands::fork_stats::test_serial_guard();
        let path = fixture_path();
        let state = open_fixture(&path, |conn| {
            conn.execute_batch(fixtures::v2_schema()).expect("v2 schema applies");
        });

        assert!(state.schema().is_some());
        close(&state).expect("state closes fixture");
        assert!(state.schema().is_none());

        remove_fixture_file(&path);
    }
}

/// 写命令的**实时**迁移闸门（PR-2 安全修复 P1-2）。
///
/// 缓存检查只看开库那一刻的形态；OpenCode 可能在这之后才启动迁移，
/// 因此写命令必须在自己的连接上再查一次 `main.kv`。
#[cfg(test)]
mod write_gate_tests {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use rusqlite::Connection;

    use super::{
        close, ensure_writable, ensure_writable_conn, get_pool, open, remove_fixture_file, DbState,
    };
    use crate::schema::{fixtures, MigrationPhase};

    static FIXTURE_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn fixture_path() -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time is after the Unix epoch")
            .as_nanos();
        let counter = FIXTURE_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("opencode-w-gate-{nonce}-{counter}.db"))
    }

    /// 缓存显示「迁移已完成」，但外部把 `kv` 改回 `running`（模拟 OpenCode
    /// 在应用运行期间启动迁移）→ 写命令必须被拒绝。
    #[test]
    fn a_live_migration_blocks_writes_even_when_the_cache_says_completed() {
        // 开库会 invalidate fork_stats 缓存，与 fork_stats 的缓存测试串行执行。
        let _cache_guard = crate::commands::fork_stats::test_serial_guard();
        let path = fixture_path();
        {
            let conn = Connection::open(&path).expect("fixture database opens");
            conn.execute_batch(fixtures::v2_schema())
                .expect("v2 schema applies");
            conn.execute(
                "INSERT INTO kv (key, value, time_created)
                 VALUES ('migration.v1-v2', '{\"phase\":\"completed\"}', 1)",
                [],
            )
            .expect("kv row inserts");
        }

        let state = DbState::new();
        open(&state, path.to_str().expect("UTF-8 fixture path")).expect("state opens fixture");
        assert_eq!(
            state.schema().expect("schema is stored").migration_phase,
            MigrationPhase::Completed
        );
        assert!(
            ensure_writable(&state).is_ok(),
            "缓存检查放行（UI 用它决定按钮置灰）"
        );

        // 外部迁移：另一个连接把 kv 改成 running。
        {
            let conn = Connection::open(&path).expect("fixture reopens");
            conn.execute(
                "UPDATE kv SET value = '{\"phase\":\"running\"}' WHERE key = 'migration.v1-v2'",
                [],
            )
            .expect("kv row updates");
        }

        let pool = get_pool(&state.0).expect("pool is available");
        let conn = pool.get().expect("pooled connection");
        let error = ensure_writable_conn(&conn).expect_err("迁移中必须拒绝写入");
        assert_eq!(error, super::READ_ONLY_MESSAGE);

        // 迁移失败同样拒绝。
        {
            let conn = Connection::open(&path).expect("fixture reopens");
            conn.execute(
                "UPDATE kv SET value = '{\"phase\":\"failed\"}' WHERE key = 'migration.v1-v2'",
                [],
            )
            .expect("kv row updates");
        }
        let error = ensure_writable_conn(&conn).expect_err("迁移失败必须拒绝写入");
        assert_eq!(error, super::READ_ONLY_MESSAGE);

        // 删夹具前必须释放仍持有文件句柄的连接与连接池副本
        // （Windows 不允许删除仍被占用的文件）。
        drop(conn);
        drop(pool);
        close(&state).expect("state closes fixture");
        remove_fixture_file(&path);
    }

    /// 没有 `kv` 表（v1 库）或没有迁移记录 → 放行。
    #[test]
    fn a_database_without_a_migration_record_stays_writable() {
        let path = fixture_path();
        {
            let conn = Connection::open(&path).expect("fixture database opens");
            conn.execute_batch(fixtures::v1_schema())
                .expect("v1 schema applies");
        }
        let conn = Connection::open(&path).expect("fixture reopens");
        assert!(
            ensure_writable_conn(&conn).is_ok(),
            "v1 库没有 kv 表，必须放行"
        );
        // 连接仍打开着文件：删之前先放掉句柄（Windows）。
        drop(conn);
        remove_fixture_file(&path);

        // v2 库有 kv 表但没有迁移记录 → 放行。
        let path = fixture_path();
        {
            let conn = Connection::open(&path).expect("fixture database opens");
            conn.execute_batch(fixtures::v2_schema())
                .expect("v2 schema applies");
        }
        let conn = Connection::open(&path).expect("fixture reopens");
        assert!(
            ensure_writable_conn(&conn).is_ok(),
            "没有迁移记录时必须放行"
        );
        drop(conn);
        remove_fixture_file(&path);
    }

    /// 读不到迁移状态时**保守拒绝**：宁可拦住写入，也不能在迁移期间破坏它。
    #[test]
    fn an_unreadable_migration_state_blocks_writes_conservatively() {
        let path = fixture_path();
        {
            let conn = Connection::open(&path).expect("fixture database opens");
            conn.execute_batch(fixtures::v1_schema())
                .expect("v1 schema applies");
            // 残缺的 kv 表：查 `value` 会失败。
            conn.execute_batch("CREATE TABLE kv (key TEXT PRIMARY KEY);")
                .expect("kv table applies");
        }
        let conn = Connection::open(&path).expect("fixture reopens");
        let error = ensure_writable_conn(&conn).expect_err("读不到状态必须拒绝写入");
        assert!(
            error.contains("无法确认数据库迁移状态"),
            "错误文案要说明原因：{error}"
        );
        drop(conn);
        remove_fixture_file(&path);
    }
}



