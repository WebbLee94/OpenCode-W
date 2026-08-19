use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;

use crate::db::{self, DbState};
use crate::models::dto::IpcResult;
use crate::security;

/// shell:openExternal — open a URL in the system default browser.
///
/// Protocol whitelist (http/https only) is enforced by security::validate_shell_url
/// to prevent javascript:, file:, cmd: and other protocol injection attacks.
#[tauri::command]
#[allow(deprecated)]
pub fn shell_open_external(app: AppHandle, url: String) -> IpcResult<bool> {
    if let Err(e) = security::validate_shell_url(&url) {
        return IpcResult::err(e);
    }
    match app.shell().open(url, None) {
        Ok(()) => IpcResult::ok(true),
        Err(e) => IpcResult::err(e.to_string()),
    }
}

/// shell:revealDatabaseDirectory — open the current database's containing folder.
///
/// The path is read server-side from DbState and re-validated with
/// security::validate_db_path; the renderer cannot supply an arbitrary path.
#[tauri::command]
#[allow(deprecated)]
pub fn shell_reveal_database_directory(app: AppHandle) -> IpcResult<bool> {
    let db = app.state::<DbState>().clone_inner();
    let conn = match db::get_db(&db) {
        Ok(c) => c,
        Err(e) => return IpcResult::err(e),
    };
    let Some(current) = conn.path().map(|p| p.to_string()) else {
        return IpcResult::err("当前数据库无路径");
    };
    let canonical = match security::validate_db_path(&current) {
        Ok(p) => p,
        Err(e) => return IpcResult::err(e),
    };
    let Some(dir) = canonical.parent() else {
        return IpcResult::err("无法获取数据库所在目录");
    };
    match app.shell().open(dir.to_string_lossy().to_string(), None) {
        Ok(()) => IpcResult::ok(true),
        Err(e) => IpcResult::err(e.to_string()),
    }
}
