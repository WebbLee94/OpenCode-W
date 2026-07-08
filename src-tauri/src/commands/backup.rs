use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use rusqlite::{Connection, OpenFlags};
use tauri::{AppHandle, Manager};

use crate::db::{self, DbState};
use crate::models::dto::{BackupDTO, BackupPreviewDTO, IpcResult};

// ─── Helpers ───────────────────────────────────────────────────────────────

/// Get the backup directory (~/.opencode-w/backups), creating it if needed.
/// Mirrors electron/ipc/backup.ts BACKUP_DIR + ensureBackupDir.
fn get_backup_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("无法获取家目录路径")?;
    let dir = home.join(".opencode-w").join("backups");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

/// Parse a timestamp from a backup filename.
/// "opencode-backup-2024-01-15T10-30-00-000.db" → "2024-01-15T10:30:00.000"
/// Returns None if the filename doesn't match the expected pattern.
fn parse_backup_timestamp(filename: &str) -> Option<String> {
    let prefix = "opencode-backup-";
    let suffix = ".db";
    if !filename.starts_with(prefix) || !filename.ends_with(suffix) {
        return None;
    }
    let raw = &filename[prefix.len()..filename.len() - suffix.len()];
    // raw = "2024-01-15T10-30-00-000"
    let t_idx = raw.find('T')?;
    let date_part = &raw[..t_idx]; // "2024-01-15"
    let time_part = &raw[t_idx + 1..]; // "10-30-00-000"
    let segments: Vec<&str> = time_part.split('-').collect();
    if segments.len() < 3 {
        return None;
    }
    let time = segments[..3].join(":"); // "10:30:00"
    let ms = segments.get(3).copied().unwrap_or("000"); // "000"
    Some(format!("{}T{}.{}", date_part, time, ms))
}

/// List all .db backup files in the backup directory, sorted by createdAt desc.
fn list_backups() -> Result<Vec<BackupDTO>, String> {
    let dir = get_backup_dir()?;
    let mut backups: Vec<BackupDTO> = Vec::new();

    let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        let filename = match path.file_name().and_then(|n| n.to_str()) {
            Some(f) => f.to_string(),
            None => continue,
        };
        if !filename.ends_with(".db") {
            continue;
        }

        let metadata = match fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };

        let file_path = path.to_string_lossy().to_string();
        let file_size = metadata.len() as i64;

        // Try to parse timestamp from filename; fall back to file mtime
        let created_at = parse_backup_timestamp(&filename).unwrap_or_else(|| {
            metadata
                .modified()
                .ok()
                .map(|t| DateTime::<Utc>::from(t).to_rfc3339())
                .unwrap_or_default()
        });

        backups.push(BackupDTO {
            file_name: filename,
            file_path,
            file_size,
            created_at,
            compressed: false,
        });
    }

    // Sort by createdAt descending (newest first)
    backups.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(backups)
}

/// Security check: ensure a resolved path is within the backup directory.
fn ensure_path_in_backup_dir(resolved_path: &Path, backup_dir: &Path) -> Result<(), String> {
    let resolved_dir = backup_dir
        .canonicalize()
        .map_err(|e| format!("无法解析备份目录: {}", e))?;
    if !resolved_path.starts_with(&resolved_dir) {
        return Err("Invalid backup file path".into());
    }
    Ok(())
}

// ─── Commands ──────────────────────────────────────────────────────────────

/// backup:create — copy the current database to the backup directory.
/// Also copies WAL and SHM files if they exist.
#[tauri::command]
pub async fn backup_create(app: AppHandle) -> IpcResult<BackupDTO> {
    let db_path = app.state::<DbState>().path();
    tauri::async_runtime::spawn_blocking(move || {
        let db_path = match db_path {
            Some(p) => p,
            None => return IpcResult::err("No database currently open"),
        };

        let backup_dir = match get_backup_dir() {
            Ok(d) => d,
            Err(e) => return IpcResult::err(e),
        };

        // Generate timestamp-based filename: opencode-backup-2024-01-15T10-30-00-000.db
        let timestamp = Utc::now().format("%Y-%m-%dT%H-%M-%S-%3f").to_string();
        let file_name = format!("opencode-backup-{}.db", timestamp);
        let backup_path = backup_dir.join(&file_name);

        // Copy the main database file
        if let Err(e) = fs::copy(&db_path, &backup_path) {
            return IpcResult::err(e.to_string());
        }

        // Also copy WAL and SHM files if they exist
        let wal_src = format!("{}-wal", db_path);
        let shm_src = format!("{}-shm", db_path);
        let backup_path_str = backup_path.to_string_lossy().to_string();
        let wal_dst = format!("{}-wal", backup_path_str);
        let shm_dst = format!("{}-shm", backup_path_str);
        if Path::new(&wal_src).exists() {
            let _ = fs::copy(&wal_src, &wal_dst);
        }
        if Path::new(&shm_src).exists() {
            let _ = fs::copy(&shm_src, &shm_dst);
        }

        let file_size = fs::metadata(&backup_path)
            .ok()
            .map(|m| m.len() as i64)
            .unwrap_or(0);

        IpcResult::ok(BackupDTO {
            file_name,
            file_path: backup_path_str,
            file_size,
            created_at: Utc::now().to_rfc3339(),
            compressed: false,
        })
    })
    .await
    .unwrap_or_else(|e| IpcResult::err(format!("thread error: {}", e)))
}

/// backup:list — list all backup files, sorted by creation time (newest first).
#[tauri::command]
pub async fn backup_list() -> IpcResult<Vec<BackupDTO>> {
    tauri::async_runtime::spawn_blocking(move || match list_backups() {
        Ok(v) => IpcResult::ok(v),
        Err(e) => IpcResult::err(e),
    })
    .await
    .unwrap_or_else(|e| IpcResult::err(format!("thread error: {}", e)))
}

/// backup:restore — restore a backup file (or the latest one if path is None).
/// Creates a safety backup of the current database before restoring.
///
/// 前端 ipc.ts 将单字符串参数包装为 `{ value: arg }`，因此 Rust 端使用 `value: Option<String>` 接收。
#[tauri::command]
pub async fn backup_restore(app: AppHandle, value: Option<String>) -> IpcResult<String> {
    let db = app.state::<DbState>().clone_inner();
    let previous_path = app.state::<DbState>().path();
    tauri::async_runtime::spawn_blocking(move || {
        let path = value;
        let backup_dir = match get_backup_dir() {
            Ok(d) => d,
            Err(e) => return IpcResult::err(e),
        };

        let backup_path = if let Some(p) = path {
            // Security: ensure the provided path is within the backup directory
            let resolved = match Path::new(&p).canonicalize() {
                Ok(rp) => rp,
                Err(_) => return IpcResult::err("Backup file not found"),
            };
            if let Err(e) = ensure_path_in_backup_dir(&resolved, &backup_dir) {
                return IpcResult::err(e);
            }
            resolved.to_string_lossy().to_string()
        } else {
            // Fall back to the latest backup
            let backups = match list_backups() {
                Ok(b) => b,
                Err(e) => return IpcResult::err(e),
            };
            match backups.first() {
                Some(b) => b.file_path.clone(),
                None => return IpcResult::err("No backup files found"),
            }
        };

        if !Path::new(&backup_path).exists() {
            return IpcResult::err("Backup file not found");
        }

        // Create a safety backup before restore (best-effort)
        if let Some(ref prev) = previous_path {
            if Path::new(prev).exists() {
                let safety_ts = Utc::now().format("%Y-%m-%dT%H-%M-%S-%3f").to_string();
                let safety_path = backup_dir.join(format!("safety-{}.db", safety_ts));
                let _ = fs::copy(prev, &safety_path);
            }
        }

        // Close current database
        if let Err(e) = db::close(&db) {
            return IpcResult::err(e);
        }

        // Open the backup as the new database
        match db::open(&db, &backup_path) {
            Ok(p) => IpcResult::ok(p),
            Err(e) => {
                // Rollback: try to reopen the previous database
                if let Some(ref prev) = previous_path {
                    let _ = db::open(&db, prev);
                }
                IpcResult::err(e)
            }
        }
    })
    .await
    .unwrap_or_else(|e| IpcResult::err(format!("thread error: {}", e)))
}

/// backup:delete — delete a backup file from the backup directory.
/// Also removes associated WAL and SHM files if they exist.
///
/// 前端 ipc.ts 将单字符串参数包装为 `{ value: arg }`，因此 Rust 端使用 `value: String` 接收。
#[tauri::command]
pub async fn backup_delete(value: String) -> IpcResult<bool> {
    tauri::async_runtime::spawn_blocking(move || {
        let file_name = value;
        let backup_dir = match get_backup_dir() {
            Ok(d) => d,
            Err(e) => return IpcResult::err(e),
        };

        let file_path = backup_dir.join(&file_name);

        // Security: ensure the file is within the backup directory
        let resolved_path = match file_path.canonicalize() {
            Ok(p) => p,
            Err(_) => return IpcResult::err("Backup file not found"),
        };
        if let Err(e) = ensure_path_in_backup_dir(&resolved_path, &backup_dir) {
            return IpcResult::err(e);
        }

        if let Err(e) = fs::remove_file(&resolved_path) {
            return IpcResult::err(e.to_string());
        }

        // Also remove WAL and SHM files if they exist
        let resolved_str = resolved_path.to_string_lossy().to_string();
        let wal_path = format!("{}-wal", resolved_str);
        let shm_path = format!("{}-shm", resolved_str);
        if Path::new(&wal_path).exists() {
            let _ = fs::remove_file(&wal_path);
        }
        if Path::new(&shm_path).exists() {
            let _ = fs::remove_file(&shm_path);
        }

        IpcResult::ok(true)
    })
    .await
    .unwrap_or_else(|e| IpcResult::err(format!("thread error: {}", e)))
}

/// backup:preview — preview a backup file's contents in read-only mode.
/// Returns backup metadata plus session/message/part counts.
///
/// 前端 ipc.ts 将单字符串参数包装为 `{ value: arg }`，因此 Rust 端使用 `value: String` 接收。
#[tauri::command]
pub async fn backup_preview(value: String) -> IpcResult<BackupPreviewDTO> {
    tauri::async_runtime::spawn_blocking(move || {
        let file_name = value;
        let backup_dir = match get_backup_dir() {
            Ok(d) => d,
            Err(e) => return IpcResult::err(e),
        };

        let file_path = backup_dir.join(&file_name);

        // Security: ensure the file is within the backup directory
        let resolved_path = match file_path.canonicalize() {
            Ok(p) => p,
            Err(_) => return IpcResult::err("Backup file not found"),
        };
        if let Err(e) = ensure_path_in_backup_dir(&resolved_path, &backup_dir) {
            return IpcResult::err(e);
        }

        let metadata = match fs::metadata(&resolved_path) {
            Ok(m) => m,
            Err(e) => return IpcResult::err(e.to_string()),
        };

        let backup = BackupDTO {
            file_name,
            file_path: resolved_path.to_string_lossy().to_string(),
            file_size: metadata.len() as i64,
            created_at: metadata
                .modified()
                .ok()
                .map(|t| DateTime::<Utc>::from(t).to_rfc3339())
                .unwrap_or_default(),
            compressed: false,
        };

        // Try to open the backup file read-only to get content counts.
        // If we can't read the backup database, just return 0 counts.
        let (session_count, message_count, part_count) = {
            let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
            match Connection::open_with_flags(&resolved_path, flags) {
                Ok(conn) => {
                    let s: i64 = conn
                        .query_row("SELECT COUNT(*) as cnt FROM session", (), |row| row.get(0))
                        .unwrap_or(0);
                    let m: i64 = conn
                        .query_row("SELECT COUNT(*) as cnt FROM message", (), |row| row.get(0))
                        .unwrap_or(0);
                    let p: i64 = conn
                        .query_row("SELECT COUNT(*) as cnt FROM part", (), |row| row.get(0))
                        .unwrap_or(0);
                    (s, m, p)
                }
                Err(_) => (0, 0, 0),
            }
        };

        IpcResult::ok(BackupPreviewDTO {
            backup,
            session_count,
            message_count,
            part_count,
        })
    })
    .await
    .unwrap_or_else(|e| IpcResult::err(format!("thread error: {}", e)))
}
