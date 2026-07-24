use crate::crypto;
use crate::db::connection::ConnectionConfig;
use crate::db::container::{gen_id, Container, ContainerKind, LegacyConnection};
use crate::error::{AppError, Result};
use rusqlite::{params, Connection};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// A logged or saved query. `name` is NULL for auto-logged history entries and
/// set for user-named "snippets". Both live in the same `queries` table so the
/// history panel can show them in one list (named ones bubbled up / starred).
pub struct QueryRow {
    pub id: String,
    pub name: Option<String>,
    pub sql: String,
    pub conn_id: Option<String>,
    pub db: Option<String>,
    pub created: i64,
}

/// SQLite-backed persistence for connection configs and (later) history.
/// Single file under XDG_CONFIG_HOME/chatquery/app.db.
///
/// Connection records are stored **encrypted** (ADR-004): the whole JSON
/// blob is AES-GCM encrypted with a key kept separately in `key` (0600).
/// On load we try to decrypt; if that fails we fall back to parsing the
/// value as plaintext JSON, so pre-encryption databases still load (they get
/// re-encrypted on the next `upsert`).
pub struct Storage {
    conn: Connection,
    key: [u8; 32],
}

impl Storage {
    pub fn open() -> Result<Self> {
        let dir = config_dir();
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("app.db");
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS connections (
                id   TEXT PRIMARY KEY,
                data TEXT NOT NULL
            );",
        )?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS containers (
                id     TEXT PRIMARY KEY,
                kind   TEXT NOT NULL,
                name   TEXT NOT NULL,
                parent TEXT,
                ord    INTEGER NOT NULL DEFAULT 0
            );",
        )?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS queries (
                id      TEXT PRIMARY KEY,
                name    TEXT,
                sql     TEXT NOT NULL,
                conn_id TEXT,
                db      TEXT,
                created INTEGER NOT NULL
            );",
        )?;
        let key = crypto::load_key()?;
        Ok(Self { conn, key })
    }

    pub fn load_connections(&self) -> Result<Vec<ConnectionConfig>> {
        let mut stmt = self.conn.prepare("SELECT data FROM connections")?;
        let mut rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        let mut legacy: Vec<ConnectionConfig> = Vec::new();
        while let Some(row) = rows.next() {
            let data = row?;
            let (json, is_legacy) = match crypto::decrypt(&data, &self.key) {
                Ok(json) => (json, false),
                // Legacy plaintext record (pre-encryption) — load as-is for now.
                Err(_) => (data, true),
            };
            let cfg: ConnectionConfig =
                serde_json::from_str(&json).map_err(|e| AppError::Msg(e.to_string()))?;
            if is_legacy {
                legacy.push(cfg.clone());
            }
            out.push(cfg);
        }
        // Re-encrypt any legacy plaintext records so nothing stays plaintext at rest.
        for cfg in legacy {
            self.upsert_connection(&cfg)?;
        }
        Ok(out)
    }

    pub fn upsert_connection(&self, cfg: &ConnectionConfig) -> Result<()> {
        let json = serde_json::to_string(cfg).map_err(|e| AppError::Msg(e.to_string()))?;
        let enc = crypto::encrypt(&json, &self.key)?;
        self.conn.execute(
            "INSERT INTO connections (id, data) VALUES (?1, ?2)
             ON CONFLICT(id) DO UPDATE SET data = ?2",
            params![cfg.id, enc],
        )?;
        Ok(())
    }

    pub fn delete_connection(&self, id: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM connections WHERE id = ?1", params![id])?;
        Ok(())
    }

    // --- Containers (environments / groups) -------------------------------

    /// Load all tree containers (environments + groups), in storage order.
    pub fn load_containers(&self) -> Result<Vec<Container>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, kind, name, parent, ord FROM containers")?;
        let rows = stmt.query_map([], |r| {
            Ok(Container {
                id: r.get(0)?,
                kind: match r.get::<_, String>(1)?.as_str() {
                    "group" => ContainerKind::Group,
                    _ => ContainerKind::Env,
                },
                name: r.get(2)?,
                parent: r.get(3)?,
                ord: r.get(4)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Create a container and return its new id.
    pub fn create_container(
        &self,
        kind: ContainerKind,
        name: &str,
        parent: Option<&str>,
    ) -> Result<String> {
        let id = gen_id(if kind == ContainerKind::Env { "e" } else { "g" });
        let kind_str = match kind {
            ContainerKind::Env => "env",
            ContainerKind::Group => "group",
        };
        self.conn.execute(
            "INSERT INTO containers (id, kind, name, parent, ord) VALUES (?1, ?2, ?3, ?4, 0)",
            params![id, kind_str, name, parent],
        )?;
        Ok(id)
    }

    pub fn rename_container(&self, id: &str, name: &str) -> Result<()> {
        self.conn
            .execute("UPDATE containers SET name = ?1 WHERE id = ?2", params![name, id])?;
        Ok(())
    }

    pub fn delete_container(&self, id: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM containers WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Load connections as the legacy shape (with env/group strings) so the
    /// store can migrate them onto first-class containers.
    pub fn load_connection_legacy(&self) -> Result<Vec<LegacyConnection>> {
        let mut stmt = self.conn.prepare("SELECT data FROM connections")?;
        let mut rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        while let Some(row) = rows.next() {
            let data = row?;
            // Legacy records are plaintext; current records are encrypted. The
            // migration runs on the decrypted JSON regardless of source.
            let json = match crypto::decrypt(&data, &self.key) {
                Ok(json) => json,
                Err(_) => data,
            };
            let legacy: LegacyConnection =
                serde_json::from_str(&json).map_err(|e| AppError::Msg(e.to_string()))?;
            out.push(legacy);
        }
        Ok(out)
    }

    // --- Query history / saved snippets ----------------------------------

    /// Auto-log an executed query (history). `name` stays NULL; the entry can
    /// later be promoted to a named snippet via `save_query`.
    pub fn log_query(&self, conn_id: Option<&str>, db: Option<&str>, sql: &str) -> Result<()> {
        let id = gen_id("q");
        self.conn.execute(
            "INSERT INTO queries (id, name, sql, conn_id, db, created)
             VALUES (?1, NULL, ?2, ?3, ?4, ?5)",
            params![id, sql, conn_id, db, now_secs()],
        )?;
        Ok(())
    }

    /// Return recent queries (most recent first), capped to the last 200.
    pub fn list_queries(&self) -> Result<Vec<QueryRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, sql, conn_id, db, created FROM queries
             ORDER BY created DESC LIMIT 200",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(QueryRow {
                id: r.get(0)?,
                name: r.get(1)?,
                sql: r.get(2)?,
                conn_id: r.get(3)?,
                db: r.get(4)?,
                created: r.get(5)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Upsert a named snippet. When `id` is None, a new named row is inserted;
    /// when `id` is Some, that row's `name` is set (promoting a history entry).
    /// Returns the affected row id.
    pub fn save_query(
        &self,
        id: Option<&str>,
        name: &str,
        sql: &str,
        conn_id: Option<&str>,
        db: Option<&str>,
    ) -> Result<String> {
        let row_id = match id {
            Some(existing) => {
                self.conn.execute(
                    "UPDATE queries SET name = ?1 WHERE id = ?2",
                    params![name, existing],
                )?;
                existing.to_string()
            }
            None => {
                let new_id = gen_id("q");
                self.conn.execute(
                    "INSERT INTO queries (id, name, sql, conn_id, db, created)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![new_id, name, sql, conn_id, db, now_secs()],
                )?;
                new_id
            }
        };
        Ok(row_id)
    }

    pub fn delete_query(&self, id: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM queries WHERE id = ?1", params![id])?;
        Ok(())
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn config_dir() -> PathBuf {
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        return PathBuf::from(xdg).join("chatquery");
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".config").join("chatquery")
}
