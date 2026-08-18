use rusqlite::Connection;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_CANDIDATES: usize = 256;
pub const MAX_ROWS: usize = 50_000;
pub const MAX_DIGESTS: usize = 50_000;

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
}

impl Budget {
    fn spend_candidate(&mut self) -> bool {
        self.candidates += 1;
        self.candidates <= MAX_CANDIDATES
    }

    fn spend_row(&mut self) -> bool {
        self.rows += 1;
        self.rows <= MAX_ROWS
    }

    fn spend_digest(&mut self) -> bool {
        self.digests += 1;
        self.digests <= MAX_DIGESTS
    }
}

#[derive(Debug, Clone)]
struct SessionMeta {
    id: String,
    directory: String,
    project_id: String,
    created: i64,
    updated: i64,
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
    let mut budget = Budget { candidates: 0, rows: 0, digests: 0 };
    let metas = load_metas(conn)?;
    let mut result = DedupSet::default();

    for branch in &metas {
        if branch.directory.is_empty() || branch.project_id.is_empty() {
            continue;
        }
        let candidates = metas
            .iter()
            .filter(|c| {
                c.id != branch.id
                    && c.directory == branch.directory
                    && c.project_id == branch.project_id
                    && c.updated < branch.created
            })
            .map(|c| c.id.clone())
            .collect::<Vec<_>>();
        if candidates.is_empty() {
            continue;
        }
        let Some(branch_tx) = load_transcript(conn, &branch.id, &mut budget)? else {
            return Ok(DedupSet::default());
        };
        let mut prefixes = Vec::new();
        for source_id in candidates {
            if !budget.spend_candidate() {
                return Ok(DedupSet { exhausted: true, ..DedupSet::default() });
            }
            let Some(source) = load_transcript(conn, &source_id, &mut budget)? else {
                return Ok(DedupSet::default());
            };
            if let Some(prefix) = shared_prefix(&source, &branch_tx) {
                prefixes.push(prefix);
            }
        }
        if prefixes.len() == 1 {
            let prefix = prefixes[0];
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

fn load_metas(conn: &Connection) -> Result<Vec<SessionMeta>, String> {
    let mut stmt = conn
        .prepare("SELECT id, directory, project_id, time_created, time_updated FROM session ORDER BY time_created, id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(SessionMeta {
                id: row.get(0)?,
                directory: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                project_id: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                created: row.get(3)?,
                updated: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

fn load_transcript(
    conn: &Connection,
    session_id: &str,
    budget: &mut Budget,
) -> Result<Option<Transcript>, String> {
    let mut stmt = conn
        .prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([session_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut messages = Vec::with_capacity(rows.len());
    for (message_id, raw) in rows {
        if !budget.spend_row() {
            return Ok(None);
        }
        let data: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        let role = match data.get("role").and_then(Value::as_str) {
            Some(role) => role.to_string(),
            None => return Ok(None),
        };

        let mut part_stmt = conn
            .prepare("SELECT id, session_id, data FROM part WHERE message_id = ? ORDER BY time_created, id")
            .map_err(|e| e.to_string())?;
        let parts = part_stmt
            .query_map([&message_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

        if parts.is_empty() {
            return Ok(None);
        }
        let mut part_ids = Vec::with_capacity(parts.len());
        let mut part_digests = Vec::with_capacity(parts.len());
        for (part_id, part_session_id, part_raw) in parts {
            if part_session_id != session_id || !budget.spend_row() || !budget.spend_digest() {
                return Ok(None);
            }
            let part_data: Value = serde_json::from_str(&part_raw).map_err(|e| e.to_string())?;
            part_ids.push(part_id);
            part_digests.push(digest_json(&part_data));
        }
        if !budget.spend_digest() {
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
        messages.push(Message { id: message_id, role, digest, part_ids });
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
            rusqlite::params![id, session, serde_json::json!({"role": role}).to_string(), time],
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
            insert_part(conn, &format!("{session}-p1"), session, &format!("{session}-m1"), 1);
            insert_part(conn, &format!("{session}-p2"), session, &format!("{session}-m2"), 2);
            insert_part(conn, &format!("{session}-p3"), session, &format!("{session}-m2"), 3);
        }
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
    fn keeps_everything_when_no_temporal_separation_exists() {
        let conn = Connection::open_in_memory().unwrap();
        schema(&conn);
        fork_pair(&conn);
        conn.execute("UPDATE session SET time_updated = 30 WHERE id = 'source'", [])
            .unwrap();

        let result = dedup(&conn).unwrap();

        assert!(result.hidden_sessions.is_empty());
        assert!(result.hidden_messages.is_empty());
        assert!(result.hidden_parts.is_empty());
    }
}
