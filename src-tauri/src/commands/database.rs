use tauri::{AppHandle, Manager, State};

use crate::db::{self, DbState};
use crate::models::dto::IpcResult;
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
pub fn database_open(db: State<DbState>, value: String) -> IpcResult<String> {
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
        Ok(abs_path) => IpcResult::ok(abs_path),
        Err(e) => IpcResult::err(e),
    }
}

/// database:vacuum — run VACUUM and return before/after sizes.
///
/// 使用 spawn_blocking 避免阻塞主线程（VACUUM 在大数据库上可能很慢）。
#[tauri::command]
pub async fn database_vacuum(app: AppHandle) -> IpcResult<db::VacuumResult> {
    let db = app.state::<DbState>().clone_inner();
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
    let db = app.state::<DbState>().clone_inner();
    tauri::async_runtime::spawn_blocking(move || {
        match db::checkpoint(&db) {
            Ok(()) => IpcResult::ok(true),
            Err(e) => IpcResult::err(e),
        }
    })
    .await
    .unwrap_or_else(|e| IpcResult::err(format!("thread error: {}", e)))
}
