use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::UpdaterExt;

use crate::models::dto::{
    IpcResult, UpdateCheckResult, UpdateErrorPayload, UpdateInfo, UpdateProgress, UpdateState,
};

// ─── Tauri event names (mapped from Electron IPC_CHANNELS.UPDATE_EVENT_*) ───
const EVENT_AVAILABLE: &str = "update://available";
const EVENT_NOT_AVAILABLE: &str = "update://not-available";
const EVENT_PROGRESS: &str = "update://progress";
const EVENT_DOWNLOADED: &str = "update://downloaded";
const EVENT_ERROR: &str = "update://error";

// ─── State management ───────────────────────────────────────────────────────

/// Managed state for the update lifecycle.
/// Mirrors the module-level `currentState` / `currentInfo` in electron/ipc/update.ts.
pub struct UpdateStateMgr(pub Mutex<UpdateStateInternal>);

pub struct UpdateStateInternal {
    pub state: UpdateState,
    pub update_info: Option<UpdateInfo>,
    pub error: Option<String>,
}

impl Default for UpdateStateMgr {
    fn default() -> Self {
        Self(Mutex::new(UpdateStateInternal {
            state: UpdateState::Idle,
            update_info: None,
            error: None,
        }))
    }
}

fn set_state(mgr: &UpdateStateMgr, new_state: UpdateState) {
    if let Ok(mut guard) = mgr.0.lock() {
        guard.state = new_state;
    }
}

fn set_info(mgr: &UpdateStateMgr, info: Option<UpdateInfo>) {
    if let Ok(mut guard) = mgr.0.lock() {
        guard.update_info = info;
    }
}

fn set_error(mgr: &UpdateStateMgr, error: Option<String>) {
    if let Ok(mut guard) = mgr.0.lock() {
        guard.error = error;
    }
}

fn emit_error(app: &AppHandle, message: String) {
    let _ = app.emit(
        EVENT_ERROR,
        UpdateErrorPayload {
            code: "unknown".into(),
            message,
        },
    );
}

// ─── Commands ───────────────────────────────────────────────────────────────

/// update:check — check for available updates via tauri-plugin-updater.
///
/// On success, pushes `update://available` (with UpdateInfo) or
/// `update://not-available` event to the frontend.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> IpcResult<UpdateCheckResult> {
    let state = app.state::<UpdateStateMgr>();
    set_state(&state, UpdateState::Idle);
    set_error(&state, None);

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            let msg = e.to_string();
            set_error(&state, Some(msg.clone()));
            emit_error(&app, msg);
            return IpcResult::err("更新插件未配置");
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            let info = UpdateInfo {
                version: update.version.clone(),
                release_date: update
                    .date
                    .map(|d| d.to_string())
                    .unwrap_or_default(),
                release_notes: update.body.clone().unwrap_or_default(),
                size_bytes: 0,
            };
            set_state(&state, UpdateState::Available);
            set_info(&state, Some(info.clone()));
            let _ = app.emit(EVENT_AVAILABLE, &info);
            IpcResult::ok(UpdateCheckResult {
                available: true,
                info: Some(info),
            })
        }
        Ok(None) => {
            let _ = app.emit(EVENT_NOT_AVAILABLE, ());
            IpcResult::ok(UpdateCheckResult {
                available: false,
                info: None,
            })
        }
        Err(e) => {
            let msg = e.to_string();
            set_error(&state, Some(msg.clone()));
            emit_error(&app, msg);
            IpcResult::err("检查更新失败")
        }
    }
}

/// update:download — download and install the update.
///
/// Uses `download_and_install` which streams the package and installs it.
/// Pushes `update://progress` events during download and
/// `update://downloaded` (with UpdateInfo) on completion.
#[tauri::command]
pub async fn update_download(app: AppHandle) -> IpcResult<bool> {
    let state = app.state::<UpdateStateMgr>();
    set_state(&state, UpdateState::Downloading);
    set_error(&state, None);

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            let msg = e.to_string();
            set_error(&state, Some(msg.clone()));
            set_state(&state, UpdateState::Available);
            emit_error(&app, msg);
            return IpcResult::err("更新插件未配置");
        }
    };

    let update = match updater.check().await {
        Ok(Some(u)) => u,
        Ok(None) => {
            set_state(&state, UpdateState::Idle);
            return IpcResult::err("无可用的更新");
        }
        Err(e) => {
            let msg = e.to_string();
            set_error(&state, Some(msg.clone()));
            set_state(&state, UpdateState::Available);
            emit_error(&app, msg);
            return IpcResult::err("检查更新失败");
        }
    };

    let info = UpdateInfo {
        version: update.version.clone(),
        release_date: update
            .date
            .map(|d| d.to_string())
            .unwrap_or_default(),
        release_notes: update.body.clone().unwrap_or_default(),
        size_bytes: 0,
    };
    set_info(&state, Some(info.clone()));

    let app_for_chunks = app.clone();
    let app_for_finish = app.clone();
    let mut transferred: u64 = 0;

    match update
        .download_and_install(
            move |chunk_len, content_length| {
                transferred += chunk_len as u64;
                let percent = content_length
                    .map(|total| (transferred as f64 / total as f64) * 100.0)
                    .unwrap_or(0.0);
                let _ = app_for_chunks.emit(
                    EVENT_PROGRESS,
                    UpdateProgress {
                        bytes_per_second: 0.0,
                        percent,
                        transferred,
                        total: content_length.unwrap_or(0),
                    },
                );
            },
            move || {
                let _ = app_for_finish.emit(EVENT_DOWNLOADED, &info);
            },
        )
        .await
    {
        Ok(()) => {
            set_state(&state, UpdateState::Downloaded);
            IpcResult::ok(true)
        }
        Err(e) => {
            let msg = e.to_string();
            set_error(&state, Some(msg.clone()));
            set_state(&state, UpdateState::Available);
            emit_error(&app, msg);
            IpcResult::err("下载更新失败")
        }
    }
}

/// update:install — mark state as Installing.
///
/// The actual installation is performed by `download_and_install` in update_download.
/// App relaunch is handled by the frontend via @tauri-apps/plugin-process.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> IpcResult<bool> {
    if let Some(mgr) = app.try_state::<UpdateStateMgr>() {
        set_state(&mgr, UpdateState::Installing);
    }
    IpcResult::ok(true)
}

/// update:get-state — return the current update state.
#[tauri::command]
pub fn update_get_state(state: State<UpdateStateMgr>) -> IpcResult<UpdateState> {
    match state.0.lock() {
        Ok(guard) => IpcResult::ok(guard.state.clone()),
        Err(e) => IpcResult::err(e.to_string()),
    }
}
