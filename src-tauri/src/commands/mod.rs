// Command modules — each module exposes Tauri command functions
// migrated from the corresponding electron/ipc/*.ts handler files.

pub mod analytics;
pub mod backup;
pub mod cleanup;
pub mod database;
pub mod dialog;
pub mod fork_stats;
pub mod health;
pub mod messages;
pub mod sessions;
pub mod shell;
pub mod todos;
pub mod update;

// Re-export all command functions at the module root so that
// main.rs can register them via `commands::command_name`.
pub use analytics::*;
pub use backup::*;
pub use cleanup::*;
pub use database::*;
pub use dialog::*;
pub use health::*;
pub use messages::*;
pub use sessions::*;
pub use shell::*;
pub use todos::*;
pub use update::*;
