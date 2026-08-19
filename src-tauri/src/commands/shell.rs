use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;

use crate::db::DbState;
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
pub async fn shell_reveal_database_directory(app: AppHandle) -> IpcResult<bool> {
    let current_path = app.state::<DbState>().inner().path();
    let Some(current) = current_path else {
        return IpcResult::err("当前数据库无路径");
    };
    tauri::async_runtime::spawn_blocking(move || match reveal_directory_path(&current) {
        Ok(dir) => match app.shell().open(dir, None) {
            Ok(()) => IpcResult::ok(true),
            Err(e) => IpcResult::err(e.to_string()),
        },
        Err(e) => IpcResult::err(e),
    })
    .await
    .unwrap_or_else(|e| IpcResult::err(format!("thread error: {}", e)))
}

fn reveal_directory_path(current: &str) -> Result<String, String> {
    let canonical = security::validate_db_path(current)?;
    canonical
        .parent()
        .map(|dir| dir.to_string_lossy().to_string())
        .ok_or_else(|| "无法获取数据库所在目录".into())
}

#[cfg(test)]
mod tests {
    use super::reveal_directory_path;

    #[test]
    fn reveal_directory_path_revalidates_allowed_paths_without_a_pool() {
        let allowed_root = std::env::current_dir().unwrap().join("test-data");
        std::fs::create_dir_all(&allowed_root).unwrap();
        let allowed = allowed_root.join(format!(
            "reveal-path-{}.db",
            std::process::id()
        ));
        std::fs::write(&allowed, []).unwrap();
        assert!(reveal_directory_path(&allowed.to_string_lossy()).is_ok());
        std::fs::remove_file(allowed).unwrap();
        assert!(reveal_directory_path("/tmp/outside.db").is_err());
    }
}
