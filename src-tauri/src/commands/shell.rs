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
    let canonical = security::resolve_server_snapshot_path(current)?;
    canonical
        .parent()
        .map(|dir| dir.to_string_lossy().to_string())
        .ok_or_else(|| "无法获取数据库所在目录".into())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::reveal_directory_path;
    use crate::security;
    use crate::db::{self, DbState};

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

    #[test]
    fn reveal_directory_path_accepts_a_canonical_backup_snapshot_opened_by_the_server() {
        let backup_dir = dirs::home_dir()
            .unwrap()
            .join(".opencode-w")
            .join("backups");
        fs::create_dir_all(&backup_dir).unwrap();
        let backup = backup_dir.join(format!(
            "reveal-snapshot-{}-{}.db",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        ));
        rusqlite::Connection::open(&backup).unwrap();

        let state = DbState::new();
        let snapshot = db::open(&state, &backup.to_string_lossy()).unwrap();
        let expected_dir = backup_dir.canonicalize().unwrap().to_string_lossy().to_string();

        assert_eq!(state.path(), Some(snapshot.clone()));
        assert_eq!(reveal_directory_path(&snapshot).unwrap(), expected_dir);

        db::close(&state).unwrap();
        fs::remove_file(backup).unwrap();
    }

    #[test]
    fn server_snapshot_resolution_rejects_a_database_outside_the_allowed_roots() {
        let outside = std::env::temp_dir().join(format!(
            "opencode-w-outside-snapshot-{}-{}.db",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        ));
        fs::write(&outside, []).unwrap();

        assert!(security::resolve_server_snapshot_path(&outside.to_string_lossy()).is_err());

        fs::remove_file(outside).unwrap();
    }
}
