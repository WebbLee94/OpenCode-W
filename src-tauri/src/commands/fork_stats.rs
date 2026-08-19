use rusqlite::Connection;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const MAX_CANDIDATES: usize = 256;
pub const MAX_ROWS: usize = 50_000;
pub const MAX_DIGESTS: usize = 50_000;

#[derive(Clone)]
struct CacheEntry {
    created_at: Instant,
    value: DedupSet,
}

type CacheKey = (String, Option<(i64, i64)>, u64);
type DedupCache = BTreeMap<CacheKey, CacheEntry>;

fn cache() -> &'static Mutex<DedupCache> {
    static CACHE: OnceLock<Mutex<DedupCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn generation() -> &'static std::sync::atomic::AtomicU64 {
    static GENERATION: OnceLock<std::sync::atomic::AtomicU64> = OnceLock::new();
    GENERATION.get_or_init(|| std::sync::atomic::AtomicU64::new(0))
}

pub fn invalidate_cache() {
    generation().fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    if let Ok(mut entry) = cache().lock() {
        entry.clear();
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct DedupSet {
    pub hidden_sessions: BTreeSet<String>,
    pub hidden_messages: BTreeSet<String>,
    pub hidden_parts: BTreeSet<String>,
    pub exhausted: bool,
}

impl DedupSet {
    pub fn session_ids_json(&self) -> String {
        serde_json::to_string(&self.hidden_sessions).unwrap_or_else(|_| "[]".to_string())
    }

    pub fn message_ids_json(&self) -> String {
        serde_json::to_string(&self.hidden_messages).unwrap_or_else(|_| "[]".to_string())
    }

    pub fn part_ids_json(&self) -> String {
        serde_json::to_string(&self.hidden_parts).unwrap_or_else(|_| "[]".to_string())
    }
}

#[derive(Debug)]
struct Budget {
    candidates: usize,
    rows: usize,
    digests: usize,
    exhausted: bool,
}

impl Budget {
    fn spend_candidate(&mut self) -> bool {
        self.candidates += 1;
        self.candidates <= MAX_CANDIDATES
    }

    fn spend_row(&mut self) -> bool {
        self.rows += 1;
        self.exhausted = self.rows > MAX_ROWS;
        !self.exhausted
    }

    fn spend_digest(&mut self) -> bool {
        self.digests += 1;
        self.exhausted = self.digests > MAX_DIGESTS;
        !self.exhausted
    }
}

#[derive(Debug, Clone)]
struct SessionMeta {
    id: String,
    directory: String,
    project_id: String,
    created: i64,
}

#[derive(Debug)]
struct Message {
    id: String,
    role: String,
    digest: [u8; 32],
    part_ids: Vec<String>,
}

#[derive(Debug)]
struct Transcript {
    messages: Vec<Message>,
}

/// Returns the branch IDs to hide from logical statistics without mutating the database.
/// Evidence reads are not date-filtered; an exhausted request hides nothing.
pub fn dedup(conn: &Connection) -> Result<DedupSet, String> {
    dedup_cached(conn, None)
}

/// Date-window variant: only branch sessions created inside the window are evaluated,
/// so large databases do not exhaust the per-request budget on narrow date filters.
/// Candidate/source evidence remains unrestricted.
pub fn dedup_for_window(conn: &Connection, start_ms: i64, end_ms: i64) -> Result<DedupSet, String> {
    dedup_cached(conn, Some((start_ms, end_ms)))
}

fn dedup_cached(conn: &Connection, window: Option<(i64, i64)>) -> Result<DedupSet, String> {
    let Some(path) = conn
        .path()
        .and_then(|path| std::path::Path::new(path).canonicalize().ok())
        .map(|path| path.to_string_lossy().into_owned())
    else {
        return dedup_impl(conn, window);
    };
    let current_generation = generation().load(std::sync::atomic::Ordering::Acquire);
    let key = (path.clone(), window, current_generation);
    if let Ok(guard) = cache().lock() {
        if let Some(entry) = guard.get(&key) {
            if entry.created_at.elapsed() <= Duration::from_secs(5) {
                return Ok(entry.value.clone());
            }
        }
    }
    let value = dedup_impl(conn, window)?;
    if let Ok(mut guard) = cache().lock() {
        guard.insert(
            key,
            CacheEntry {
                created_at: Instant::now(),
                value: value.clone(),
            },
        );
    }
    Ok(value)
}

fn dedup_impl(conn: &Connection, branch_window: Option<(i64, i64)>) -> Result<DedupSet, String> {
    let mut budget = Budget {
        candidates: 0,
        rows: 0,
        digests: 0,
        exhausted: false,
    };
    let mut result = DedupSet::default();
    let mut stmt = conn
        .prepare(
            "SELECT id, directory, project_id, time_created FROM session ORDER BY time_created, id",
        )
        .map_err(|e| e.to_string())?;
    let mut branches = stmt.query([]).map_err(|e| e.to_string())?;

    while let Some(row) = branches.next().map_err(|e| e.to_string())? {
        let branch = session_meta(row)?;
        if let Some((start, end)) = branch_window {
            if branch.created < start || branch.created > end {
                continue;
            }
        }
        if branch.directory.is_empty() || branch.project_id.is_empty() {
            continue;
        }
        let source_id = match only_eligible_candidate(conn, &branch, &mut budget)? {
            CandidateDiscovery::None => continue,
            CandidateDiscovery::One(id) => id,
            CandidateDiscovery::Multiple => {
                return Ok(if budget.exhausted {
                    DedupSet {
                        exhausted: true,
                        ..DedupSet::default()
                    }
                } else {
                    DedupSet::default()
                });
            }
        };
        let Some(branch_tx) = load_transcript(conn, &branch.id, &mut budget)? else {
            return Ok(if budget.exhausted {
                DedupSet {
                    exhausted: true,
                    ..DedupSet::default()
                }
            } else {
                DedupSet::default()
            });
        };
        let Some(source) = load_transcript(conn, &source_id, &mut budget)? else {
            return Ok(if budget.exhausted {
                DedupSet {
                    exhausted: true,
                    ..DedupSet::default()
                }
            } else {
                DedupSet::default()
            });
        };
        if let Some(prefix) = shared_prefix(&source, &branch_tx) {
            for message in branch_tx.messages.iter().take(prefix) {
                result.hidden_messages.insert(message.id.clone());
                result.hidden_parts.extend(message.part_ids.iter().cloned());
            }
            if prefix == branch_tx.messages.len() {
                result.hidden_sessions.insert(branch.id.clone());
            }
        }
    }
    Ok(result)
}

fn session_meta(row: &rusqlite::Row<'_>) -> Result<SessionMeta, String> {
    Ok(SessionMeta {
        id: row.get(0).map_err(|e| e.to_string())?,
        directory: row
            .get::<_, Option<String>>(1)
            .map_err(|e| e.to_string())?
            .unwrap_or_default(),
        project_id: row
            .get::<_, Option<String>>(2)
            .map_err(|e| e.to_string())?
            .unwrap_or_default(),
        created: row.get(3).map_err(|e| e.to_string())?,
    })
}

enum CandidateDiscovery {
    None,
    One(String),
    Multiple,
}

fn only_eligible_candidate(
    conn: &Connection,
    branch: &SessionMeta,
    budget: &mut Budget,
) -> Result<CandidateDiscovery, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id FROM session
             WHERE id != ?1 AND directory = ?2 AND project_id = ?3 AND time_updated < ?4
             ORDER BY time_created, id
             LIMIT 2",
        )
        .map_err(|e| e.to_string())?;
    let mut candidates = stmt
        .query(rusqlite::params![
            branch.id,
            branch.directory,
            branch.project_id,
            branch.created
        ])
        .map_err(|e| e.to_string())?;
    let Some(candidate) = candidates.next().map_err(|e| e.to_string())? else {
        return Ok(CandidateDiscovery::None);
    };
    if !budget.spend_candidate() {
        return Ok(CandidateDiscovery::Multiple);
    }
    let candidate_id: String = candidate.get(0).map_err(|e| e.to_string())?;
    if candidates.next().map_err(|e| e.to_string())?.is_some() {
        if !budget.spend_candidate() {
            budget.exhausted = true;
        }
        return Ok(CandidateDiscovery::Multiple);
    }
    Ok(CandidateDiscovery::One(candidate_id))
}

fn load_transcript(
    conn: &Connection,
    session_id: &str,
    budget: &mut Budget,
) -> Result<Option<Transcript>, String> {
    let invalid_part_reference: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM part p LEFT JOIN message m ON m.id = p.message_id WHERE p.session_id = ? AND (m.id IS NULL OR m.session_id != p.session_id))",
        [session_id],
        |row| row.get(0),
    ).map_err(|e| e.to_string())?;
    if invalid_part_reference {
        return Ok(None);
    }
    let mut stmt = conn
        .prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([session_id]).map_err(|e| e.to_string())?;

    let mut messages = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        if !budget.spend_row() {
            return Ok(None);
        }
        let message_id: String = row.get(0).map_err(|e| e.to_string())?;
        let raw: String = row.get(1).map_err(|e| e.to_string())?;
        let data: Value = match serde_json::from_str(&raw) {
            Ok(data) => data,
            Err(_) => return Ok(None),
        };
        let role = match data.get("role").and_then(Value::as_str) {
            Some(role) => role.to_string(),
            None => return Ok(None),
        };

        let mut part_stmt = conn
            .prepare("SELECT id, session_id, data FROM part WHERE message_id = ? ORDER BY time_created, id")
            .map_err(|e| e.to_string())?;
        let mut parts = part_stmt.query([&message_id]).map_err(|e| e.to_string())?;
        let mut part_ids = Vec::new();
        let mut part_digests = Vec::new();
        while let Some(part) = parts.next().map_err(|e| e.to_string())? {
            if !budget.spend_row() || !budget.spend_digest() {
                return Ok(None);
            }
            let part_id: String = part.get(0).map_err(|e| e.to_string())?;
            let part_session_id: String = part.get(1).map_err(|e| e.to_string())?;
            let part_raw: String = part.get(2).map_err(|e| e.to_string())?;
            if part_session_id != session_id {
                return Ok(None);
            }
            let part_data: Value = match serde_json::from_str(&part_raw) {
                Ok(data) => data,
                Err(_) => return Ok(None),
            };
            part_ids.push(part_id);
            part_digests.push(digest_json(&part_data));
        }
        if part_ids.is_empty() || !budget.spend_digest() {
            return Ok(None);
        }
        let digest = digest_json(&Value::Array(vec![
            Value::String(role.clone()),
            data,
            Value::Array(
                part_digests
                    .into_iter()
                    .map(|d| Value::String(hex::encode(d)))
                    .collect(),
            ),
        ]));
        messages.push(Message {
            id: message_id,
            role,
            digest,
            part_ids,
        });
    }
    Ok(Some(Transcript { messages }))
}

fn shared_prefix(source: &Transcript, branch: &Transcript) -> Option<usize> {
    if source.messages.len() > branch.messages.len() {
        return None;
    }
    let length = source
        .messages
        .iter()
        .zip(&branch.messages)
        .take_while(|(source, branch)| source.digest == branch.digest)
        .count();
    let shared = &branch.messages[..length];
    let parts = shared.iter().map(|m| m.part_ids.len()).sum::<usize>();
    let user = shared.iter().any(|m| m.role == "user");
    let non_user = shared.iter().any(|m| m.role != "user");
    (length >= 2 && parts >= 3 && user && non_user).then_some(length)
}

fn digest_json(value: &Value) -> [u8; 32] {
    let encoded = serde_json::to_vec(&canonical(value)).unwrap_or_default();
    Sha256::digest(encoded).into()
}

fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, value)| (key.clone(), canonical(value)))
                .collect::<BTreeMap<_, _>>()
                .into_iter()
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.iter().map(canonical).collect()),
        _ => value.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::OnceLock;

    fn cache_test_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn schema(conn: &Connection) {
        conn.execute_batch(
            "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, project_id TEXT, time_created INTEGER, time_updated INTEGER);
             CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER);
             CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, data TEXT, time_created INTEGER);",
        )
        .unwrap();
    }

    fn insert_session(conn: &Connection, id: &str, created: i64, updated: i64) {
        conn.execute(
            "INSERT INTO session VALUES (?1, '/p', 'p', ?2, ?3)",
            rusqlite::params![id, created, updated],
        )
        .unwrap();
    }

    fn insert_message(conn: &Connection, id: &str, session: &str, role: &str, time: i64) {
        conn.execute(
            "INSERT INTO message VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![
                id,
                session,
                serde_json::json!({"role": role}).to_string(),
                time
            ],
        )
        .unwrap();
    }

    fn insert_part(conn: &Connection, id: &str, session: &str, message: &str, time: i64) {
        conn.execute(
            "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                id,
                session,
                message,
                serde_json::json!({"type": "text", "n": time}).to_string(),
                time
            ],
        )
        .unwrap();
    }

    fn fork_pair(conn: &Connection) {
        insert_session(conn, "source", 1, 10);
        insert_session(conn, "branch", 20, 20);
        for session in ["source", "branch"] {
            insert_message(conn, &format!("{session}-m1"), session, "user", 1);
            insert_message(conn, &format!("{session}-m2"), session, "assistant", 2);
            insert_part(
                conn,
                &format!("{session}-p1"),
                session,
                &format!("{session}-m1"),
                1,
            );
            insert_part(
                conn,
                &format!("{session}-p2"),
                session,
                &format!("{session}-m2"),
                2,
            );
            insert_part(
                conn,
                &format!("{session}-p3"),
                session,
                &format!("{session}-m2"),
                3,
            );
        }
    }

    fn file_connection() -> (Connection, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "opencode-fork-stats-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        (Connection::open(&path).unwrap(), path)
    }

    #[test]
    fn hides_an_exact_fork_clone_branch() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        fork_pair(&conn);

        let result = dedup(&conn).unwrap();

        assert!(result.hidden_sessions.contains("branch"));
        assert_eq!(result.hidden_messages.len(), 2);
        assert_eq!(result.hidden_parts.len(), 3);
        assert!(!result.hidden_sessions.contains("source"));
        assert!(!result.exhausted);
    }

    #[test]
    fn keeps_a_divergent_branch_with_only_its_shared_prefix_hidden() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        fork_pair(&conn);
        insert_message(&conn, "branch-m3", "branch", "assistant", 3);
        insert_part(&conn, "branch-p4", "branch", "branch-m3", 4);

        let result = dedup(&conn).unwrap();

        assert!(!result.hidden_sessions.contains("branch"));
        assert!(result.hidden_messages.contains("branch-m1"));
        assert!(result.hidden_messages.contains("branch-m2"));
        assert!(!result.hidden_messages.contains("branch-m3"));
        assert!(!result.hidden_parts.contains("branch-p4"));
    }

    #[test]
    fn malformed_or_orphan_evidence_fails_closed() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        fork_pair(&conn);
        conn.execute("UPDATE part SET data = '{' WHERE id = 'branch-p1'", [])
            .unwrap();
        assert_eq!(dedup(&conn).unwrap(), DedupSet::default());

        conn.execute(
            "UPDATE part SET data = ? WHERE id = 'branch-p1'",
            [serde_json::json!({"type": "text", "n": 1}).to_string()],
        )
        .unwrap();
        conn.execute(
            "UPDATE part SET message_id = 'missing' WHERE id = 'branch-p1'",
            [],
        )
        .unwrap();
        assert_eq!(dedup(&conn).unwrap(), DedupSet::default());
    }

    #[test]
    fn multiple_candidates_fail_closed() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        fork_pair(&conn);
        insert_session(&conn, "source-two", 2, 11);
        for (message, role, time) in [("m1", "user", 1), ("m2", "assistant", 2)] {
            insert_message(
                &conn,
                &format!("source-two-{message}"),
                "source-two",
                role,
                time,
            );
        }
        insert_part(&conn, "source-two-p1", "source-two", "source-two-m1", 1);
        insert_part(&conn, "source-two-p2", "source-two", "source-two-m2", 2);
        insert_part(&conn, "source-two-p3", "source-two", "source-two-m2", 3);
        assert_eq!(dedup(&conn).unwrap(), DedupSet::default());
    }

    #[test]
    fn a_matching_and_a_nonmatching_candidate_fail_closed() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        fork_pair(&conn);
        insert_session(&conn, "source-two", 2, 11);
        insert_message(&conn, "source-two-m1", "source-two", "user", 1);
        insert_part(&conn, "source-two-p1", "source-two", "source-two-m1", 1);

        assert_eq!(dedup(&conn).unwrap(), DedupSet::default());
    }

    #[test]
    fn cross_session_part_evidence_fails_closed() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        fork_pair(&conn);
        conn.execute(
            "UPDATE part SET session_id = 'source' WHERE id = 'branch-p1'",
            [],
        )
        .unwrap();

        assert_eq!(dedup(&conn).unwrap(), DedupSet::default());
    }

    #[test]
    fn max_digests_exhaustion_fails_closed() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        insert_session(&conn, "session", 1, 1);
        insert_message(&conn, "message", "session", "user", 1);
        insert_part(&conn, "part", "session", "message", 1);
        let mut budget = Budget {
            candidates: 0,
            rows: 0,
            digests: MAX_DIGESTS,
            exhausted: false,
        };

        assert!(load_transcript(&conn, "session", &mut budget)
            .unwrap()
            .is_none());
        assert!(budget.exhausted);
    }

    #[test]
    fn exhausted_budget_returns_no_partial_attribution() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        fork_pair(&conn);
        for index in 0..MAX_ROWS {
            insert_message(
                &conn,
                &format!("extra-{index}"),
                "branch",
                "assistant",
                100 + index as i64,
            );
            insert_part(
                &conn,
                &format!("extra-part-{index}"),
                "branch",
                &format!("extra-{index}"),
                100 + index as i64,
            );
        }
        let result = dedup(&conn).unwrap();
        assert!(result.exhausted);
        assert!(result.hidden_sessions.is_empty());
        assert!(result.hidden_messages.is_empty());
        assert!(result.hidden_parts.is_empty());
    }

    #[test]
    fn cache_returns_a_snapshot_until_invalidated() {
        let _lock = cache_test_lock().lock().unwrap();
        let (conn, path) = file_connection();
        schema(&conn);
        fork_pair(&conn);
        invalidate_cache();
        let first = dedup(&conn).unwrap();
        conn.execute("DELETE FROM part WHERE id = 'branch-p1'", [])
            .unwrap();
        assert_eq!(dedup(&conn).unwrap(), first);
        invalidate_cache();
        assert_eq!(dedup(&conn).unwrap(), DedupSet::default());
        drop(conn);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn cache_entry_expires_after_five_seconds() {
        let _lock = cache_test_lock().lock().unwrap();
        let (conn, path) = file_connection();
        schema(&conn);
        fork_pair(&conn);
        let first = dedup(&conn).unwrap();
        conn.execute("DELETE FROM part WHERE id = 'branch-p1'", [])
            .unwrap();
        let cache_path = std::path::Path::new(conn.path().unwrap())
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let cache_generation = generation().load(std::sync::atomic::Ordering::Acquire);
        if let Ok(mut entry) = cache().lock() {
            entry
                .get_mut(&(cache_path, None, cache_generation))
                .unwrap()
                .created_at = Instant::now() - Duration::from_secs(6);
        }
        assert_ne!(dedup(&conn).unwrap(), first);
        drop(conn);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn keeps_everything_when_no_temporal_separation_exists() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        fork_pair(&conn);
        conn.execute(
            "UPDATE session SET time_updated = 30 WHERE id = 'source'",
            [],
        )
        .unwrap();

        let result = dedup(&conn).unwrap();

        assert!(result.hidden_sessions.is_empty());
        assert!(result.hidden_messages.is_empty());
        assert!(result.hidden_parts.is_empty());
    }

    #[test]
    fn window_only_evaluates_branches_created_inside_the_range() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        fork_pair(&conn);

        let inside = dedup_for_window(&conn, 15, 30).unwrap();
        assert!(inside.hidden_sessions.contains("branch"));
        assert_eq!(inside.hidden_parts.len(), 3);

        let outside = dedup_for_window(&conn, 25, 40).unwrap();
        assert!(outside.hidden_sessions.is_empty());
        assert!(outside.hidden_parts.is_empty());
    }
}
