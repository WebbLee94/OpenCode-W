use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_dialog::FilePath;
use tokio::sync::oneshot;

use crate::models::dto::IpcResult;

/// dialog:openFile — open a file picker filtered to SQLite database files.
///
/// Returns the selected file path, or None if the user cancelled.
/// Path validation is deferred to database_open — the dialog only filters by extension.
///
/// 使用回调式 pick_file + oneshot channel 转换为 async，避免 blocking_pick_file() 冻结主线程。
#[tauri::command]
pub async fn dialog_open_file(app: AppHandle) -> IpcResult<Option<String>> {
    let (tx, rx) = oneshot::channel::<Option<String>>();
    app.dialog()
        .file()
        .add_filter("SQLite Database", &["db", "sqlite", "sqlite3"])
        .pick_file(move |file_path: Option<FilePath>| {
            let result = file_path.map(|fp| fp.to_string());
            let _ = tx.send(result);
        });
    let result = rx.await.unwrap_or(None);
    IpcResult::ok(result)
}

/// dialog:openDirectory — open a directory picker (for session migration target).
///
/// Returns the selected directory path, or None if the user cancelled.
///
/// 使用回调式 pick_folder + oneshot channel 转换为 async，避免 blocking_pick_folder() 冻结主线程。
#[tauri::command]
pub async fn dialog_open_directory(app: AppHandle) -> IpcResult<Option<String>> {
    let (tx, rx) = oneshot::channel::<Option<String>>();
    app.dialog()
        .file()
        .set_title("选择目标项目目录")
        .pick_folder(move |file_path: Option<FilePath>| {
            let result = file_path.map(|fp| fp.to_string());
            let _ = tx.send(result);
        });
    let result = rx.await.unwrap_or(None);
    IpcResult::ok(result)
}
