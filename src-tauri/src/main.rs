// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod db;
mod models;
mod security;

use commands::update::UpdateStateMgr;
use db::DbState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(DbState::new())
        .manage(UpdateStateMgr::default())
        .invoke_handler(tauri::generate_handler![
            // health
            commands::database_health,
            // analytics (dashboard)
            commands::dashboard_overview,
            commands::dashboard_tokens,
            commands::dashboard_tool_ranking,
            commands::dashboard_skill_usage,
            commands::dashboard_model_ranking,
            commands::dashboard_provider_stats,
            commands::dashboard_session_trend,
            commands::dashboard_cost_trend,
            commands::dashboard_message_trend,
            // sessions
            commands::sessions_list,
            commands::sessions_detail,
            commands::sessions_projects,
            commands::sessions_delete,
            commands::sessions_rename,
            commands::sessions_children,
            commands::sessions_move,
            commands::session_share_get,
            // messages
            commands::messages_list,
            commands::messages_detail,
            commands::messages_list_by_parent,
            commands::messages_search,
            // todos
            commands::todos_by_parent,
            // cleanup
            commands::cleanup_preview,
            commands::cleanup_execute,
            // database ops
            commands::database_open,
            commands::database_vacuum,
            commands::database_checkpoint,
            // dialog
            commands::dialog_open_file,
            commands::dialog_open_directory,
            // shell
            commands::shell_open_external,
            commands::shell_reveal_database_directory,
            // backup
            commands::backup_create,
            commands::backup_list,
            commands::backup_restore,
            commands::backup_delete,
            commands::backup_preview,
            // update
            commands::update_check,
            commands::update_download,
            commands::update_install,
            commands::update_get_state,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Auto-open the default OpenCode database on startup.
            // Mirrors the original Electron app.whenReady() behavior in electron/main.ts:
            //   1. Try ~/.local/share/opencode/opencode.db
            //   2. Fall back to ./test-data/test.db (dev mode)
            //   3. Silently skip on failure — frontend will show "No Database Connected"
            //      and the user can manually connect via the Settings page.
            let db_state = app.state::<DbState>();
            let mut opened = false;

            if let Some(home) = dirs::home_dir() {
                let default_db = home.join(".local").join("share").join("opencode").join("opencode.db");
                if default_db.exists() {
                    if let Some(path_str) = default_db.to_str() {
                        match db::open(&db_state.0, path_str) {
                            Ok(p) => {
                                log::info!("Auto-opened default database: {}", p);
                                opened = true;
                            }
                            Err(e) => {
                                log::error!("Failed to auto-open default database ({}): {}", path_str, e);
                            }
                        }
                    }
                }
            }

            if !opened {
                let cwd = std::env::current_dir().unwrap_or_default();
                let test_db = cwd.join("test-data").join("test.db");
                if test_db.exists() {
                    if let Some(path_str) = test_db.to_str() {
                        match db::open(&db_state.0, path_str) {
                            Ok(p) => {
                                log::info!("Auto-opened test database: {}", p);
                            }
                            Err(e) => {
                                log::error!("Failed to auto-open test database ({}): {}", path_str, e);
                            }
                        }
                    }
                }
            }

            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn main() {
    run();
}
