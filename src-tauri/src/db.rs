#![allow(dead_code)]

use rusqlite::Connection;
use std::path::Path;
use std::sync::{Arc, Mutex};

/// Tauri State for database connection management.
/// Mirrors electron/database.ts DatabaseManager (but NOT a singleton — Tauri manages state).
///
/// 使用 Arc<Mutex<...>> 以便在 async 命令中通过 spawn_blocking 在线程池中
/// 执行数据库操作，避免同步命令阻塞 Tauri 主线程导致 UI 冻结。
pub struct DbState(pub Arc<Mutex<Option<Connection>>>);

impl DbState {
    pub fn new() -> Self {
        DbState(Arc::new(Mutex::new(None)))
    }

    /// Clone the inner Arc for use in spawn_blocking closures.
    pub fn clone_inner(&self) -> Arc<Mutex<Option<Connection>>> {
        Arc::clone(&self.0)
    }

    pub fn is_open(&self) -> bool {
        self.0.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    pub fn path(&self) -> Option<String> {
        self.0.lock().ok().and_then(|g| {
            g.as_ref().and_then(|conn| conn.path().map(|p| p.to_string()))
        })
    }
}

/// Open a database file and set WAL + foreign_keys pragmas.
pub fn open(state: &Mutex<Option<Connection>>, db_path: &str) -> Result<String, String> {
    if !Path::new(db_path).exists() {
        return Err(format!("Database file not found: {}", db_path));
    }

    let abs_path = std::path::PathBuf::from(db_path);
    let abs_path_str = abs_path.to_string_lossy().to_string();

    let conn = Connection::open(&abs_path).map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
        .map_err(|e| e.to_string())?;

    let mut lock = state.lock().map_err(|e| e.to_string())?;
    *lock = Some(conn);
    Ok(abs_path_str)
}

/// Close the current database connection.
pub fn close(state: &Mutex<Option<Connection>>) -> Result<(), String> {
    let mut lock = state.lock().map_err(|e| e.to_string())?;
    *lock = None;
    Ok(())
}

/// Get a reference to the current connection.
pub fn get_db<'a>(state: &'a Mutex<Option<Connection>>) -> Result<std::sync::MutexGuard<'a, Option<Connection>>, String> {
    let lock = state.lock().map_err(|e| e.to_string())?;
    if lock.is_none() {
        return Err("No database currently open".into());
    }
    Ok(lock)
}

/// Health check — integrity, page count, freelist count, WAL size.
pub fn health_check(state: &Mutex<Option<Connection>>) -> HealthInfo {
    let lock = match state.lock() {
        Ok(l) => l,
        Err(e) => {
            return HealthInfo {
                ok: false,
                page_count: 0,
                freelist_pages: 0,
                wal_size: 0,
                current_path: None,
                error: Some(e.to_string()),
            };
        }
    };

    let conn = match lock.as_ref() {
        Some(c) => c,
        None => {
            return HealthInfo {
                ok: false,
                page_count: 0,
                freelist_pages: 0,
                wal_size: 0,
                current_path: None,
                error: Some("No database open".into()),
            };
        }
    };

    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .unwrap_or_default();
    let page_count: i64 = conn
        .query_row("PRAGMA page_count", [], |row| row.get(0))
        .unwrap_or(0);
    let freelist_count: i64 = conn
        .query_row("PRAGMA freelist_count", [], |row| row.get(0))
        .unwrap_or(0);

    // Get current path from db filename
    let current_path = conn.path()        .map(|p| p.to_string());

    // WAL file size
    let wal_size = current_path
        .as_ref()
        .and_then(|p| {
            let wal_path = format!("{}-wal", p);
            std::fs::metadata(&wal_path).ok().map(|m| m.len() as i64)
        })
        .unwrap_or(0);

    HealthInfo {
        ok: integrity == "ok",
        page_count,
        freelist_pages: freelist_count,
        wal_size,
        current_path: current_path.clone(),
        error: None,
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthInfo {
    pub ok: bool,
    pub page_count: i64,
    pub freelist_pages: i64,
    pub wal_size: i64,
    pub current_path: Option<String>,
    pub error: Option<String>,
}

/// Database statistics (mirrors shared/types.ts DatabaseStats).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseStats {
    pub db_size: i64,
    pub root_session_count: i64,
    pub child_session_count: i64,
    pub session_count: i64,
    pub project_count: i64,
    pub part_count: i64,
    pub freelist_size: i64,
    pub wal_size: i64,
    pub error: Option<String>,
}

/// Get full database statistics.
pub fn get_stats(state: &Mutex<Option<Connection>>) -> DatabaseStats {
    let lock = match state.lock() {
        Ok(l) => l,
        Err(e) => {
            return DatabaseStats {
                db_size: 0,
                root_session_count: 0,
                child_session_count: 0,
                session_count: 0,
                project_count: 0,
                part_count: 0,
                freelist_size: 0,
                wal_size: 0,
                error: Some(e.to_string()),
            };
        }
    };

    let conn = match lock.as_ref() {
        Some(c) => c,
        None => {
            return DatabaseStats {
                db_size: 0,
                root_session_count: 0,
                child_session_count: 0,
                session_count: 0,
                project_count: 0,
                part_count: 0,
                freelist_size: 0,
                wal_size: 0,
                error: Some("No database open".into()),
            };
        }
    };

    let current_path = conn.path()        .map(|p| p.to_string());

    // File sizes
    let (db_size, wal_size) = current_path
        .as_ref()
        .map(|p| {
            let db_sz = std::fs::metadata(p).ok().map(|m| m.len() as i64).unwrap_or(0);
            let wal_path = format!("{}-wal", p);
            let wal_sz = std::fs::metadata(&wal_path).ok().map(|m| m.len() as i64).unwrap_or(0);
            (db_sz, wal_sz)
        })
        .unwrap_or((0, 0));

    // Session counts
    let root_count: i64 = conn
        .query_row("SELECT COUNT(*) as cnt FROM session WHERE parent_id IS NULL", [], |row| row.get(0))
        .unwrap_or(0);
    let child_count: i64 = conn
        .query_row("SELECT COUNT(*) as cnt FROM session WHERE parent_id IS NOT NULL", [], |row| row.get(0))
        .unwrap_or(0);
    let project_count: i64 = conn
        .query_row(
            "SELECT COUNT(DISTINCT project_id) as cnt FROM session WHERE project_id IS NOT NULL AND project_id != ''",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let part_count: i64 = conn
        .query_row("SELECT COUNT(*) as cnt FROM part", [], |row| row.get(0))
        .unwrap_or(0);
    let freelist_count: i64 = conn
        .query_row("PRAGMA freelist_count", [], |row| row.get(0))
        .unwrap_or(0);
    let page_size: i64 = conn
        .query_row("PRAGMA page_size", [], |row| row.get(0))
        .unwrap_or(4096);

    DatabaseStats {
        db_size,
        root_session_count: root_count,
        child_session_count: child_count,
        session_count: root_count + child_count,
        project_count,
        part_count,
        freelist_size: freelist_count * page_size,
        wal_size,
        error: None,
    }
}

/// Run VACUUM and return before/after sizes.
pub fn vacuum(state: &Mutex<Option<Connection>>) -> Result<VacuumResult, String> {
    let lock = state.lock().map_err(|e| e.to_string())?;
    let conn = lock.as_ref().ok_or("No database open")?;

    let current_path = conn.path().ok_or("No database path")?;
    let before_size = std::fs::metadata(current_path)
        .ok()
        .map(|m| m.len() as i64)
        .unwrap_or(0);

    conn.execute_batch("VACUUM").map_err(|e| e.to_string())?;

    let after_size = std::fs::metadata(current_path)
        .ok()
        .map(|m| m.len() as i64)
        .unwrap_or(0);

    Ok(VacuumResult {
        before: before_size,
        after: after_size,
        freed: before_size - after_size,
    })
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct VacuumResult {
    pub before: i64,
    pub after: i64,
    pub freed: i64,
}

/// Run WAL checkpoint.
pub fn checkpoint(state: &Mutex<Option<Connection>>) -> Result<(), String> {
    let lock = state.lock().map_err(|e| e.to_string())?;
    let conn = lock.as_ref().ok_or("No database open")?;
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .map_err(|e| e.to_string())
}

/// Execute a raw query returning multiple rows.
pub fn raw_query<T, F>(state: &Mutex<Option<Connection>>, sql: &str, params: &[&dyn rusqlite::types::ToSql], mapper: F) -> Result<Vec<T>, String>
where
    F: FnMut(&rusqlite::Row) -> rusqlite::Result<T>,
{
    let lock = state.lock().map_err(|e| e.to_string())?;
    let conn = lock.as_ref().ok_or("No database open")?;
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params, mapper).map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for row in rows {
        result.push(row.map_err(|e| e.to_string())?);
    }
    Ok(result)
}

/// Execute a raw query returning a single row.
pub fn raw_get<T, F>(state: &Mutex<Option<Connection>>, sql: &str, params: &[&dyn rusqlite::types::ToSql], mapper: F) -> Result<Option<T>, String>
where
    F: FnOnce(&rusqlite::Row) -> rusqlite::Result<T>,
{
    let lock = state.lock().map_err(|e| e.to_string())?;
    let conn = lock.as_ref().ok_or("No database open")?;
    let result = conn.query_row(sql, params, mapper).ok();
    Ok(result)
}

/// Execute a statement and return changes / last_insert_rowid.
pub fn run(state: &Mutex<Option<Connection>>, sql: &str, params: &[&dyn rusqlite::types::ToSql]) -> Result<RunResult, String> {
    let lock = state.lock().map_err(|e| e.to_string())?;
    let conn = lock.as_ref().ok_or("No database open")?;
    let changes = conn.execute(sql, params).map_err(|e| e.to_string())?;
    let last_id = conn.last_insert_rowid();
    Ok(RunResult {
        changes: changes as i64,
        last_insert_rowid: last_id,
    })
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RunResult {
    pub changes: i64,
    pub last_insert_rowid: i64,
}

/// Execute a raw SQL string (no params, for DDL / PRAGMA).
pub fn raw_run(state: &Mutex<Option<Connection>>, sql: &str) -> Result<(), String> {
    let lock = state.lock().map_err(|e| e.to_string())?;
    let conn = lock.as_ref().ok_or("No database open")?;
    conn.execute_batch(sql).map_err(|e| e.to_string())
}
