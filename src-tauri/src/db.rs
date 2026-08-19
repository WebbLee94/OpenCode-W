#![allow(dead_code)]

use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::Connection;
use std::ops::Deref;
use std::path::Path;
use std::sync::{Arc, Mutex};

/// Get a pooled connection from the database state.
///
/// The Mutex is held only briefly to clone the Pool; the actual connection
/// is acquired from the pool after releasing the lock, allowing parallel reads.
pub fn get_conn(
    state: &Mutex<Option<Pool<SqliteConnectionManager>>>,
) -> Result<impl Deref<Target = Connection> + '_ + Send, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    let pool = guard
        .as_ref()
        .ok_or_else(|| String::from("No database currently open"))?
        .clone();
    drop(guard);
    pool.get().map_err(|e| e.to_string())
}

/// Convenience wrapper: get a pooled connection from an `&Arc<Mutex<Option<Pool<...>>>>`.
/// Auto-derefs through Arc so callers can pass `&db` directly.
pub fn get_db(
    state: &Arc<Mutex<Option<Pool<SqliteConnectionManager>>>>,
) -> Result<impl Deref<Target = Connection> + '_, String> {
    get_conn(state.as_ref())
}

/// Tauri State for database connection pool management.
///
/// Wraps `Arc<Mutex<Option<r2d2::Pool>>>` to support interior mutability
/// for open/close while allowing parallel reads via `get_pool()`.
/// The Mutex is held only briefly (to clone the pool), not during SQL execution.
pub struct DbState(pub Arc<Mutex<Option<Pool<SqliteConnectionManager>>>>);

impl DbState {
    pub fn new() -> Self {
        DbState(Arc::new(Mutex::new(None)))
    }

    /// Clone the Arc for move into spawn_blocking closures.
    pub fn clone_inner(&self) -> Arc<Mutex<Option<Pool<SqliteConnectionManager>>>> {
        Arc::clone(&self.0)
    }

    pub fn is_open(&self) -> bool {
        self.0.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    pub fn path(&self) -> Option<String> {
        self.0.lock().ok().and_then(|g| {
            g.as_ref().and_then(|pool| {
                pool.get()
                    .ok()
                    .and_then(|conn| conn.path().map(|p| p.to_string()))
            })
        })
    }
}

/// Lock briefly and clone the Pool for parallel read access.
///
/// The Mutex is released immediately after cloning, allowing concurrent
/// threads to each obtain their own connection via `pool.get()`.
pub fn get_pool(
    state: &Mutex<Option<Pool<SqliteConnectionManager>>>,
) -> Result<Pool<SqliteConnectionManager>, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    guard
        .as_ref()
        .map(|p| p.clone())
        .ok_or_else(|| "No database currently open".into())
}

/// Open a database file and create a connection pool (4 connections, WAL mode).
pub fn open(
    state: &Mutex<Option<Pool<SqliteConnectionManager>>>,
    db_path: &str,
) -> Result<String, String> {
    if !Path::new(db_path).exists() {
        return Err(format!("Database file not found: {}", db_path));
    }

    let abs_path = std::path::PathBuf::from(db_path);
    let abs_path_str = abs_path.to_string_lossy().to_string();

    let manager = SqliteConnectionManager::file(&abs_path).with_init(|conn| {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             PRAGMA cache_size = -64000;
             PRAGMA mmap_size = 268435456;
             PRAGMA synchronous = NORMAL;
             PRAGMA temp_store = MEMORY;
             PRAGMA threads = 4;",
        )
    });

    let pool = Pool::builder()
        .max_size(4)
        .build(manager)
        .map_err(|e| e.to_string())?;

    let mut lock = state.lock().map_err(|e| e.to_string())?;
    *lock = Some(pool);
    Ok(abs_path_str)
}

/// Close the current database pool.
pub fn close(
    state: &Mutex<Option<Pool<SqliteConnectionManager>>>,
) -> Result<(), String> {
    let mut lock = state.lock().map_err(|e| e.to_string())?;
    *lock = None;
    Ok(())
}

/// Health check — integrity, page count, freelist count, WAL size.
pub fn health_check(
    state: &Mutex<Option<Pool<SqliteConnectionManager>>>,
) -> HealthInfo {
    let lock = match state.lock() {
        Ok(l) => l,
        Err(e) => {
            return HealthInfo {
                ok: false,
                page_count: 0,
                freelist_pages: 0,
                wal_size: 0,
                db_size: 0,
                current_path: None,
                error: Some(e.to_string()),
            };
        }
    };
    let pool = match lock.as_ref() {
        Some(p) => p,
        None => {
            return HealthInfo {
                ok: false,
                page_count: 0,
                freelist_pages: 0,
                wal_size: 0,
                db_size: 0,
                current_path: None,
                error: Some("No database open".into()),
            };
        }
    };
    let conn = match pool.get() {
        Ok(c) => c,
        Err(e) => {
            return HealthInfo {
                ok: false,
                page_count: 0,
                freelist_pages: 0,
                wal_size: 0,
                db_size: 0,
                current_path: None,
                error: Some(e.to_string()),
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

    let current_path = conn.path().map(|p| p.to_string());

    // WAL file size
    let wal_size = current_path
        .as_ref()
        .and_then(|p| {
            let wal_path = format!("{}-wal", p);
            std::fs::metadata(&wal_path).ok().map(|m| m.len() as i64)
        })
        .unwrap_or(0);

    // Database file size
    let db_size = current_path
        .as_ref()
        .and_then(|p| std::fs::metadata(p).ok().map(|m| m.len() as i64))
        .unwrap_or(0);

    HealthInfo {
        ok: integrity == "ok",
        page_count,
        freelist_pages: freelist_count,
        wal_size,
        db_size,
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
    pub db_size: i64,
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
pub fn get_stats(
    state: &Mutex<Option<Pool<SqliteConnectionManager>>>,
) -> DatabaseStats {
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
    let pool = match lock.as_ref() {
        Some(p) => p,
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
    let conn = match pool.get() {
        Ok(c) => c,
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

    let current_path = conn.path().map(|p| p.to_string());

    // File sizes
    let (db_size, wal_size) = current_path
        .as_ref()
        .map(|p| {
            let db_sz =
                std::fs::metadata(p).ok().map(|m| m.len() as i64).unwrap_or(0);
            let wal_path = format!("{}-wal", p);
            let wal_sz = std::fs::metadata(&wal_path)
                .ok()
                .map(|m| m.len() as i64)
                .unwrap_or(0);
            (db_sz, wal_sz)
        })
        .unwrap_or((0, 0));

    // Session counts
    let root_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) as cnt FROM session WHERE parent_id IS NULL",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let child_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) as cnt FROM session WHERE parent_id IS NOT NULL",
            [],
            |row| row.get(0),
        )
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
pub fn vacuum(
    state: &Mutex<Option<Pool<SqliteConnectionManager>>>,
) -> Result<VacuumResult, String> {
    let lock = state.lock().map_err(|e| e.to_string())?;
    let pool = lock.as_ref().ok_or("No database open")?;
    let conn = pool.get().map_err(|e| e.to_string())?;

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
pub fn checkpoint(
    state: &Mutex<Option<Pool<SqliteConnectionManager>>>,
) -> Result<(), String> {
    let lock = state.lock().map_err(|e| e.to_string())?;
    let pool = lock.as_ref().ok_or("No database open")?;
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .map_err(|e| e.to_string())
}

/// Execute a raw query returning multiple rows.
pub fn raw_query<T, F>(
    state: &Mutex<Option<Pool<SqliteConnectionManager>>>,
    sql: &str,
    params: &[&dyn rusqlite::types::ToSql],
    mapper: F,
) -> Result<Vec<T>, String>
where
    F: FnMut(&rusqlite::Row) -> rusqlite::Result<T>,
{
    let lock = state.lock().map_err(|e| e.to_string())?;
    let pool = lock.as_ref().ok_or("No database open")?;
    let conn = pool.get().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params, mapper).map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for row in rows {
        result.push(row.map_err(|e| e.to_string())?);
    }
    Ok(result)
}

/// Execute a raw query returning a single row.
pub fn raw_get<T, F>(
    state: &Mutex<Option<Pool<SqliteConnectionManager>>>,
    sql: &str,
    params: &[&dyn rusqlite::types::ToSql],
    mapper: F,
) -> Result<Option<T>, String>
where
    F: FnOnce(&rusqlite::Row) -> rusqlite::Result<T>,
{
    let lock = state.lock().map_err(|e| e.to_string())?;
    let pool = lock.as_ref().ok_or("No database open")?;
    let conn = pool.get().map_err(|e| e.to_string())?;
    let result = conn.query_row(sql, params, mapper).ok();
    Ok(result)
}

/// Execute a statement and return changes / last_insert_rowid.
pub fn run(
    state: &Mutex<Option<Pool<SqliteConnectionManager>>>,
    sql: &str,
    params: &[&dyn rusqlite::types::ToSql],
) -> Result<RunResult, String> {
    let lock = state.lock().map_err(|e| e.to_string())?;
    let pool = lock.as_ref().ok_or("No database open")?;
    let conn = pool.get().map_err(|e| e.to_string())?;
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
pub fn raw_run(
    state: &Mutex<Option<Pool<SqliteConnectionManager>>>,
    sql: &str,
) -> Result<(), String> {
    let lock = state.lock().map_err(|e| e.to_string())?;
    let pool = lock.as_ref().ok_or("No database open")?;
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute_batch(sql).map_err(|e| e.to_string())
}
