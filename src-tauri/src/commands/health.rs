use tauri::{AppHandle, Manager};
use std::time::Instant;

use crate::db::{self, DbState};
use crate::models::dto::IpcResult;

/// database:health — returns lightweight database status for UI refreshes.
#[tauri::command]
pub async fn database_health(app: AppHandle) -> IpcResult<db::HealthInfo> {
    let db = app.state::<DbState>().clone_inner();
    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let info = db::lightweight_health_check(&db);
        #[cfg(debug_assertions)]
        eprintln!(
            "[perf] database_health_lightweight: {}ms",
            started.elapsed().as_millis()
        );
        // Return the health info even on failure — frontend reads .error field
        IpcResult::ok(info)
    })
    .await
    .unwrap_or_else(|e| IpcResult::err(format!("thread error: {}", e)))
}

/// database:integrityCheck — runs SQLite's full integrity diagnostic on demand.
#[tauri::command]
pub async fn database_integrity_check(app: AppHandle) -> IpcResult<db::IntegrityCheckResult> {
    let db = app.state::<DbState>().clone_inner();
    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let result = db::integrity_check(&db);
        #[cfg(debug_assertions)]
        eprintln!(
            "[perf] database_integrity_check: {}ms",
            started.elapsed().as_millis()
        );
        IpcResult::ok(result)
    })
        .await
        .unwrap_or_else(|e| IpcResult::err(format!("thread error: {}", e)))
}
