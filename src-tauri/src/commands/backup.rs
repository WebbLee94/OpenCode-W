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
    if !(segments.len() == 3 || segments.len() == 4) {
        return None;
    }
    let time = segments[..3].join(":"); // "10:30:00"
    let ms = segments.get(3).copied().unwrap_or("000"); // "000"
    if ms.len() != 3 || !ms.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let timestamp = format!("{}T{}.{}Z", date_part, time, ms);
    DateTime::parse_from_rfc3339(&timestamp).ok().map(|parsed| {
        parsed
            .with_timezone(&Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    })
}

fn backup_timestamp_metadata(now: DateTime<Utc>) -> (String, String) {
    (
        now.format("%Y-%m-%dT%H-%M-%S-%3f").to_string(),
        now.to_rfc3339(),
    )
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use chrono::{DateTime, TimeZone, Utc};
    use rusqlite::Connection;

    use super::{
        backup_content_counts, backup_timestamp_metadata, list_backups_in_dir,
        parse_backup_timestamp, restore_backup_in_dir,
    };
    use crate::db::{self, DbState};
    use crate::security;

    /// 备份预览的计数按方言分支（TASK-025）。
    #[test]
    fn backup_content_counts_follow_the_database_dialect() {
        let fixture = |file: &str| -> Option<Connection> {
            let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../test-data")
                .join(file);
            if !source.is_file() {
                eprintln!("[skip] 缺少夹具 {file}");
                return None;
            }
            let dir = std::env::temp_dir().join(format!(
                "opencode-w-backup-count-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .expect("clock after epoch")
                    .as_nanos()
            ));
            fs::create_dir_all(&dir).expect("temp dir is created");
            let path = dir.join("fixture.db");
            fs::copy(&source, &path).expect("fixture is copied");
            let conn = Connection::open(&path).expect("fixture opens");
            let _ = fs::remove_dir_all(&dir);
            Some(conn)
        };

        // v1：会话 / 消息 / part 行数，is_v2 = false。
        let Some(conn) = fixture("test.db") else { return };
        assert_eq!(backup_content_counts(&conn), (5, 20, 80, false));

        // v2-fresh：没有旧表，part 计数为 0，is_v2 = true。
        let Some(conn) = fixture("v2-fresh.db") else { return };
        assert_eq!(backup_content_counts(&conn), (6, 20, 0, true));

        // v2-mixed：与 v2-fresh 同口径，只统计 v2 表，is_v2 = true。
        let Some(conn) = fixture("v2-mixed.db") else { return };
        assert_eq!(
            backup_content_counts(&conn),
            (6, 20, 0, true),
            "6 个 v2 会话；20 条 v2 消息；旧表冻结副本不计入"
        );
    }

    fn remove_database_files(path: &Path) {
        for suffix in ["", "-wal", "-shm"] {
            let candidate = if suffix.is_empty() {
                path.to_path_buf()
            } else {
                Path::new(&format!("{}{}", path.display(), suffix)).to_path_buf()
            };
            let _ = fs::remove_file(candidate);
        }
    }

    #[test]
    fn parse_backup_timestamp_returns_an_explicit_utc_timestamp() {
        assert_eq!(
            parse_backup_timestamp("opencode-backup-2024-01-15T10-30-00-000.db"),
            Some("2024-01-15T10:30:00.000Z".into())
        );
        assert_eq!(
            parse_backup_timestamp("opencode-backup-2024-01-15T10-30-00.db"),
            Some("2024-01-15T10:30:00.000Z".into())
        );
        assert_eq!(
            parse_backup_timestamp("backup-2024-01-15T10-30-00.db"),
            None
        );
        assert_eq!(
            parse_backup_timestamp("opencode-backup-2024-01-15 10-30-00.db"),
            None
        );
        assert_eq!(
            parse_backup_timestamp("opencode-backup-2024-01-15T10-30-00.txt"),
            None
        );
    }

    #[test]
    fn parse_backup_timestamp_rejects_invalid_and_surplus_segments() {
        assert_eq!(
            parse_backup_timestamp("opencode-backup-2024-02-30T10-30-00.db"),
            None
        );
        assert_eq!(
            parse_backup_timestamp("opencode-backup-2024-01-15T25-30-00.db"),
            None
        );
        assert_eq!(
            parse_backup_timestamp("opencode-backup-2024-01-15T10-30-00-123-extra.db"),
            None
        );
        assert_eq!(
            parse_backup_timestamp("opencode-backup-2024-01-15T10-30.db"),
            None
        );
    }

    #[test]
    fn backup_metadata_derives_filename_and_dto_time_from_one_instant() {
        let now = Utc.with_ymd_and_hms(2024, 1, 15, 10, 30, 0).unwrap();
        let (timestamp, created_at) = backup_timestamp_metadata(now);
        let parsed_filename =
            parse_backup_timestamp(&format!("opencode-backup-{}.db", timestamp)).unwrap();

        assert_eq!(
            DateTime::parse_from_rfc3339(&parsed_filename).unwrap(),
            DateTime::parse_from_rfc3339(&created_at).unwrap()
        );
    }

    #[test]
    fn list_backups_normalizes_legacy_timestamps_and_falls_back_to_mtime_before_sorting() {
        let dir = std::env::temp_dir().join(format!(
            "opencode-w-backup-list-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap()
        ));
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join("opencode-backup-2024-01-15T10-30-00.db"), []).unwrap();
        fs::write(dir.join("opencode-backup-2024-01-15T10-30-00-250.db"), []).unwrap();
        let fallback = dir.join("not-a-backup.db");
        fs::write(&fallback, []).unwrap();
        let modified =
            std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_705_406_400);
        fs::File::open(&fallback)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();

        let backups = list_backups_in_dir(&dir).unwrap();

        assert_eq!(backups[0].file_name, "not-a-backup.db");
        assert_eq!(backups[0].created_at, "2024-01-16T12:00:00+00:00");
        assert_eq!(backups[1].created_at, "2024-01-15T10:30:00.250Z");
        assert_eq!(backups[2].created_at, "2024-01-15T10:30:00.000Z");

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn restore_lifecycle_opens_trusted_backup_snapshot_and_rejects_outside_input() {
        // db::open / db::close 会推进 fork_stats 的进程级缓存 generation，
        // 与缓存测试共用同一把锁，避免失效落在 dedup 与断言之间。
        let _cache_guard = crate::commands::fork_stats::test_serial_guard();
        let root = std::env::temp_dir().join(format!(
            "opencode-w-backup-restore-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap()
        ));
        let backup_dir = root.join("backups");
        fs::create_dir_all(&backup_dir).unwrap();
        let original = root.join("original.db");
        let backup = backup_dir.join("opencode-backup-2024-01-15T10-30-00-000.db");
        let outside = root.join("outside.db");

        {
            let connection = Connection::open(&original).unwrap();
            // 夹具必须是可打开的 OpenCode 库：db::open 会拒绝非 OpenCode 文件。
            connection
                .execute_batch(crate::schema::fixtures::v1_schema())
                .unwrap();
            connection
                .execute_batch(
                    "CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('original');",
                )
                .unwrap();
        }
        {
            let connection = Connection::open(&backup).unwrap();
            connection
                .execute_batch(crate::schema::fixtures::v1_schema())
                .unwrap();
            connection
                .execute_batch(
                    "CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('backup');",
                )
                .unwrap();
        }
        Connection::open(&outside).unwrap();

        let state = DbState::new();
        db::open(&state, &original.to_string_lossy()).unwrap();

        let restored = restore_backup_in_dir(
            &state,
            state.path(),
            Some(backup.to_string_lossy().to_string()),
            &backup_dir,
        )
        .unwrap();

        assert_eq!(state.path(), Some(restored.clone()));
        assert_eq!(
            db::get_db(&state.0)
                .unwrap()
                .query_row("SELECT value FROM marker", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "backup"
        );
        assert_eq!(
            security::resolve_server_snapshot_path_in_backup_root(&restored, &backup_dir).unwrap(),
            backup.canonicalize().unwrap()
        );
        assert!(restore_backup_in_dir(
            &state,
            state.path(),
            Some(outside.to_string_lossy().to_string()),
            &backup_dir,
        )
        .is_err());

        db::close(&state).unwrap();
        for entry in fs::read_dir(&backup_dir).unwrap().flatten() {
            if entry.file_name().to_string_lossy().starts_with("safety-") {
                remove_database_files(&entry.path());
            }
        }
        remove_database_files(&original);
        remove_database_files(&backup);
        remove_database_files(&outside);
        fs::remove_dir_all(root).unwrap();
    }
}

/// List all .db backup files in the backup directory, sorted by createdAt desc.
fn list_backups_in_dir(dir: &Path) -> Result<Vec<BackupDTO>, String> {
    let mut backups: Vec<BackupDTO> = Vec::new();

    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
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
        });
    }

    // Sort by createdAt descending (newest first)
    backups.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(backups)
}

fn list_backups() -> Result<Vec<BackupDTO>, String> {
    let dir = get_backup_dir()?;
    list_backups_in_dir(&dir)
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

fn restore_backup_in_dir(
    db: &DbState,
    previous_path: Option<String>,
    requested_path: Option<String>,
    backup_dir: &Path,
) -> Result<String, String> {
    let backup_dir = backup_dir
        .canonicalize()
        .map_err(|e| format!("无法解析备份目录: {}", e))?;
    let backup_path = if let Some(path) = requested_path {
        let resolved = Path::new(&path)
            .canonicalize()
            .map_err(|_| String::from("Backup file not found"))?;
        ensure_path_in_backup_dir(&resolved, &backup_dir)?;
        resolved
    } else {
        list_backups_in_dir(&backup_dir)?
            .first()
            .map(|backup| PathBuf::from(&backup.file_path))
            .ok_or_else(|| String::from("No backup files found"))?
    };

    if !backup_path.is_file() {
        return Err("Backup file not found".into());
    }

    if let Some(previous_path) = &previous_path {
        if Path::new(previous_path).is_file() {
            let safety_path = backup_dir.join(format!(
                "safety-{}.db",
                Utc::now().format("%Y-%m-%dT%H-%M-%S-%3f")
            ));
            let _ = fs::copy(previous_path, safety_path);
        }
    }

    db::close(db)?;
    let backup_path = backup_path.to_string_lossy().to_string();
    match db::open(db, &backup_path) {
        Ok(snapshot) => Ok(snapshot),
        Err(error) => {
            if let Some(previous_path) = previous_path {
                let _ = db::open(db, &previous_path);
            }
            Err(error)
        }
    }
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
        let now = Utc::now();
        let (timestamp, created_at) = backup_timestamp_metadata(now);
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
            created_at,
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
    let state = app.state::<DbState>();
    if let Err(e) = db::ensure_writable(&state) {
        return IpcResult::err(e);
    }
    let db = state.inner().clone();
    let previous_path = db.path();
    tauri::async_runtime::spawn_blocking(move || {
        // 实时迁移闸门：缓存可能是开库时的旧值（OpenCode 之后才启动迁移）。
        // 恢复会覆盖当前库文件，必须在动文件之前确认没有迁移在进行。
        // 没有已打开的库时跳过检查（恢复会打开另一个文件，没有可被破坏的迁移）。
        if db.is_open() {
            let pool = db.clone_inner();
            let conn = match db::get_db(&pool) {
                Ok(c) => c,
                // 拿不到连接 → 无法确认迁移状态 → 保守拒绝。
                Err(e) => {
                    return IpcResult::err(format!("无法确认数据库迁移状态，已阻止恢复：{}", e))
                }
            };
            if let Err(e) = db::ensure_writable_conn(&conn) {
                return IpcResult::err(e);
            }
        }

        let backup_dir = match get_backup_dir() {
            Ok(d) => d,
            Err(e) => return IpcResult::err(e),
        };

        match restore_backup_in_dir(&db, previous_path, value, &backup_dir) {
            Ok(path) => IpcResult::ok(path),
            Err(error) => IpcResult::err(error),
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

/// 备份文件里的内容计数（按方言分支，TASK-025）。
///
/// - v1：`session` / `message` / `part` 行数；
/// - v2-fresh：`session_v2` / `session_message` 行数，没有 part 表 → 0；
/// - v2-mixed：与 v2-fresh 同口径，只统计 v2 表（v2-only 收口；
///   旧表是迁移后的冻结副本，不是 OpenCode-W 的读对象）。
fn backup_content_counts(conn: &Connection) -> (i64, i64, i64, bool) {
    // 先用与主库相同的探测逻辑判定备份的方言：v2 备份没有
    // `session` / `message` / `part` 表，直接查会静默变成 0。
    let v2 = crate::schema::detect(conn)
        .map(|info| info.mode.is_v2())
        .unwrap_or(false);
    if !v2 {
        let sessions: i64 = conn
            .query_row("SELECT COUNT(*) as cnt FROM session", (), |row| row.get(0))
            .unwrap_or(0);
        let messages: i64 = conn
            .query_row("SELECT COUNT(*) as cnt FROM message", (), |row| row.get(0))
            .unwrap_or(0);
        let parts: i64 = conn
            .query_row("SELECT COUNT(*) as cnt FROM part", (), |row| row.get(0))
            .unwrap_or(0);
        return (sessions, messages, parts, false);
    }

    let v2_sessions: i64 = conn
        .query_row("SELECT COUNT(*) FROM session_v2", (), |row| row.get(0))
        .unwrap_or(0);
    let v2_messages: i64 = conn
        .query_row("SELECT COUNT(*) FROM session_message", (), |row| row.get(0))
        .unwrap_or(0);

    // v2-only：旧表冻结副本不计入内容计数，v2 没有 part 表 → 0。
    (v2_sessions, v2_messages, 0, true)
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
        };

        // Try to open the backup file read-only to get content counts.
        // If we can't read the backup database, just return 0 counts.
        let (session_count, message_count, part_count, is_v2) = {
            let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
            match Connection::open_with_flags(&resolved_path, flags) {
                Ok(conn) => backup_content_counts(&conn),
                Err(_) => (0, 0, 0, false),
            }
        };
        IpcResult::ok(BackupPreviewDTO {
            backup,
            session_count,
            message_count,
            part_count,
            is_v2,
        })
    })
    .await
    .unwrap_or_else(|e| IpcResult::err(format!("thread error: {}", e)))
}
