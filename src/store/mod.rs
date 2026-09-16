use crate::crypto;
use crate::db::connection::{ConnectionConfig, DbType};
use crate::db::container::{gen_id, Container, ContainerKind, LegacyConnection};
use crate::error::{AppError, Result};
use crate::model::{
    AssistantDbBinding, ConversationSummary, DataAssistant, NewChatMessage, StoredChatMessage,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
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

/// 一个查询的版本组：`head` 是该查询最后一次执行的记录（SQL / 连接 / 库），
/// `versions` 是更早的迭代版本，时间倒序。命名片段 / 无组旧数据是单条组
/// （group_id 为 None、versions 为空）。
pub struct QueryGroup {
    pub group_id: Option<String>,
    pub head: QueryRow,
    pub versions: Vec<QueryRow>,
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

/// A learned memory or user-correction rule associated with a connection and optional database.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DbMemory {
    pub id: String,
    pub conn_id: String,
    pub database: Option<String>,
    pub content: String,
    pub source: String,
    pub user_raw: String,
    pub created: i64,
    pub updated: i64,
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
            let rows =
                stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
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
        self.conn.execute(
            "UPDATE containers SET name = ?1 WHERE id = ?2",
            params![name, id],
        )?;
        Ok(())
    }

    pub fn update_container_db_type(&self, id: &str, db_type: Option<DbType>) -> Result<()> {
        let db_type_str = db_type.map(|t| match t {
            DbType::Mysql => "mysql",
            DbType::Redis => "redis",
        });
        self.conn.execute(
            "UPDATE containers SET db_type = ?1 WHERE id = ?2",
            params![db_type_str, id],
        )?;
        Ok(())
    }

    pub fn delete_container(&self, id: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM containers WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn delete_topology_atomic(
        &mut self,
        connection_ids: &[String],
        container_ids: &[String],
    ) -> Result<()> {
        let tx = self.conn.transaction()?;
        for id in connection_ids {
            tx.execute("DELETE FROM connections WHERE id = ?1", params![id])?;
        }
        for id in container_ids {
            tx.execute("DELETE FROM containers WHERE id = ?1", params![id])?;
        }
        tx.commit()?;
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
    ///
    /// `group_id` 是查询 tab 的虚拟 ID：同一 tab 迭代执行的每个版本都挂在
    /// 同组下，历史面板按组展示（最新一条 + 可展开的版本列表）。NULL 表示
    /// 无组的旧数据路径，面板按独立条目展示。
    ///
    /// 按（连接 + 库 + 归一化 SQL）去重：命中未命名的既有条目时不再插入，
    /// 而是把它的 `created` 顶到当前时间——等价于"这条 SQL 最近又跑了一次"，
    /// 历史面板自然排到最前。命名的片段（name IS NOT NULL）永远不参与去重。
    pub fn log_query(
        &self,
        conn_id: Option<&str>,
        db: Option<&str>,
        sql: &str,
        group_id: Option<&str>,
    ) -> Result<()> {
        let hash = sql_norm_hash(sql);
        let bumped = self.conn.execute(
            "UPDATE queries SET created = ?1
             WHERE name IS NULL AND conn_id IS ?2 AND db IS ?3 AND norm_hash = ?4",
            params![now_secs(), conn_id, db, hash],
        )?;
        if bumped > 0 {
            return Ok(());
        }
        let id = gen_id("q");
        self.conn.execute(
            "INSERT INTO queries (id, name, sql, conn_id, db, created, norm_hash, group_id)
             VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, sql, conn_id, db, now_secs(), hash, group_id],
        )?;
        Ok(())
    }

    /// 按版本组列出查询历史：每组返回最新一条作为 head（该查询最后一次
    /// 执行的 SQL / 连接 / 库），其余按时间倒序挂在 versions 下。命名片段
    /// 是独立的单条组。`limit` 限制返回的组数（版本数不另设上限，总量由
    /// `prune_queries_history` 的行数修剪兜底）。
    pub fn list_query_groups(&self, limit: usize) -> Result<Vec<QueryGroup>> {
        // 全量按时间倒序拉出（行数受修剪上限约束，几百~几千行），在内存
        // 里按组聚合：组内第一行即 head。
        let mut stmt = self.conn.prepare(
            "SELECT id, name, sql, conn_id, db, created, group_id FROM queries
             ORDER BY created DESC, rowid DESC",
        )?;
        let rows: Vec<(QueryRow, Option<String>)> = stmt
            .query_map([], |r| {
                Ok((
                    QueryRow {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        sql: r.get(2)?,
                        conn_id: r.get(3)?,
                        db: r.get(4)?,
                        created: r.get(5)?,
                    },
                    r.get(6)?,
                ))
            })?
            .collect::<std::result::Result<_, _>>()?;
        drop(stmt);

        let mut groups: Vec<QueryGroup> = Vec::new();
        let mut by_group: std::collections::HashMap<String, usize> =
            std::collections::HashMap::new();
        for (row, group_id) in rows {
            let named = row.name.is_some();
            // 有组的未命名行：挂到既有组（组内第一行即 head）；组不存在或
            // 命名片段 / 无组旧数据：自成一个新组。
            let attach_to: Option<usize> = match (&group_id, named) {
                (Some(g), false) => by_group.get(g).copied(),
                _ => None,
            };
            match attach_to {
                Some(i) => groups[i].versions.push(row),
                None => {
                    let gid = group_id.filter(|_| !named);
                    if let Some(g) = &gid {
                        by_group.insert(g.clone(), groups.len());
                    }
                    groups.push(QueryGroup {
                        group_id: gid,
                        head: row,
                        versions: Vec::new(),
                    });
                }
            }
        }
        groups.truncate(limit);
        Ok(groups)
    }

    /// Return recent queries (most recent first), capped to default 200.
    pub fn list_queries(&self) -> Result<Vec<QueryRow>> {
        self.list_queries_with_limit(None)
    }

    /// Return recent queries (most recent first), capped to `limit` (default 200).
    pub fn list_queries_with_limit(&self, limit: Option<usize>) -> Result<Vec<QueryRow>> {
        let cap = limit.unwrap_or(200);
        let mut stmt = self.conn.prepare(
            "SELECT id, name, sql, conn_id, db, created FROM queries
             ORDER BY created DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![cap as i64], |r| {
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

    /// Prune old un-named query execution history (keeping at most `max_history` items).
    /// Named snippets (`name IS NOT NULL`) are user-saved and never pruned.
    pub fn prune_queries_history(&self, max_history: usize) -> Result<usize> {
        let deleted = self.conn.execute(
            "DELETE FROM queries
             WHERE name IS NULL
               AND id NOT IN (
                   SELECT id FROM queries
                   WHERE name IS NULL
                   ORDER BY created DESC
                   LIMIT ?1
               )",
            params![max_history as i64],
        )?;
        Ok(deleted)
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

    /// 删除一条查询历史。带 `group_id` 时删除整个版本组（组头 + 全部版本），
    /// 否则按行 id 删除（兼容无组的旧条目与命名片段）。
    pub fn delete_query(&self, id: &str, group_id: Option<&str>) -> Result<()> {
        match group_id {
            Some(g) => {
                self.conn
                    .execute("DELETE FROM queries WHERE group_id = ?1", params![g])?;
            }
            None => {
                self.conn
                    .execute("DELETE FROM queries WHERE id = ?1", params![id])?;
            }
        }
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
    pub fn get_injected_kb_docs(&self, conn_id: &str, db: Option<&str>) -> Result<Vec<KbDoc>> {
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

    /// Add a knowledge-base document and optionally bind it to a connection and optional database.
    pub fn add_kb_doc_with_binding(
        &mut self,
        name: &str,
        content: &str,
        conn_id: Option<&str>,
        db: Option<&str>,
    ) -> Result<String> {
        let id = self.add_kb_doc(name, content)?;
        if let Some(cid) = conn_id {
            self.set_kb_bindings(&id, &[(cid.to_string(), db.map(|s| s.to_string()))])?;
        }
        Ok(id)
    }

    /// Search knowledge-base docs bound to (conn_id, db) by keyword.
    pub fn search_kb_docs(&self, conn_id: &str, db: Option<&str>, query: &str) -> Result<String> {
        let docs = self.get_injected_kb_docs(conn_id, db)?;
        let pairs: Vec<(String, String)> = docs.into_iter().map(|d| (d.name, d.content)).collect();
        Ok(search_kb_text(&pairs, query))
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
        result: Option<&str>,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO audit_log (id, ts, conn_id, conn_name, db, sql, decision, result)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                gen_id("aud"),
                now_secs(),
                conn_id,
                conn_name,
                db,
                sql,
                decision,
                result,
            ],
        )?;
        Ok(())
    }

    /// Most-recent-first audit entries, capped at `limit`. Tuple fields:
    /// (conn_name, db, sql, decision, result, ts). `db` is `None` for whole-connection.
    pub fn list_audits(
        &self,
        limit: i64,
    ) -> Result<Vec<(String, Option<String>, String, String, Option<String>, i64)>> {
        let mut stmt = self.conn.prepare(
            "SELECT conn_name, db, sql, decision, result, ts FROM audit_log ORDER BY ts DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    // --- DB-associated Memories & User Corrections ---

    /// Add or update a learned memory / correction rule.
    pub fn add_memory(
        &self,
        conn_id: &str,
        database: Option<&str>,
        content: &str,
        source: &str,
        user_raw: &str,
    ) -> Result<DbMemory> {
        let now = now_secs();
        let db_val = database.filter(|s| !s.trim().is_empty());
        // Check if an identical memory content already exists under this conn + db
        let mut check = self.conn.prepare(
            "SELECT id, created FROM db_memories
             WHERE conn_id = ?1 AND (database IS ?2 OR database = ?2) AND content = ?3",
        )?;
        let mut existing = check.query_map(params![conn_id, db_val, content], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?;

        if let Some(row) = existing.next() {
            let (id, created) = row?;
            self.conn.execute(
                "UPDATE db_memories SET updated = ?1, user_raw = ?2, source = ?3 WHERE id = ?4",
                params![now, user_raw, source, id],
            )?;
            return Ok(DbMemory {
                id,
                conn_id: conn_id.to_string(),
                database: db_val.map(|s| s.to_string()),
                content: content.to_string(),
                source: source.to_string(),
                user_raw: user_raw.to_string(),
                created,
                updated: now,
            });
        }

        let id = gen_id("mem");
        self.conn.execute(
            "INSERT INTO db_memories (id, conn_id, database, content, source, user_raw, created, updated)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, conn_id, db_val, content, source, user_raw, now, now],
        )?;

        Ok(DbMemory {
            id,
            conn_id: conn_id.to_string(),
            database: db_val.map(|s| s.to_string()),
            content: content.to_string(),
            source: source.to_string(),
            user_raw: user_raw.to_string(),
            created: now,
            updated: now,
        })
    }

    /// Retrieve memories that should be injected for the active (conn_id, database).
    /// Inherits connection-level memories (database IS NULL) plus any specific to this database.
    pub fn get_injected_memories(
        &self,
        conn_id: &str,
        database: Option<&str>,
        limit: usize,
    ) -> Result<Vec<DbMemory>> {
        let db_val = database.filter(|s| !s.trim().is_empty());
        let mut stmt = self.conn.prepare(
            "SELECT id, conn_id, database, content, source, user_raw, created, updated
             FROM db_memories
             WHERE (conn_id = ?1 AND database IS NULL)
                OR (conn_id = ?1 AND database = ?2)
             ORDER BY updated DESC
             LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![conn_id, db_val, limit as i64], |r| {
            Ok(DbMemory {
                id: r.get(0)?,
                conn_id: r.get(1)?,
                database: r.get(2)?,
                content: r.get(3)?,
                source: r.get(4)?,
                user_raw: r.get(5)?,
                created: r.get(6)?,
                updated: r.get(7)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// List all memories under a connection and optional database filter.
    pub fn list_memories(&self, conn_id: &str, database: Option<&str>) -> Result<Vec<DbMemory>> {
        self.get_injected_memories(conn_id, database, 100)
    }

    /// List all memories across all connections and databases.
    pub fn list_all_memories(&self, limit: usize) -> Result<Vec<DbMemory>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, conn_id, database, content, source, user_raw, created, updated
             FROM db_memories
             ORDER BY updated DESC
             LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], |r| {
            Ok(DbMemory {
                id: r.get(0)?,
                conn_id: r.get(1)?,
                database: r.get(2)?,
                content: r.get(3)?,
                source: r.get(4)?,
                user_raw: r.get(5)?,
                created: r.get(6)?,
                updated: r.get(7)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Update an existing memory's content, database scope, or rule text ("纠正记忆").
    pub fn update_memory(
        &self,
        id: &str,
        content: &str,
        database: Option<&str>,
    ) -> Result<DbMemory> {
        let now = now_secs();
        let db_val = database.filter(|s| !s.trim().is_empty());
        self.conn.execute(
            "UPDATE db_memories SET content = ?1, database = ?2, updated = ?3 WHERE id = ?4",
            params![content, db_val, now, id],
        )?;

        let mut stmt = self.conn.prepare(
            "SELECT id, conn_id, database, content, source, user_raw, created, updated
             FROM db_memories WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], |r| {
            Ok(DbMemory {
                id: r.get(0)?,
                conn_id: r.get(1)?,
                database: r.get(2)?,
                content: r.get(3)?,
                source: r.get(4)?,
                user_raw: r.get(5)?,
                created: r.get(6)?,
                updated: r.get(7)?,
            })
        })?;

        match rows.next() {
            Some(row) => Ok(row?),
            None => Err(AppError::Msg(format!("未找到记忆记录: {}", id))),
        }
    }

    /// Delete a memory by id.
    pub fn delete_memory(&self, id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM db_memories WHERE id = ?1", params![id])?;
        Ok(())
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
    pub fn create_conversation(
        &self,
        conn_id: Option<&str>,
        title: Option<&str>,
    ) -> Result<String> {
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
                meta: meta.and_then(|m| serde_json::from_str(&m).ok()),
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

    // --- Data Assistants (数据助手) ---

    pub fn list_data_assistants(&self) -> Result<Vec<DataAssistant>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, avatar, description, system_prompt, bound_db_connection_ids, bound_knowledge_base_ids, created, updated
             FROM data_assistants ORDER BY updated DESC",
        )?;
        let rows = stmt.query_map([], |r| {
            let db_ids_str: String = r.get(5)?;
            let kb_ids_str: String = r.get(6)?;
            let bound_databases = parse_assistant_db_bindings(&db_ids_str);
            let bound_knowledge_base_ids: Vec<String> =
                serde_json::from_str(&kb_ids_str).unwrap_or_default();
            Ok(DataAssistant {
                id: r.get(0)?,
                name: r.get(1)?,
                avatar: r.get(2)?,
                description: r.get(3)?,
                system_prompt: r.get(4)?,
                bound_databases,
                bound_knowledge_base_ids,
                created: r.get(7)?,
                updated: r.get(8)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn get_data_assistant(&self, id: &str) -> Result<Option<DataAssistant>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, avatar, description, system_prompt, bound_db_connection_ids, bound_knowledge_base_ids, created, updated
             FROM data_assistants WHERE id = ?1",
        )?;
        let res = stmt.query_row(params![id], |r| {
            let db_ids_str: String = r.get(5)?;
            let kb_ids_str: String = r.get(6)?;
            let bound_databases = parse_assistant_db_bindings(&db_ids_str);
            let bound_knowledge_base_ids: Vec<String> =
                serde_json::from_str(&kb_ids_str).unwrap_or_default();
            Ok(DataAssistant {
                id: r.get(0)?,
                name: r.get(1)?,
                avatar: r.get(2)?,
                description: r.get(3)?,
                system_prompt: r.get(4)?,
                bound_databases,
                bound_knowledge_base_ids,
                created: r.get(7)?,
                updated: r.get(8)?,
            })
        }).optional()?;
        Ok(res)
    }

    pub fn save_data_assistant(&self, a: &DataAssistant) -> Result<()> {
        let db_bindings_json = serde_json::to_string(&a.bound_databases).unwrap_or_else(|_| "[]".into());
        let kb_ids_json = serde_json::to_string(&a.bound_knowledge_base_ids).unwrap_or_else(|_| "[]".into());
        self.conn.execute(
            "INSERT INTO data_assistants (id, name, avatar, description, system_prompt, bound_db_connection_ids, bound_knowledge_base_ids, created, updated)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               avatar = excluded.avatar,
               description = excluded.description,
               system_prompt = excluded.system_prompt,
               bound_db_connection_ids = excluded.bound_db_connection_ids,
               bound_knowledge_base_ids = excluded.bound_knowledge_base_ids,
               updated = excluded.updated",
            params![
                a.id,
                a.name,
                a.avatar,
                a.description,
                a.system_prompt,
                db_bindings_json,
                kb_ids_json,
                a.created,
                a.updated,
            ],
        )?;
        Ok(())
    }

    pub fn delete_data_assistant(&self, id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM data_assistants WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Retrieve knowledge-base documents by their IDs (for Data Assistant injection)
    pub fn get_kb_docs_by_ids(&self, ids: &[String]) -> Result<Vec<KbDoc>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT id, name, content, created, updated FROM kb_docs WHERE id IN ({})",
            placeholders
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let params_vec: Vec<&dyn rusqlite::ToSql> = ids.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
        let rows = stmt.query_map(params_vec.as_slice(), |r| {
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

    /// 释放 SQLite 引擎未使用的内部内存缓存（PRAGMA shrink_memory）。
    pub fn shrink_memory(&self) -> Result<()> {
        let _ = self.conn.execute_batch("PRAGMA shrink_memory;");
        Ok(())
    }
}

fn parse_assistant_db_bindings(raw: &str) -> Vec<AssistantDbBinding> {
    if let Ok(bindings) = serde_json::from_str::<Vec<AssistantDbBinding>>(raw) {
        return bindings;
    }
    if let Ok(ids) = serde_json::from_str::<Vec<String>>(raw) {
        return ids
            .into_iter()
            .map(|conn_id| AssistantDbBinding {
                conn_id,
                database: None,
            })
            .collect();
    }
    Vec::new()
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// First 60 characters of a message, for preview lists.
pub fn preview_of(content: Option<&str>) -> String {
    content.unwrap_or_default().chars().take(60).collect()
}

/// Case-insensitive keyword match over doc contents. Returns each hit doc's
/// name plus a truncated body, capped so results stay small.
pub fn search_kb_text(docs: &[(String, String)], query: &str) -> String {
    let q = query.to_lowercase();
    let words: Vec<&str> = q
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|w| !w.is_empty())
        .collect();
    if words.is_empty() {
        return "(查询为空)".into();
    }
    let mut out = String::new();
    let mut total = 0usize;
    const CAP: usize = 6000;
    const PER_DOC: usize = 4000;
    for (name, content) in docs {
        let lower = content.to_lowercase();
        if !words.iter().any(|w| lower.contains(w)) {
            continue;
        }
        if total >= CAP {
            break;
        }
        let take: String = content.chars().take(PER_DOC).collect();
        total += take.chars().count();
        out.push_str(&format!("### 知识库文档：{}\n{}\n\n", name, take));
    }
    if out.is_empty() {
        out.push_str("(知识库中没有匹配该关键词的内容)");
    }
    out
}

/// 归一化 SQL 并产出用于历史去重的稳定哈希。归一化规则：折叠引号外的
/// 所有空白（含换行/制表）为单个空格、去掉结尾分号、忽略大小写——同一
/// 语句的排版差异（紧凑 vs 多行格式化）、`select` vs `SELECT`、结尾有无
/// 分号视为同一条。引号内的字符串字面量保留原样参与哈希：'ABC' 与 'abc'
/// 是不同的过滤条件，不算重复。
///
/// 哈希用 FNV-1a 64：手工实现、跨进程跨版本逐字节稳定（std 的
/// DefaultHasher 不承诺跨版本一致，会让存量行哈希失效），且不引入依赖。
/// 哈希只做去重桶定位，非安全用途。
fn sql_norm_hash(sql: &str) -> i64 {
    let mut norm = String::with_capacity(sql.len());
    let mut prev_ws = true; // 开头空白直接跳过，等价于 trim_start
    let mut in_str: Option<char> = None; // 当前所处的引号（' 或 "）
    for ch in sql.chars() {
        if let Some(quote) = in_str {
            // 字面量内部：逐字符原样保留（含空白），遇配对引号结束。
            norm.push(ch);
            if ch == quote {
                in_str = None;
            }
            continue;
        }
        if ch.is_whitespace() {
            if !prev_ws {
                norm.push(' ');
                prev_ws = true;
            }
            continue;
        }
        prev_ws = false;
        if ch == '\'' || ch == '"' {
            in_str = Some(ch);
            norm.push(ch);
        } else {
            for lc in ch.to_lowercase() {
                norm.push(lc);
            }
        }
    }
    let norm = norm.trim_end_matches([';', ' ']);
    let mut h: u64 = 0xcbf2_9ce4_8422_2325; // FNV offset basis
    for b in norm.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3); // FNV prime
    }
    h as i64
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
    {
        // 历史去重键：归一化 SQL 的稳定哈希（见 sql_norm_hash）。老库存量行
        // 在迁移里回填，之后 log_query 按 (conn_id, db, norm_hash) 命中即
        // 顶置既有条目，不再插入重复行。
        let mut pragma = conn.prepare("PRAGMA table_info(queries)")?;
        let cols: Vec<String> = pragma
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<std::result::Result<_, _>>()?;
        drop(pragma);
        if !cols.iter().any(|n| n == "norm_hash") {
            conn.execute("ALTER TABLE queries ADD COLUMN norm_hash INTEGER", [])?;
        }
        // 版本组：同一个查询 tab 的虚拟 ID（前端在建 tab 时生成），同组行
        // 是该查询迭代执行的各个版本。NULL = 旧数据/无组，历史面板按独立
        // 条目展示。
        if !cols.iter().any(|n| n == "group_id") {
            conn.execute("ALTER TABLE queries ADD COLUMN group_id TEXT", [])?;
        }
        // 回填存量行（新行由 log_query 写入）。只处理 NULL，幂等。
        let backfill = |conn: &Connection| -> Result<()> {
            let mut stmt = conn.prepare("SELECT id, sql FROM queries WHERE norm_hash IS NULL")?;
            let rows: Vec<(String, String)> = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<std::result::Result<_, _>>()?;
            drop(stmt);
            for (id, sql) in rows {
                conn.execute(
                    "UPDATE queries SET norm_hash = ?1 WHERE id = ?2",
                    params![sql_norm_hash(&sql), id],
                )?;
            }
            Ok(())
        };
        backfill(conn)?;
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_queries_norm
                 ON queries(conn_id, db, norm_hash);",
        )?;
    }
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
            decision  TEXT NOT NULL,
            result    TEXT
        );",
    )?;
    {
        let mut pragma = conn.prepare("PRAGMA table_info(audit_log)")?;
        let has_result: bool = pragma
            .query_map([], |r| r.get::<_, String>(1))?
            .any(|c| c.map(|n| n == "result").unwrap_or(false));
        if !has_result {
            conn.execute("ALTER TABLE audit_log ADD COLUMN result TEXT", [])?;
        }
    }
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
    conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_msg_conv ON chat_messages(conv_id, seq);")?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS data_assistants (
            id                       TEXT PRIMARY KEY,
            name                     TEXT NOT NULL,
            avatar                   TEXT,
            description              TEXT NOT NULL DEFAULT '',
            system_prompt            TEXT NOT NULL DEFAULT '',
            bound_db_connection_ids  TEXT NOT NULL DEFAULT '[]',
            bound_knowledge_base_ids TEXT NOT NULL DEFAULT '[]',
            created                  INTEGER NOT NULL,
            updated                  INTEGER NOT NULL
        );",
    )?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS db_memories (
            id       TEXT PRIMARY KEY,
            conn_id  TEXT NOT NULL,
            database TEXT,
            content  TEXT NOT NULL,
            source   TEXT NOT NULL,
            user_raw TEXT NOT NULL,
            created  INTEGER NOT NULL,
            updated  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_db_memories_conn_db ON db_memories(conn_id, database);",
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
        Storage {
            conn,
            key: [0u8; 32],
        }
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
        s.set_kb_bindings(&b, &[("connA".into(), Some("dbX".into()))])
            .unwrap();
        s.set_kb_bindings(&c, &[("connB".into(), None)]).unwrap();

        // db=None → only whole-connection bindings, not db-specific ones
        let r = s.get_injected_kb_docs("connA", None).unwrap();
        assert_eq!(names(r), vec!["整条连接A".to_string()]);

        // connA + dbX → whole-connection (A) AND dbX-specific (B)
        let r = s.get_injected_kb_docs("connA", Some("dbX")).unwrap();
        assert_eq!(
            names(r),
            vec!["库X专用".to_string(), "整条连接A".to_string()]
        );

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
        s.add_audit(
            "c1",
            "demo",
            Some("mydb"),
            "DELETE FROM t",
            "write-approved",
            Some("影响 1 行"),
        )
        .unwrap();
        s.add_audit(
            "c1",
            "demo",
            None,
            "DROP TABLE t",
            "deny",
            Some("护栏拦截：破坏性 DDL"),
        )
        .unwrap();
        let rows = s.list_audits(10).unwrap();
        assert_eq!(rows.len(), 2);
        // Both decisions recorded (don't assert order — ts is second-granular).
        let decisions: Vec<&str> = rows.iter().map(|r| r.3.as_str()).collect();
        assert!(decisions.contains(&"deny"));
        assert!(decisions.contains(&"write-approved"));
        // results captured
        let results: Vec<Option<String>> = rows.iter().map(|r| r.4.clone()).collect();
        assert!(results.contains(&Some("影响 1 行".to_string())));
        assert!(results.contains(&Some("护栏拦截：破坏性 DDL".to_string())));
        // db binding captured: one whole-connection (None), one specific db.
        let dbs: Vec<Option<String>> = rows.iter().map(|r| r.1.clone()).collect();
        assert!(dbs.contains(&None));
        assert!(dbs.contains(&Some("mydb".to_string())));
    }

    #[test]
    fn query_history_limit_and_pruning() {
        let s = mem_store();
        for i in 1..=5 {
            s.log_query(Some("c1"), Some("db1"), &format!("SELECT {i}"), Some("g1"))
                .unwrap();
        }
        // Save one snippet
        s.save_query(None, "my_fav", "SELECT 999", Some("c1"), Some("db1"))
            .unwrap();

        // 5 history + 1 snippet = 6
        let all = s.list_queries().unwrap();
        assert_eq!(all.len(), 6);

        // List with limit 2
        let limited = s.list_queries_with_limit(Some(2)).unwrap();
        assert_eq!(limited.len(), 2);

        // Prune un-named history to 2 entries
        let deleted = s.prune_queries_history(2).unwrap();
        assert_eq!(deleted, 3);

        // After pruning: 2 history + 1 snippet = 3
        let remaining = s.list_queries().unwrap();
        assert_eq!(remaining.len(), 3);
        assert!(remaining
            .iter()
            .any(|q| q.name.as_deref() == Some("my_fav")));
    }

    /// 同一连接下重复执行相同 SQL（含排版/大小写/结尾分号差异）只保留一条
    /// 历史且顶置到最新；跨连接不去重；命名片段不受影响。
    #[test]
    fn log_query_dedups_by_conn_and_normalized_sql() {
        let s = mem_store();
        s.log_query(Some("c1"), Some("db1"), "SELECT a\n  FROM t;", Some("g1"))
            .unwrap();
        // 同一 SQL 换排版再跑：不新增行，顶置原行，且保留首次的原文。
        s.log_query(Some("c1"), Some("db1"), "select a from t", Some("g1"))
            .unwrap();
        let rows = s.list_queries().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].sql, "SELECT a\n  FROM t;");

        // 不同连接的同一条 SQL 是不同历史。
        s.log_query(Some("c2"), Some("db1"), "SELECT a FROM t", Some("g1"))
            .unwrap();
        assert_eq!(s.list_queries().unwrap().len(), 2);

        // 不同库的同一条 SQL 也是不同历史（载入时要还原正确的执行上下文）。
        s.log_query(Some("c1"), Some("db2"), "SELECT a FROM t", Some("g1"))
            .unwrap();
        assert_eq!(s.list_queries().unwrap().len(), 3);

        // 命名片段与历史互不去重：同键的历史条目再次执行时仍只顶置历史行，
        // 片段（name 非空）不受影响、也不顶置。
        s.save_query(None, "fav", "SELECT a FROM t", Some("c1"), Some("db1"))
            .unwrap();
        s.log_query(Some("c1"), Some("db1"), "SELECT a FROM t", Some("g1"))
            .unwrap();
        let rows = s.list_queries().unwrap();
        assert_eq!(rows.len(), 4);
        // 最新一条是被顶置的首条历史（保留首次原文），片段紧随其后。
        assert_eq!(rows[0].sql, "SELECT a\n  FROM t;");
        assert!(rows[0].name.is_none());
        let snippet = rows
            .iter()
            .find(|r| r.name.as_deref() == Some("fav"))
            .unwrap();
        assert!(rows.iter().position(|r| r.id == snippet.id).unwrap() > 0);
    }

    /// 版本组：同一虚拟 ID（查询 tab）的迭代执行归为一组，head 是最新一次
    /// 执行；命名片段和旧数据（无组）是独立条目；limit 截断组数。
    #[test]
    fn list_query_groups_versions_and_heads() {
        let s = mem_store();
        // tab g1 迭代三个版本（时间递增）
        s.log_query(Some("c1"), Some("db1"), "SELECT 1", Some("g1"))
            .unwrap();
        s.log_query(Some("c1"), Some("db1"), "SELECT 1, 2", Some("g1"))
            .unwrap();
        s.log_query(Some("c1"), Some("db1"), "SELECT 1, 2, 3", Some("g1"))
            .unwrap();
        // tab g2 一个版本
        s.log_query(Some("c2"), Some("db2"), "SELECT 9", Some("g2"))
            .unwrap();
        // 命名片段 + 无组旧数据
        s.save_query(None, "fav", "SELECT 8", Some("c1"), Some("db1"))
            .unwrap();
        s.log_query(Some("c1"), Some("db1"), "SELECT 7", None)
            .unwrap();

        let groups = s.list_query_groups(10).unwrap();
        assert_eq!(groups.len(), 4); // g1, g2, fav, 无组旧数据

        // g1：head 是最新版本，versions 按时间倒序挂旧版本
        let g1 = groups
            .iter()
            .find(|g| g.group_id.as_deref() == Some("g1"))
            .unwrap();
        assert_eq!(g1.head.sql, "SELECT 1, 2, 3");
        assert_eq!(g1.versions.len(), 2);
        assert_eq!(g1.versions[0].sql, "SELECT 1, 2");
        assert_eq!(g1.versions[1].sql, "SELECT 1");

        // g2 是单版本组
        let g2 = groups
            .iter()
            .find(|g| g.group_id.as_deref() == Some("g2"))
            .unwrap();
        assert_eq!(g2.head.sql, "SELECT 9");
        assert!(g2.versions.is_empty());

        // 组按 head 时间倒序：g2（后建）排在 g1 前
        let g1_pos = groups
            .iter()
            .position(|g| g.group_id.is_some() && g.head.sql.starts_with("SELECT 1,"))
            .unwrap();
        let g2_pos = groups
            .iter()
            .position(|g| g.group_id.as_deref() == Some("g2"))
            .unwrap();
        assert!(g2_pos < g1_pos);

        // 命名片段是独立单条组；limit 截断组数
        assert!(groups.iter().any(|g| g.head.name.as_deref() == Some("fav")));
        assert_eq!(s.list_query_groups(2).unwrap().len(), 2);
    }

    /// 组删除：删组头时整组（含全部版本）删除；按 id 删除只删单行。
    #[test]
    fn delete_query_group_vs_row() {
        let s = mem_store();
        s.log_query(Some("c1"), Some("db1"), "SELECT 1", Some("g1"))
            .unwrap();
        s.log_query(Some("c1"), Some("db1"), "SELECT 1, 2", Some("g1"))
            .unwrap();
        s.log_query(Some("c1"), Some("db1"), "SELECT 7", None)
            .unwrap();

        // 按行 id 只删那一行
        s.delete_query("nonexistent", None).unwrap();
        assert_eq!(s.list_queries().unwrap().len(), 3);

        // 整组删除
        s.delete_query("whatever", Some("g1")).unwrap();
        let left = s.list_queries().unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].sql, "SELECT 7");
    }

    /// 归一化哈希的关键语义：排版差异折叠、大小写不敏感、结尾分号可无；
    /// 字符串字面量内容参与哈希（不同字面量不同条）。
    #[test]
    fn sql_norm_hash_folds_formatting_only() {
        let a = sql_norm_hash("SELECT a\n\tFROM  t ;");
        let b = sql_norm_hash("select a from t");
        assert_eq!(a, b);
        // 字面量内容不同 → 不同条（去重只在字面量之外折叠大小写）。
        assert_ne!(
            sql_norm_hash("SELECT * FROM t WHERE s = 'ABC'"),
            sql_norm_hash("SELECT * FROM t WHERE s = 'abc'")
        );
        // 空串与纯空白/分号同桶。
        assert_eq!(sql_norm_hash(";"), sql_norm_hash("  \n "));
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
        s.append_chat_messages(&id, &[msg("user", "第一问"), msg("assistant", "第一答")])
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
        assert!(s.append_chat_messages(&id, &[msg("spam", "x")]).is_err());
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
        s.append_chat_messages(&b, &[msg("user", "新活动")])
            .unwrap();
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

    #[test]
    fn data_assistant_crud() {
        let s = mem_store();
        assert!(s.list_data_assistants().unwrap().is_empty());

        let ast = DataAssistant {
            id: "ast_1".to_string(),
            name: "电商业务助手".to_string(),
            avatar: Some("🛒".to_string()),
            description: "用于分析订单与用户画像".to_string(),
            system_prompt: "只查询最近30天数据".to_string(),
            bound_databases: vec![
                AssistantDbBinding {
                    conn_id: "c1".to_string(),
                    database: Some("order_db".to_string()),
                },
                AssistantDbBinding {
                    conn_id: "c2".to_string(),
                    database: None,
                },
            ],
            bound_knowledge_base_ids: vec!["kb1".to_string()],
            created: 1000,
            updated: 1000,
        };
        s.save_data_assistant(&ast).unwrap();

        let list = s.list_data_assistants().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "电商业务助手");
        assert_eq!(list[0].bound_databases.len(), 2);
        assert_eq!(list[0].bound_databases[0].database, Some("order_db".to_string()));
        assert_eq!(list[0].bound_knowledge_base_ids, vec!["kb1"]);

        let item = s.get_data_assistant("ast_1").unwrap().expect("found");
        assert_eq!(item.system_prompt, "只查询最近30天数据");

        s.delete_data_assistant("ast_1").unwrap();
        assert!(s.list_data_assistants().unwrap().is_empty());
    }

    #[test]
    fn db_memories_crud_and_inheritance() {
        let s = mem_store();
        // 1. Add connection-level memory (database = None)
        let m1 = s
            .add_memory("c1", None, "全连接必须遵循的规范", "manual", "全局规范")
            .unwrap();
        // 2. Add db-specific memory
        let m2 = s
            .add_memory("c1", Some("db_alpha"), "db_alpha中yk_config用code字段", "correction", "用code不是key")
            .unwrap();
        // 3. Add memory under another db
        let _m3 = s
            .add_memory("c1", Some("db_beta"), "db_beta的专属规则", "correction", "beta规则")
            .unwrap();
        // 4. Add memory under another conn
        let _m4 = s
            .add_memory("c2", None, "c2的规则", "manual", "c2")
            .unwrap();

        // Querying for (c1, db_alpha) should return m2 and m1, but not m3 or m4
        let alpha_mems = s.get_injected_memories("c1", Some("db_alpha"), 10).unwrap();
        let alpha_contents: Vec<&str> = alpha_mems.iter().map(|m| m.content.as_str()).collect();
        assert!(alpha_contents.contains(&"db_alpha中yk_config用code字段"));
        assert!(alpha_contents.contains(&"全连接必须遵循的规范"));
        assert!(!alpha_contents.contains(&"db_beta的专属规则"));
        assert!(!alpha_contents.contains(&"c2的规则"));

        // Querying for (c1, None) should only return c1 whole-connection memories
        let c1_global = s.get_injected_memories("c1", None, 10).unwrap();
        let c1_contents: Vec<&str> = c1_global.iter().map(|m| m.content.as_str()).collect();
        assert!(c1_contents.contains(&"全连接必须遵循的规范"));
        assert!(!c1_contents.contains(&"db_alpha中yk_config用code字段"));

        // Deduplication update on identical content
        let m2_updated = s
            .add_memory("c1", Some("db_alpha"), "db_alpha中yk_config用code字段", "correction", "再次强调")
            .unwrap();
        assert_eq!(m2.id, m2_updated.id);
        assert_eq!(m2_updated.user_raw, "再次强调");

        // Delete
        s.delete_memory(&m1.id).unwrap();
        let after_del = s.get_injected_memories("c1", Some("db_alpha"), 10).unwrap();
        assert_eq!(after_del.len(), 1);
        assert_eq!(after_del[0].id, m2.id);
    }

    #[test]
    fn kb_add_with_binding_and_search() {
        let mut s = mem_store();
        let id = s
            .add_kb_doc_with_binding(
                "支付口径说明",
                "订单支付成功 status=1 且包含 refund_status=0 的记录视为有效成交。",
                Some("connA"),
                Some("trade_db"),
            )
            .unwrap();
        assert!(id.starts_with("kb"));

        // 检索命中
        let text = s
            .search_kb_docs("connA", Some("trade_db"), "refund")
            .unwrap();
        assert!(text.contains("支付口径说明"));
        assert!(text.contains("refund_status"));

        // 不匹配连接
        let text_other = s.search_kb_docs("connB", None, "refund").unwrap();
        assert!(text_other.contains("没有匹配"));
    }
}

fn config_dir() -> PathBuf {
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        return PathBuf::from(xdg).join("chatquery");
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".config").join("chatquery")
}
