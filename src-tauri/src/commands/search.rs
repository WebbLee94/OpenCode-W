//! 全文搜索索引（FTS5 sidecar）状态与构建触发命令。
//!
//! 索引与 OpenCode 库完全分离：sidecar 位于 `app_data_dir/search-index-v1.sqlite`，
//! 源库只读。构建在后台线程分批进行，两个命令都不阻塞 UI。

use tauri::{AppHandle, Manager};

use crate::db::DbState;
use crate::models::dto::IpcResult;
use crate::search::{self, SearchIndex, SearchIndexStatus};

/// search_index_status — 返回当前索引状态（不触发构建）。
///
/// `state`：`none`（从未构建）/ `building` / `ready` / `error`。
#[tauri::command]
pub fn search_index_status(app: AppHandle) -> IpcResult<SearchIndexStatus> {
    let index = app.state::<SearchIndex>().inner().clone();
    IpcResult::ok(index.status())
}

/// search_ensure_index — 确保索引已建立（或正在建立），立即返回当前状态。
///
/// 启动时可调用；重复调用是幂等的：已有构建在跑时直接返回当前状态，
/// 不会并发重复建索引。
#[tauri::command]
pub async fn search_ensure_index(app: AppHandle) -> IpcResult<SearchIndexStatus> {
    let db = app.state::<DbState>().inner().clone();
    let index = app.state::<SearchIndex>().inner().clone();
    IpcResult::ok(search::ensure(&app, &db, &index))
}
