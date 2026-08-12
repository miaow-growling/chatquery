use crate::crypto;
use crate::db::connection::{ConnectionConfig, DbType};
use crate::db::container::{gen_id, Container, ContainerKind, LegacyConnection};
use crate::error::{AppError, Result};
use crate::model::{ConversationSummary, NewChatMessage, StoredChatMessage};
use rusqlite::{params, Connection, OptionalExtension};
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

/// A knowledge-base document (plain text / Markdown). Stored in plaintext
/// (same sensitivity tier as saved queries); encrypt later via `crypto` if needed.
pub struct KbDoc {
    pub id: String,
    pub name: String,
    pub content: String,
    pub created: i64,
    pub updated: i64,
}

/// A single binding target: a connection (`conn_id`) and optionally a specific
/// database. `database = None` means the whole connection.
pub struct KbBinding {
    pub conn_id: String,
    pub database: Option<String>,
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
        init_schema(&conn)?;
        // #0: connections are encrypted with K (the configurable key), which
        // degenerates to the KEK when no user key is set — so a fresh install
        // behaves exactly as before. See crypto::load_encryption_key.
        let key = crypto::load_encryption_key()?;
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
                // Fall back to the KEK: records encrypted before the K model
                // (or a freshly configured K equal to the KEK). If even that
                // fails, the store was opened with the wrong key — say so
                // clearly instead of silently dropping the row.
                Err(_) => match crypto::load_key()
                    .ok()
                    .and_then(|kek| crypto::decrypt(&data, &kek).ok())
                {
                    Some(json) => (json, true),
                    None => {
                        return Err(AppError::Msg(
                            "无法解密连接数据：密钥不匹配。若换了机器/密钥，请在系统配置填入导出时使用的密钥后重试"
                                .into(),
                        ))
                    }
                },
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

    /// Re-encrypt every connection record from `old` to `new` inside a single
    /// SQLite transaction. Used when the user configures or rotates the
    /// configurable key K (#0). Old records remain decryptable by `old` until
    /// the transaction commits, so a crash mid-way leaves a consistent (if
    /// half-migrated) store that the next open can still finish reading.
    pub fn reencrypt_all(&mut self, old: &[u8; 32], new: &[u8; 32]) -> Result<()> {
        let tx = self.conn.transaction()?;
        let mut items: Vec<(String, String)> = Vec::new();
        {
            let mut stmt = tx.prepare("SELECT id, data FROM connections")?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            for row in rows {
                items.push(row?);
            }
        } // stmt/rows dropped — tx is free for writes
        for (id, data) in items {
            let json = crypto::decrypt(&data, old)?;
            let enc = crypto::encrypt(&json, new)?;
            tx.execute(
                "UPDATE connections SET data = ?2 WHERE id = ?1",
                params![id, enc],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Configure or rotate the connection key to K derived from `field` (#0).
    /// Writes keycfg.json, then re-encrypts all stored connections to the new
    /// K. If the derived K equals the current key (already configured with the
    /// same field), we just ensure keycfg exists and skip the re-encryption.
    pub fn rotate_key(&mut self, field: &str) -> Result<()> {
        let old = self.key;
        let new = crypto::save_key_config(field)?;
        if old == new {
            return Ok(());
        }
        self.reencrypt_all(&old, &new)?;
        self.key = new;
        Ok(())
    }

    // --- Containers (environments / groups) -------------------------------

    /// Load all tree containers (environments + groups), in storage order.
    pub fn load_containers(&self) -> Result<Vec<Container>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, kind, name, parent, ord, db_type FROM containers")?;
        let rows = stmt.query_map([], |r| {
            let raw: Option<String> = r.get(5)?;
            let db_type = match raw.as_deref() {
                Some("redis") => Some(DbType::Redis),
                Some("mysql") => Some(DbType::Mysql),
                _ => None,
            };
            Ok(Container {
                id: r.get(0)?,
                kind: match r.get::<_, String>(1)?.as_str() {
                    "group" => ContainerKind::Group,
                    _ => ContainerKind::Env,
                },
                name: r.get(2)?,
                db_type,
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
        db_type: Option<DbType>,
    ) -> Result<String> {
        let id = gen_id(if kind == ContainerKind::Env { "e" } else { "g" });
        let kind_str = match kind {
            ContainerKind::Env => "env",
            ContainerKind::Group => "group",
        };
        let db_type_str: Option<&str> = match db_type {
            Some(DbType::Mysql) => Some("mysql"),
            Some(DbType::Redis) => Some("redis"),
            None => None,
        };
        self.conn.execute(
            "INSERT INTO containers (id, kind, name, parent, ord, db_type) VALUES (?1, ?2, ?3, ?4, 0, ?5)",
            params![id, kind_str, name, parent, db_type_str],
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
            // Legacy records may be plaintext or KEK-encrypted; current records
            // are encrypted with K. Try K, then KEK (pre-migration). If neither
            // opens the blob, the store was opened with the wrong key.
            let json = match crypto::decrypt(&data, &self.key) {
                Ok(json) => json,
                Err(_) => crypto::load_key()
                    .ok()
                    .and_then(|kek| crypto::decrypt(&data, &kek).ok())
                    .ok_or_else(|| {
                        AppError::Msg(
                            "无法解密连接数据：密钥不匹配。请在系统配置填入正确的加密密钥".into(),
                        )
                    })?,
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

    // --- Knowledge base (ADR-AI-6) ---------------------------------------

    pub fn add_kb_doc(&self, name: &str, content: &str) -> Result<String> {
        let id = gen_id("kb");
        let now = now_secs();
        self.conn.execute(
            "INSERT INTO kb_docs (id, name, content, created, updated)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, name, content, now, now],
        )?;
        Ok(id)
    }

    pub fn update_kb_doc(&self, id: &str, name: &str, content: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE kb_docs SET name = ?1, content = ?2, updated = ?3 WHERE id = ?4",
            params![name, content, now_secs(), id],
        )?;
        Ok(())
    }

    pub fn list_kb_docs(&self) -> Result<Vec<KbDoc>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, content, created, updated FROM kb_docs ORDER BY updated DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(KbDoc {
                id: r.get(0)?,
                name: r.get(1)?,
                content: r.get(2)?,
                created: r.get(3)?,
                updated: r.get(4)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn delete_kb_doc(&mut self, id: &str) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM kb_bindings WHERE kb_id = ?1", params![id])?;
        tx.execute("DELETE FROM kb_docs WHERE id = ?1", params![id])?;
        tx.commit()?;
        Ok(())
    }

    /// Replace all bindings for a doc (idempotent: clears then inserts).
    pub fn set_kb_bindings(
        &mut self,
        kb_id: &str,
        bindings: &[(String, Option<String>)],
    ) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM kb_bindings WHERE kb_id = ?1", params![kb_id])?;
        for (conn_id, database) in bindings {
            tx.execute(
                "INSERT OR IGNORE INTO kb_bindings (kb_id, conn_id, database) VALUES (?1, ?2, ?3)",
                params![kb_id, conn_id, database],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn get_kb_bindings(&self, kb_id: &str) -> Result<Vec<KbBinding>> {
        let mut stmt = self
            .conn
            .prepare("SELECT conn_id, database FROM kb_bindings WHERE kb_id = ?1")?;
        let rows = stmt.query_map(params![kb_id], |r| {
            Ok(KbBinding {
                conn_id: r.get(0)?,
                database: r.get(1)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Docs bound to (conn_id, whole-connection) OR (conn_id, specific db).
    /// This is the set the AI should see when operating in that context.
    pub fn get_injected_kb_docs(
        &self,
        conn_id: &str,
        db: Option<&str>,
    ) -> Result<Vec<KbDoc>> {
        let mut stmt = self.conn.prepare(
            "SELECT DISTINCT d.id, d.name, d.content, d.created, d.updated
             FROM kb_docs d
             JOIN kb_bindings b ON b.kb_id = d.id
             WHERE (b.conn_id = ?1 AND b.database IS NULL)
                OR (b.conn_id = ?1 AND b.database = ?2)
             ORDER BY d.updated DESC",
        )?;
        let rows = stmt.query_map(params![conn_id, db], |r| {
            Ok(KbDoc {
                id: r.get(0)?,
                name: r.get(1)?,
                content: r.get(2)?,
                created: r.get(3)?,
                updated: r.get(4)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Record a write-guardrail decision (ADR-AI-1 决策3: audit trail). A
    /// `None` db means the statement targeted the whole connection.
    pub fn add_audit(
        &self,
        conn_id: &str,
        conn_name: &str,
        db: Option<&str>,
        sql: &str,
        decision: &str,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO audit_log (id, ts, conn_id, conn_name, db, sql, decision)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![gen_id("aud"), now_secs(), conn_id, conn_name, db, sql, decision],
        )?;
        Ok(())
    }

    /// Most-recent-first audit entries, capped at `limit`. Tuple fields:
    /// (conn_name, db, sql, decision, ts). `db` is `None` for whole-connection.
    pub fn list_audits(
        &self,
        limit: i64,
    ) -> Result<Vec<(String, Option<String>, String, String, i64)>> {
        let mut stmt = self.conn.prepare(
            "SELECT conn_name, db, sql, decision, ts FROM audit_log ORDER BY ts DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    // --- Conversations / chat messages (docs/chat-conversation-design.md) ---

    /// All conversations, most recently updated first (pinned float to the
    /// top), capped at 200. `conn_name` resolves via the in-memory connection
    /// list; if the store can't decrypt connections (wrong key) it degrades to
    /// `None` labels rather than failing the whole chat list.
    pub fn list_conversations(&self) -> Result<Vec<ConversationSummary>> {
        let mut stmt = self.conn.prepare(
            "SELECT c.id, c.title, c.conn_id, c.created, c.updated, c.pinned,
                    COUNT(m.id) AS msg_count,
                    (SELECT content FROM chat_messages m2
                      WHERE m2.conv_id = c.id ORDER BY m2.seq DESC LIMIT 1) AS last_content
             FROM conversations c
             LEFT JOIN chat_messages m ON m.conv_id = c.id
             GROUP BY c.id
             ORDER BY c.pinned DESC, c.updated DESC
             LIMIT 200",
        )?;
        let rows = stmt.query_map([], |r| {
            let conn_id: Option<String> = r.get(2)?;
            let last_content: Option<String> = r.get(7)?;
            Ok(ConversationSummary {
                id: r.get(0)?,
                title: r.get(1)?,
                conn_id: conn_id.clone(),
                conn_name: None, // filled below
                created: r.get(3)?,
                updated: r.get(4)?,
                pinned: r.get::<_, i64>(5)? != 0,
                last_preview: preview_of(last_content.as_deref()),
                msg_count: r.get(6)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        let names = self.conn_id_to_name();
        for c in &mut out {
            c.conn_name = c.conn_id.as_deref().and_then(|id| names.get(id).cloned());
        }
        Ok(out)
    }

    /// Create a conversation bound to `conn_id` (None = generic) and return
    /// its id. `title` defaults to "新会话".
    pub fn create_conversation(&self, conn_id: Option<&str>, title: Option<&str>) -> Result<String> {
        let id = gen_id("s");
        let now = now_secs();
        self.conn.execute(
            "INSERT INTO conversations (id, title, conn_id, created, updated, pinned)
             VALUES (?1, ?2, ?3, ?4, ?5, 0)",
            params![id, title.unwrap_or("新会话"), conn_id, now, now],
        )?;
        Ok(id)
    }

    pub fn rename_conversation(&self, id: &str, title: &str) -> Result<()> {
        let n = self.conn.execute(
            "UPDATE conversations SET title = ?1, updated = ?2 WHERE id = ?3",
            params![title, now_secs(), id],
        )?;
        if n == 0 {
            return Err(AppError::Msg(format!("会话不存在：{id}")));
        }
        Ok(())
    }

    /// Delete a conversation and cascade-delete its messages in one transaction.
    pub fn delete_conversation(&mut self, id: &str) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM chat_messages WHERE conv_id = ?1", params![id])?;
        let n = tx.execute("DELETE FROM conversations WHERE id = ?1", params![id])?;
        tx.commit()?;
        if n == 0 {
            return Err(AppError::Msg(format!("会话不存在：{id}")));
        }
        Ok(())
    }

    /// One conversation's info + its messages (ascending `seq`), with
    /// `offset`/`limit` pagination (defaults in the command layer: 0 / 100).
    /// Returns `Err` when the conversation id is unknown.
    pub fn get_conversation(
        &self,
        id: &str,
        offset: i64,
        limit: i64,
    ) -> Result<(ConversationSummary, Vec<StoredChatMessage>)> {
        let info = self
            .conversation_summary(id)?
            .ok_or_else(|| AppError::Msg(format!("会话不存在：{id}")))?;
        let mut stmt = self.conn.prepare(
            "SELECT id, role, content, meta, ts FROM chat_messages
             WHERE conv_id = ?1 ORDER BY seq ASC LIMIT ?2 OFFSET ?3",
        )?;
        let rows = stmt.query_map(params![id, limit, offset], |r| {
            let meta: Option<String> = r.get(3)?;
            Ok(StoredChatMessage {
                id: r.get(0)?,
                role: r.get(1)?,
                content: r.get(2)?,
                meta: meta
                    .and_then(|m| serde_json::from_str(&m).ok()),
                ts: r.get(4)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok((info, out))
    }

    /// Append messages to a conversation inside one transaction: assigns
    /// `seq` continuing from the current max, generates ids, bumps `updated`.
    /// Validates the role whitelist and content length. No-op on empty input.
    pub fn append_chat_messages(
        &mut self,
        conv_id: &str,
        messages: &[NewChatMessage],
    ) -> Result<()> {
        const ROLE_WHITELIST: [&str; 6] = ["user", "assistant", "tool", "system", "plan", "ref"];
        const CONTENT_MAX_CHARS: usize = 200_000;
        if messages.is_empty() {
            return Ok(());
        }
        for m in messages {
            if !ROLE_WHITELIST.contains(&m.role.as_str()) {
                return Err(AppError::Msg(format!("非法消息角色：{}", m.role)));
            }
            if m.content.chars().count() > CONTENT_MAX_CHARS {
                return Err(AppError::Msg("消息内容超出长度上限".into()));
            }
        }
        let tx = self.conn.transaction()?;
        let exists: i64 = tx.query_row(
            "SELECT COUNT(*) FROM conversations WHERE id = ?1",
            params![conv_id],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Err(AppError::Msg(format!("会话不存在：{conv_id}")));
        }
        let max_seq: i64 = tx.query_row(
            "SELECT COALESCE(MAX(seq), 0) FROM chat_messages WHERE conv_id = ?1",
            params![conv_id],
            |r| r.get(0),
        )?;
        let now = now_secs();
        for (i, m) in messages.iter().enumerate() {
            let meta_json = m.meta.as_ref().map(|v| v.to_string());
            tx.execute(
                "INSERT INTO chat_messages (id, conv_id, seq, role, content, meta, ts)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    gen_id("m"),
                    conv_id,
                    max_seq + i as i64 + 1,
                    m.role,
                    m.content,
                    meta_json,
                    now
                ],
            )?;
        }
        tx.execute(
            "UPDATE conversations SET updated = ?1 WHERE id = ?2",
            params![now, conv_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Single-conversation summary used by `get_conversation`. Returns `None`
    /// Title + the last `n` messages of a conversation (ascending `seq`) —
    /// the window the cross-conversation injector reads (#226). Returns `None`
    /// when the conversation id is unknown.
    pub fn get_recent_conv(
        &self,
        conv_id: &str,
        n: i64,
    ) -> Result<Option<(String, Vec<StoredChatMessage>)>> {
        let title: Option<String> = self
            .conn
            .query_row(
                "SELECT title FROM conversations WHERE id = ?1",
                params![conv_id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(title) = title else { return Ok(None) };
        let mut stmt = self.conn.prepare(
            "SELECT id, role, content, meta, ts FROM (
                SELECT * FROM chat_messages WHERE conv_id = ?1
                ORDER BY seq DESC LIMIT ?2
             ) ORDER BY seq ASC",
        )?;
        let rows = stmt.query_map(params![conv_id, n], |r| {
            let meta: Option<String> = r.get(3)?;
            Ok(StoredChatMessage {
                id: r.get(0)?,
                role: r.get(1)?,
                content: r.get(2)?,
                meta: meta.and_then(|m| serde_json::from_str(&m).ok()),
                ts: r.get(4)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(Some((title, out)))
    }

    /// Single-conversation summary used by `get_conversation`. Returns `None`
    /// when the id is unknown.
    fn conversation_summary(&self, id: &str) -> Result<Option<ConversationSummary>> {
        let mut stmt = self.conn.prepare(
            "SELECT c.id, c.title, c.conn_id, c.created, c.updated, c.pinned,
                    COUNT(m.id) AS msg_count,
                    (SELECT content FROM chat_messages m2
                      WHERE m2.conv_id = c.id ORDER BY m2.seq DESC LIMIT 1) AS last_content
             FROM conversations c
             LEFT JOIN chat_messages m ON m.conv_id = c.id
             WHERE c.id = ?1
             GROUP BY c.id",
        )?;
        let mut rows = stmt.query_map(params![id], |r| {
            let conn_id: Option<String> = r.get(2)?;
            let last_content: Option<String> = r.get(7)?;
            Ok(ConversationSummary {
                id: r.get(0)?,
                title: r.get(1)?,
                conn_id: conn_id.clone(),
                conn_name: None,
                created: r.get(3)?,
                updated: r.get(4)?,
                pinned: r.get::<_, i64>(5)? != 0,
                last_preview: preview_of(last_content.as_deref()),
                msg_count: r.get(6)?,
            })
        })?;
        match rows.next() {
            Some(row) => {
                let mut c = row?;
                let names = self.conn_id_to_name();
                c.conn_name = c.conn_id.as_deref().and_then(|id| names.get(id).cloned());
                Ok(Some(c))
            }
            None => Ok(None),
        }
    }

    /// Best-effort conn_id → name map for list labels. Fails soft (empty map)
    /// only if connection decryption itself fails — a display-only field.
    fn conn_id_to_name(&self) -> std::collections::HashMap<String, String> {
        self.load_connections()
            .ok()
            .into_iter()
            .flatten()
            .map(|c| (c.id.clone(), c.name))
            .collect()
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// First 60 characters of a message, for the conversation-list preview.
fn preview_of(content: Option<&str>) -> String {
    content.unwrap_or_default().chars().take(60).collect()
}

/// Schema bootstrap, extracted from `open()` so tests can build an isolated
/// in-memory store without touching the on-disk DB or the encryption key.
fn init_schema(conn: &Connection) -> Result<()> {
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
    {
        let mut pragma = conn.prepare("PRAGMA table_info(containers)")?;
        let has_db_type: bool = pragma
            .query_map([], |r| r.get::<_, String>(1))?
            .any(|c| c.map(|n| n == "db_type").unwrap_or(false));
        if !has_db_type {
            conn.execute("ALTER TABLE containers ADD COLUMN db_type TEXT", [])?;
        }
    }
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
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS kb_docs (
            id      TEXT PRIMARY KEY,
            name    TEXT NOT NULL,
            content TEXT NOT NULL,
            created INTEGER NOT NULL,
            updated INTEGER NOT NULL
        );",
    )?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS kb_bindings (
            kb_id   TEXT NOT NULL,
            conn_id TEXT NOT NULL,
            database TEXT,
            PRIMARY KEY (kb_id, conn_id, database)
        );",
    )?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS audit_log (
            id        TEXT PRIMARY KEY,
            ts        INTEGER NOT NULL,
            conn_id   TEXT NOT NULL,
            conn_name TEXT NOT NULL,
            db        TEXT,
            sql       TEXT NOT NULL,
            decision  TEXT NOT NULL
        );",
    )?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS conversations (
            id      TEXT PRIMARY KEY,
            title   TEXT NOT NULL,
            conn_id TEXT,
            created INTEGER NOT NULL,
            updated INTEGER NOT NULL,
            pinned  INTEGER NOT NULL DEFAULT 0
        );",
    )?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS chat_messages (
            id      TEXT PRIMARY KEY,
            conv_id TEXT NOT NULL,
            seq     INTEGER NOT NULL,
            role    TEXT NOT NULL,
            content TEXT NOT NULL DEFAULT '',
            meta    TEXT,
            ts      INTEGER NOT NULL
        );",
    )?;
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_msg_conv ON chat_messages(conv_id, seq);",
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// Build an isolated in-memory store with the full schema. Avoids touching
    /// the real on-disk DB / encryption key so kb logic can be unit-tested.
    fn mem_store() -> Storage {
        let conn = Connection::open(":memory:").expect("mem db");
        init_schema(&conn).expect("schema");
        Storage { conn, key: [0u8; 32] }
    }

    fn names(mut docs: Vec<KbDoc>) -> Vec<String> {
        docs.sort_by(|a, b| a.name.cmp(&b.name));
        docs.into_iter().map(|d| d.name).collect()
    }

    #[test]
    fn kb_crud_and_update() {
        let s = mem_store();
        let id1 = s.add_kb_doc("订单说明", "内容A").unwrap();
        let _id2 = s.add_kb_doc("用户说明", "内容B").unwrap();
        assert_eq!(s.list_kb_docs().unwrap().len(), 2);
        s.update_kb_doc(&id1, "订单说明V2", "内容A改").unwrap();
        let got = s.list_kb_docs().unwrap();
        let updated = got.iter().find(|d| d.id == id1).unwrap();
        assert_eq!(updated.name, "订单说明V2");
        assert_eq!(updated.content, "内容A改");
    }

    /// Core accuracy guard: only docs bound to the active connection/db are
    /// injected. A db-specific binding must NOT leak into another db, and a
    /// different connection's docs must never appear.
    #[test]
    fn kb_injection_isolation() {
        let mut s = mem_store();
        let a = s.add_kb_doc("整条连接A", "A").unwrap();
        let b = s.add_kb_doc("库X专用", "B").unwrap();
        let c = s.add_kb_doc("连接B整条", "C").unwrap();
        s.set_kb_bindings(&a, &[("connA".into(), None)]).unwrap();
        s.set_kb_bindings(&b, &[("connA".into(), Some("dbX".into()))]).unwrap();
        s.set_kb_bindings(&c, &[("connB".into(), None)]).unwrap();

        // db=None → only whole-connection bindings, not db-specific ones
        let r = s.get_injected_kb_docs("connA", None).unwrap();
        assert_eq!(names(r), vec!["整条连接A".to_string()]);

        // connA + dbX → whole-connection (A) AND dbX-specific (B)
        let r = s.get_injected_kb_docs("connA", Some("dbX")).unwrap();
        assert_eq!(names(r), vec!["库X专用".to_string(), "整条连接A".to_string()]);

        // connA + dbY → only whole-connection A (no binding for dbY)
        let r = s.get_injected_kb_docs("connA", Some("dbY")).unwrap();
        assert_eq!(names(r), vec!["整条连接A".to_string()]);

        // connB + dbX → its own whole-connection C; must NOT leak connA's dbX doc
        let r = s.get_injected_kb_docs("connB", Some("dbX")).unwrap();
        assert_eq!(names(r), vec!["连接B整条".to_string()]);
    }

    /// One doc bound to both whole-connection and a specific db: DISTINCT
    /// keeps it from appearing twice.
    #[test]
    fn kb_one_to_many_binding() {
        let mut s = mem_store();
        let d = s.add_kb_doc("一对多文档", "D").unwrap();
        s.set_kb_bindings(
            &d,
            &[("connA".into(), None), ("connA".into(), Some("dbX".into()))],
        )
        .unwrap();
        let r = s.get_injected_kb_docs("connA", None).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].name, "一对多文档");
        let r = s.get_injected_kb_docs("connA", Some("dbX")).unwrap();
        assert_eq!(r.len(), 1);
    }

    #[test]
    fn kb_delete_cascades_bindings() {
        let mut s = mem_store();
        let e = s.add_kb_doc("待删", "E").unwrap();
        s.set_kb_bindings(&e, &[("connA".into(), Some("dbX".into()))])
            .unwrap();
        assert_eq!(s.get_kb_bindings(&e).unwrap().len(), 1);
        s.delete_kb_doc(&e).unwrap();
        assert!(s.get_kb_bindings(&e).unwrap().is_empty());
        assert!(s
            .get_injected_kb_docs("connA", Some("dbX"))
            .unwrap()
            .is_empty());
    }

    /// set_kb_bindings replaces the full set, not appends.
    #[test]
    fn kb_set_bindings_replaces() {
        let mut s = mem_store();
        let f = s.add_kb_doc("替换绑定", "F").unwrap();
        s.set_kb_bindings(&f, &[("connA".into(), None)]).unwrap();
        s.set_kb_bindings(&f, &[("connB".into(), None)]).unwrap();
        let bs = s.get_kb_bindings(&f).unwrap();
        assert_eq!(bs.len(), 1);
        assert_eq!(bs[0].conn_id, "connB");
    }

    /// Audit trail persists each guardrail decision and round-trips via list.
    #[test]
    fn audit_roundtrip() {
        let s = mem_store();
        s.add_audit("c1", "demo", Some("mydb"), "DELETE FROM t", "write-approved")
            .unwrap();
        s.add_audit("c1", "demo", None, "DROP TABLE t", "deny").unwrap();
        let rows = s.list_audits(10).unwrap();
        assert_eq!(rows.len(), 2);
        // Both decisions recorded (don't assert order — ts is second-granular).
        let decisions: Vec<&str> = rows.iter().map(|r| r.3.as_str()).collect();
        assert!(decisions.contains(&"deny"));
        assert!(decisions.contains(&"write-approved"));
        // db binding captured: one whole-connection (None), one specific db.
        let dbs: Vec<Option<String>> = rows.iter().map(|r| r.1.clone()).collect();
        assert!(dbs.contains(&None));
        assert!(dbs.contains(&Some("mydb".to_string())));
    }

    // --- Conversation persistence ----------------------------------------

    fn msg(role: &str, content: &str) -> NewChatMessage {
        NewChatMessage {
            role: role.into(),
            content: content.into(),
            meta: None,
        }
    }

    #[test]
    fn conv_crud_and_rename() {
        let s = mem_store();
        let id = s.create_conversation(Some("c1"), None).unwrap();
        let list = s.list_conversations().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].title, "新会话");
        assert_eq!(list[0].conn_id.as_deref(), Some("c1"));
        assert_eq!(list[0].msg_count, 0);
        assert_eq!(list[0].last_preview, "");

        s.rename_conversation(&id, "订单问题排查").unwrap();
        let (info, msgs) = s.get_conversation(&id, 0, 100).unwrap();
        assert_eq!(info.title, "订单问题排查");
        assert!(msgs.is_empty());

        // Unknown conversation is an error, not silent.
        assert!(s.get_conversation("nope", 0, 100).is_err());
        assert!(s.rename_conversation("nope", "x").is_err());
    }

    #[test]
    fn conv_append_seq_order_and_preview() {
        let mut s = mem_store();
        let id = s.create_conversation(None, None).unwrap();
        s.append_chat_messages(
            &id,
            &[msg("user", "第一问"), msg("assistant", "第一答")],
        )
        .unwrap();
        s.append_chat_messages(&id, &[msg("user", "第二问")])
            .unwrap();

        let (info, msgs) = s.get_conversation(&id, 0, 100).unwrap();
        assert_eq!(info.msg_count, 3);
        // Preview = last message, truncated to 60 chars.
        assert_eq!(info.last_preview, "第二问");
        // Seq ascending, roles preserved.
        let roles: Vec<&str> = msgs.iter().map(|m| m.role.as_str()).collect();
        assert_eq!(roles, vec!["user", "assistant", "user"]);
        assert_eq!(msgs[0].content, "第一问");
        assert_eq!(msgs[2].content, "第二问");

        // Pagination works.
        let (_, page) = s.get_conversation(&id, 1, 1).unwrap();
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].content, "第一答");
    }

    #[test]
    fn conv_meta_roundtrip() {
        let mut s = mem_store();
        let id = s.create_conversation(None, None).unwrap();
        s.append_chat_messages(
            &id,
            &[NewChatMessage {
                role: "assistant".into(),
                content: "带用量".into(),
                meta: Some(serde_json::json!({"usage": {"total": 123}})),
            }],
        )
        .unwrap();
        let (_, msgs) = s.get_conversation(&id, 0, 100).unwrap();
        assert_eq!(msgs.len(), 1);
        let meta = msgs[0].meta.as_ref().expect("meta persisted");
        assert_eq!(meta["usage"]["total"], 123);
    }

    #[test]
    fn conv_delete_cascades_messages() {
        let mut s = mem_store();
        let id = s.create_conversation(None, None).unwrap();
        s.append_chat_messages(&id, &[msg("user", "要删的"), msg("assistant", "也删")])
            .unwrap();
        assert_eq!(s.list_conversations().unwrap().len(), 1);
        s.delete_conversation(&id).unwrap();
        assert!(s.list_conversations().unwrap().is_empty());
        // Cascade: messages are gone too (get now errors on unknown conv).
        assert!(s.get_conversation(&id, 0, 100).is_err());
    }

    #[test]
    fn conv_append_validates_input() {
        let mut s = mem_store();
        let id = s.create_conversation(None, None).unwrap();
        // Unknown conversation → error.
        assert!(s.append_chat_messages("nope", &[msg("user", "x")]).is_err());
        // Role outside whitelist → error.
        assert!(
            s.append_chat_messages(&id, &[msg("spam", "x")]).is_err()
        );
        // Nothing was written by the rejected batches.
        assert_eq!(s.get_conversation(&id, 0, 100).unwrap().1.len(), 0);
        // Empty batch is a no-op, not an error.
        s.append_chat_messages(&id, &[]).unwrap();
    }

    #[test]
    fn conv_list_order_by_updated() {
        let mut s = mem_store();
        let a = s.create_conversation(None, None).unwrap();
        let b = s.create_conversation(None, None).unwrap();
        // B gets a message later → B floats above A.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        s.append_chat_messages(&b, &[msg("user", "新活动")]).unwrap();
        let list = s.list_conversations().unwrap();
        assert_eq!(list[0].id, b);
        assert_eq!(list[0].last_preview, "新活动");
        assert_eq!(list[1].id, a);
    }

    /// The injection window reads the TAIL of a conversation, ascending by
    /// seq, and reports the title — the data render_conv_refs needs.
    #[test]
    fn conv_recent_window_is_tail_ascending() {
        let mut s = mem_store();
        let id = s.create_conversation(None, None).unwrap();
        s.append_chat_messages(
            &id,
            &[msg("user", "m1"), msg("assistant", "m2"), msg("user", "m3")],
        )
        .unwrap();
        let (title, msgs) = s.get_recent_conv(&id, 2).unwrap().expect("conv exists");
        assert_eq!(title, "新会话");
        let contents: Vec<&str> = msgs.iter().map(|m| m.content.as_str()).collect();
        assert_eq!(contents, vec!["m2", "m3"]);
        // Unknown conversation → None (not an error).
        assert!(s.get_recent_conv("nope", 2).unwrap().is_none());
    }
}

fn config_dir() -> PathBuf {
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        return PathBuf::from(xdg).join("chatquery");
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".config").join("chatquery")
}
