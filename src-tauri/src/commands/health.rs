use tauri::{AppHandle, Manager};

use crate::db::{self, DbState};
use crate::models::dto::IpcResult;

/// database:health — returns database health info.
///
/// 使用 spawn_blocking 避免阻塞主线程（integrity_check 在大数据库上可能较慢）。
#[tauri::command]
pub async fn database_health(app: AppHandle) -> IpcResult<db::HealthInfo> {
    let db = app.state::<DbState>().clone_inner();
    tauri::async_runtime::spawn_blocking(move || {
        let info = db::health_check(&db);
        // Return the health info even on failure — frontend reads .error field
        IpcResult::ok(info)
    })
    .await
    .unwrap_or_else(|e| IpcResult::err(format!("thread error: {}", e)))
}
