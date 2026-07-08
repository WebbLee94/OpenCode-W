use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

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
