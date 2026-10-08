use crate::db::container::{Container, ContainerKind};
use crate::error::Result;
use crate::store::{QueryGroup, QueryRow, Storage};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    pub db_type: DbType,
    pub host: String,
    pub port: u16,
    pub user: String,
    /// Persisted encrypted at rest (ADR-004); only ever held in plaintext in memory.
    pub password: String,
    pub database: String,
    // --- SSL / TLS (#4) ---------------------------------------------------
    /// disabled | preferred | required | verify_ca | verify_identity.
    #[serde(default)]
    pub ssl_mode: String,
    /// CA certificate PEM (path or inline). Used when ssl_mode needs a CA.
    #[serde(default)]
    pub ssl_ca: String,
    /// Client certificate PEM for mutual TLS (optional).
    #[serde(default)]
    pub client_cert: String,
    /// Client private key PEM for mutual TLS (optional). Encrypted at rest.
    #[serde(default)]
    pub client_key: String,
    // --- SSH tunnel / bastion (#5) ----------------------------------------
    /// SSH jump host. Empty = no tunnel (connect directly).
    #[serde(default)]
    pub ssh_host: String,
    #[serde(default)]
    pub ssh_port: u16,
    #[serde(default)]
    pub ssh_user: String,
    /// password | key | agent.
    #[serde(default)]
    pub ssh_auth_kind: String,
    /// SSH password (encrypted at rest). Only for auth_kind = password.
    #[serde(default)]
    pub ssh_password: String,
    /// SSH private key (encrypted at rest). Only for auth_kind = key.
    #[serde(default)]
    pub ssh_private_key: String,
    /// First-class grouping reference (ADR-016). The connection belongs to the
    /// group whose id is stored here; the group's parent environment is found
    /// by walking the container tree. `None` means ungrouped (rendered under a
    /// synthetic "未分组" bucket). `serde(default)` keeps legacy blobs (which
    /// carried `env`/`group` strings instead) loadable — the migration in
    /// `ConnectionStore::load` synthesizes containers and fills this in.
    #[serde(default)]
    pub group_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum DbType {
    #[default]
    Mysql,
    Redis,
}

impl DbType {
    pub fn default_port(self) -> u16 {
        match self {
            DbType::Mysql => 3306,
            DbType::Redis => 6379,
        }
    }
}

/// In-memory registry of connections, backed by SQLite.
/// Connection metadata is loaded lazily (ADR-006): we only keep what the user expands.
pub struct ConnectionStore {
    connections: Vec<ConnectionConfig>,
    /// First-class tree containers (environments + groups). Populated at load
    /// and mutated by the container CRUD commands (ADR-016).
    containers: Vec<Container>,
    storage: Storage,
}

impl ConnectionStore {
    pub fn load(storage: Storage) -> Result<Self> {
        let legacy = storage.load_connection_legacy()?;
        let mut containers = storage.load_containers()?;
        let mut connections = Vec::with_capacity(legacy.len());
        let mut dirty = false;
        for lc in legacy {
            let group_id = match lc.group_id {
                Some(g) => g,
                None => {
                    // Legacy blob: env/group were plain strings. Synthesize the
                    // container tree and attach the connection to its group.
                    dirty = true;
                    let env_name = if lc.env.trim().is_empty() {
                        "默认环境"
                    } else {
                        lc.env.trim()
                    };
                    let grp_name = if lc.group.trim().is_empty() {
                        "默认分组"
                    } else {
                        lc.group.trim()
                    };
                    let env_id = ensure_env(&mut containers, &storage, env_name, lc.db_type)?;
                    ensure_group(&mut containers, &storage, &env_id, grp_name)?
                }
            };
            connections.push(ConnectionConfig {
                id: lc.id,
                name: lc.name,
                db_type: lc.db_type,
                host: lc.host,
                port: lc.port,
                user: lc.user,
                password: lc.password,
                database: lc.database,
                ssl_mode: lc.ssl_mode,
                ssl_ca: lc.ssl_ca,
                client_cert: lc.client_cert,
                client_key: lc.client_key,
                ssh_host: lc.ssh_host,
                ssh_port: lc.ssh_port,
                ssh_user: lc.ssh_user,
                ssh_auth_kind: lc.ssh_auth_kind,
                ssh_password: lc.ssh_password,
                ssh_private_key: lc.ssh_private_key,
                group_id: Some(group_id),
            });
        }
        // Persist migrated connections so group_id survives a reload.
        if dirty {
            for c in &connections {
                storage.upsert_connection(c)?;
            }
        }
        // Heal environments:
        // 1) All connections inside are Redis but db_type != Redis => set to Redis.
        // 2) db_type is None (legacy missing data, ADR-022) => default to MySQL (or Redis if pure redis).
        let mut updates: Vec<(String, DbType)> = Vec::new();
        for env in containers.iter().filter(|c| c.kind == ContainerKind::Env) {
            let group_ids: Vec<&str> = containers
                .iter()
                .filter(|g| g.kind == ContainerKind::Group && g.parent.as_deref() == Some(&env.id))
                .map(|g| g.id.as_str())
                .collect();
            let env_conns: Vec<&ConnectionConfig> = connections
                .iter()
                .filter(|c| c.group_id.as_deref().map_or(false, |gid| group_ids.contains(&gid)))
                .collect();
            let has_redis = env_conns.iter().any(|c| c.db_type == DbType::Redis);
            let has_mysql = env_conns.iter().any(|c| c.db_type == DbType::Mysql);
            if !env_conns.is_empty() && has_redis && !has_mysql && env.db_type != Some(DbType::Redis) {
                updates.push((env.id.clone(), DbType::Redis));
            } else if env.db_type.is_none() {
                updates.push((env.id.clone(), DbType::Mysql));
            }
        }
        for (env_id, dt) in updates {
            if let Some(env) = containers.iter_mut().find(|c| c.id == env_id) {
                env.db_type = Some(dt);
            }
            let _ = storage.update_container_db_type(&env_id, Some(dt));
        }
        Ok(Self {
            connections,
            containers,
            storage,
        })
    }

    pub fn list(&self) -> &[ConnectionConfig] {
        &self.connections
    }

    pub fn storage(&self) -> &Storage {
        &self.storage
    }

    pub fn get(&self, idx: usize) -> Option<&ConnectionConfig> {
        self.connections.get(idx)
    }

    pub fn list_containers(&self) -> &[Container] {
        &self.containers
    }

    pub fn add(&mut self, mut cfg: ConnectionConfig) -> Result<()> {
        if cfg.port == 0 {
            cfg.port = cfg.db_type.default_port();
        }
        if cfg.id.is_empty() {
            cfg.id = gen_id();
        }
        self.storage.upsert_connection(&cfg)?;
        self.connections.push(cfg);
        Ok(())
    }

    /// Insert or replace a connection by id (used by the in-TUI edit form).
    pub fn update(&mut self, mut cfg: ConnectionConfig) -> Result<()> {
        if cfg.port == 0 {
            cfg.port = cfg.db_type.default_port();
        }
        if cfg.id.is_empty() {
            cfg.id = gen_id();
        }
        self.storage.upsert_connection(&cfg)?;
        if let Some(pos) = self.connections.iter().position(|c| c.id == cfg.id) {
            self.connections[pos] = cfg;
        } else {
            self.connections.push(cfg);
        }
        Ok(())
    }

    /// Delete a connection by id, from both storage and the in-memory list.
    pub fn remove(&mut self, id: &str) -> Result<()> {
        self.storage.delete_connection(id)?;
        self.connections.retain(|c| c.id != id);
        Ok(())
    }

    /// Configure or rotate the connection encryption key K (#0). Delegates to
    /// the inner `Storage`, which re-encrypts every record atomically.
    pub fn rotate_key(&mut self, field: &str) -> Result<()> {
        self.storage.rotate_key(field)
    }

    /// Reload in-memory connections and containers from underlying storage.
    pub fn reload(&mut self) -> Result<()> {
        let connections = self.storage.load_connections()?;
        let containers = self.storage.load_containers()?;
        self.connections = connections;
        self.containers = containers;
        Ok(())
    }

    // --- Query history / saved snippets ----------------------------------

    pub fn log_query(
        &self,
        conn_id: Option<&str>,
        db: Option<&str>,
        sql: &str,
        group_id: Option<&str>,
    ) -> Result<()> {
        self.storage.log_query(conn_id, db, sql, group_id)
    }

    pub fn list_queries(&self) -> Result<Vec<QueryRow>> {
        self.storage.list_queries()
    }

    pub fn list_queries_with_limit(&self, limit: Option<usize>) -> Result<Vec<QueryRow>> {
        self.storage.list_queries_with_limit(limit)
    }

    pub fn list_query_groups(&self, limit: usize) -> Result<Vec<QueryGroup>> {
        self.storage.list_query_groups(limit)
    }

    pub fn delete_query(&self, id: &str, group_id: Option<&str>) -> Result<()> {
        self.storage.delete_query(id, group_id)
    }

    pub fn prune_queries_history(&self, max_history: usize) -> Result<usize> {
        self.storage.prune_queries_history(max_history)
    }

    pub fn save_query(
        &self,
        id: Option<&str>,
        name: &str,
        sql: &str,
        conn_id: Option<&str>,
        db: Option<&str>,
    ) -> Result<String> {
        self.storage.save_query(id, name, sql, conn_id, db)
    }

    // --- Knowledge base (ADR-AI-6) -----------------------------------------

    pub fn add_kb_doc(&self, name: &str, content: &str) -> Result<String> {
        self.storage.add_kb_doc(name, content)
    }
    pub fn update_kb_doc(&self, id: &str, name: &str, content: &str) -> Result<()> {
        self.storage.update_kb_doc(id, name, content)
    }
    pub fn list_kb_docs(&self) -> Result<Vec<crate::store::KbDoc>> {
        self.storage.list_kb_docs()
    }
    pub fn delete_kb_doc(&mut self, id: &str) -> Result<()> {
        self.storage.delete_kb_doc(id)
    }
    pub fn set_kb_bindings(
        &mut self,
        kb_id: &str,
        bindings: &[(String, Option<String>)],
    ) -> Result<()> {
        self.storage.set_kb_bindings(kb_id, bindings)
    }
    pub fn get_kb_bindings(&self, kb_id: &str) -> Result<Vec<crate::store::KbBinding>> {
        self.storage.get_kb_bindings(kb_id)
    }
    pub fn get_injected_kb_docs(
        &self,
        conn_id: &str,
        db: Option<&str>,
    ) -> Result<Vec<crate::store::KbDoc>> {
        self.storage.get_injected_kb_docs(conn_id, db)
    }
    pub fn add_kb_doc_with_binding(
        &mut self,
        name: &str,
        content: &str,
        conn_id: Option<&str>,
        db: Option<&str>,
    ) -> Result<String> {
        self.storage.add_kb_doc_with_binding(name, content, conn_id, db)
    }
    pub fn search_kb_docs(&self, conn_id: &str, db: Option<&str>, query: &str) -> Result<String> {
        self.storage.search_kb_docs(conn_id, db, query)
    }
    pub fn storage_mut(&mut self) -> &mut crate::store::Storage {
        &mut self.storage
    }

    // --- DB Memories 转发 ---
    pub fn add_memory(
        &self,
        conn_id: &str,
        database: Option<&str>,
        content: &str,
        source: &str,
        user_raw: &str,
    ) -> Result<crate::store::DbMemory> {
        self.storage.add_memory(conn_id, database, content, source, user_raw)
    }

    pub fn get_injected_memories(
        &self,
        conn_id: &str,
        database: Option<&str>,
        limit: usize,
    ) -> Result<Vec<crate::store::DbMemory>> {
        self.storage.get_injected_memories(conn_id, database, limit)
    }

    pub fn list_memories(
        &self,
        conn_id: &str,
        database: Option<&str>,
    ) -> Result<Vec<crate::store::DbMemory>> {
        self.storage.list_memories(conn_id, database)
    }

    pub fn list_all_memories(&self, limit: usize) -> Result<Vec<crate::store::DbMemory>> {
        self.storage.list_all_memories(limit)
    }

    pub fn update_memory(
        &self,
        id: &str,
        content: &str,
        database: Option<&str>,
    ) -> Result<crate::store::DbMemory> {
        self.storage.update_memory(id, content, database)
    }

    pub fn delete_memory(&self, id: &str) -> Result<()> {
        self.storage.delete_memory(id)
    }

    // --- Data Assistant (数据助手) 转发 ---
    pub fn list_data_assistants(&self) -> Result<Vec<crate::model::DataAssistant>> {
        self.storage.list_data_assistants()
    }
    pub fn get_data_assistant(&self, id: &str) -> Result<Option<crate::model::DataAssistant>> {
        self.storage.get_data_assistant(id)
    }
    pub fn save_data_assistant(&self, a: &crate::model::DataAssistant) -> Result<()> {
        self.storage.save_data_assistant(a)
    }
    pub fn delete_data_assistant(&self, id: &str) -> Result<()> {
        self.storage.delete_data_assistant(id)
    }
    pub fn get_kb_docs_by_ids(&self, ids: &[String]) -> Result<Vec<crate::store::KbDoc>> {
        self.storage.get_kb_docs_by_ids(ids)
    }

    pub fn list_db_scripts(&self) -> Result<Vec<crate::model::DbScript>> {
        self.storage.list_db_scripts()
    }
    pub fn get_db_script(&self, id: &str) -> Result<Option<crate::model::DbScript>> {
        self.storage.get_db_script(id)
    }
    pub fn save_db_script(&self, s: &crate::model::DbScript) -> Result<()> {
        self.storage.save_db_script(s)
    }
    pub fn delete_db_script(&self, id: &str) -> Result<()> {
        self.storage.delete_db_script(id)
    }
    pub fn get_scripts_for_connection(&self, conn_id: &str) -> Result<Vec<crate::model::DbScript>> {
        self.storage.get_scripts_for_connection(conn_id)
    }

    pub fn add_audit(
        &self,
        conn_id: &str,
        conn_name: &str,
        db: Option<&str>,
        sql: &str,
        decision: &str,
        result: Option<&str>,
    ) -> Result<()> {
        self.storage
            .add_audit(conn_id, conn_name, db, sql, decision, result)
    }
    pub fn list_audits(
        &self,
        limit: i64,
    ) -> Result<Vec<(String, Option<String>, String, String, Option<String>, i64)>> {
        self.storage.list_audits(limit)
    }

    // --- Conversations (docs/chat-conversation-design.md) ------------------

    pub fn list_conversations(&self) -> Result<Vec<crate::model::ConversationSummary>> {
        self.storage.list_conversations()
    }
    pub fn create_conversation(
        &self,
        conn_id: Option<&str>,
        title: Option<&str>,
    ) -> Result<String> {
        self.storage.create_conversation(conn_id, title)
    }
    pub fn rename_conversation(&self, id: &str, title: &str) -> Result<()> {
        self.storage.rename_conversation(id, title)
    }
    pub fn delete_conversation(&mut self, id: &str) -> Result<()> {
        self.storage.delete_conversation(id)
    }
    pub fn get_conversation(
        &self,
        id: &str,
        offset: i64,
        limit: i64,
    ) -> Result<(
        crate::model::ConversationSummary,
        Vec<crate::model::StoredChatMessage>,
    )> {
        self.storage.get_conversation(id, offset, limit)
    }
    pub fn append_chat_messages(
        &mut self,
        conv_id: &str,
        messages: &[crate::model::NewChatMessage],
    ) -> Result<()> {
        self.storage.append_chat_messages(conv_id, messages)
    }
    /// Title + trailing messages for cross-conversation injection (#226).
    pub fn get_recent_conv(
        &self,
        conv_id: &str,
        n: i64,
    ) -> Result<Option<(String, Vec<crate::model::StoredChatMessage>)>> {
        self.storage.get_recent_conv(conv_id, n)
    }

    // --- Container CRUD (ADR-016) -----------------------------------------

    pub fn create_env(&mut self, name: &str, db_type: Option<DbType>) -> Result<String> {
        let id = self
            .storage
            .create_container(ContainerKind::Env, name, None, db_type)?;
        self.containers.push(Container {
            id: id.clone(),
            kind: ContainerKind::Env,
            name: name.to_string(),
            db_type,
            parent: None,
            ord: 0,
        });
        Ok(id)
    }

    pub fn create_group(&mut self, env_id: &str, name: &str) -> Result<String> {
        if !self
            .containers
            .iter()
            .any(|c| c.kind == ContainerKind::Env && c.id == env_id)
        {
            return Err(crate::error::AppError::Msg(format!(
                "环境不存在: {}",
                env_id
            )));
        }
        let id = self
            .storage
            .create_container(ContainerKind::Group, name, Some(env_id), None)?;
        self.containers.push(Container {
            id: id.clone(),
            kind: ContainerKind::Group,
            name: name.to_string(),
            db_type: None,
            parent: Some(env_id.to_string()),
            ord: 0,
        });
        Ok(id)
    }

    /// Find an environment by (name, db_type), creating it if missing. Used by
    /// import so connections merge into existing containers instead of
    /// duplicating them.
    pub fn ensure_env(&mut self, name: &str, db_type: Option<DbType>) -> Result<String> {
        let matches: Vec<_> = self
            .containers
            .iter()
            .filter(|c| c.kind == ContainerKind::Env && c.name == name && c.db_type == db_type)
            .collect();
        match matches.as_slice() {
            [c] => Ok(c.id.clone()),
            [] => self.create_env(name, db_type),
            _ => Err(crate::error::AppError::Msg(format!(
                "环境名称 '{}' 存在重名，请使用环境 ID",
                name
            ))),
        }
    }

    /// Find a group by (env, name), creating it if missing.
    pub fn ensure_group(&mut self, env_id: &str, name: &str) -> Result<String> {
        let matches: Vec<_> = self
            .containers
            .iter()
            .filter(|c| {
                c.kind == ContainerKind::Group
                    && c.parent.as_deref() == Some(env_id)
                    && c.name == name
            })
            .collect();
        match matches.as_slice() {
            [c] => Ok(c.id.clone()),
            [] => self.create_group(env_id, name),
            _ => Err(crate::error::AppError::Msg(format!(
                "分组名称 '{}' 在该环境下存在重名，请使用分组 ID",
                name
            ))),
        }
    }

    pub fn rename_container(&mut self, id: &str, name: &str) -> Result<()> {
        self.storage.rename_container(id, name)?;
        if let Some(c) = self.containers.iter_mut().find(|c| c.id == id) {
            c.name = name.to_string();
        }
        Ok(())
    }

    /// Delete a container. Refuses (Err) if it still holds groups or
    /// connections, so we never orphan a connection or a sub-group.
    pub fn delete_container(&mut self, id: &str) -> Result<()> {
        let target = self
            .containers
            .iter()
            .find(|c| c.id == id)
            .cloned()
            .ok_or_else(|| crate::error::AppError::Msg(format!("容器不存在: {}", id)))?;
        match target.kind {
            ContainerKind::Env => {
                let child_groups: Vec<&str> = self
                    .containers
                    .iter()
                    .filter(|c| c.kind == ContainerKind::Group && c.parent.as_deref() == Some(id))
                    .map(|c| c.id.as_str())
                    .collect();
                if !child_groups.is_empty() {
                    return Err(crate::error::AppError::Msg(
                        "该环境还有分组，请先删除分组".into(),
                    ));
                }
                let used = self.connections.iter().any(|c| {
                    child_groups
                        .iter()
                        .any(|g| c.group_id.as_deref() == Some(g))
                });
                if used {
                    return Err(crate::error::AppError::Msg(
                        "该环境还有连接，请先移除连接".into(),
                    ));
                }
            }
            ContainerKind::Group => {
                if self
                    .connections
                    .iter()
                    .any(|c| c.group_id.as_deref() == Some(id))
                {
                    return Err(crate::error::AppError::Msg(
                        "该分组还有连接，请先移除连接".into(),
                    ));
                }
            }
        }
        self.storage.delete_container(id)?;
        self.containers.retain(|c| c.id != id);
        Ok(())
    }

    pub fn delete_topology_force(
        &mut self,
        connection_ids: &[String],
        container_ids: &[String],
    ) -> Result<()> {
        self.storage
            .delete_topology_atomic(connection_ids, container_ids)?;
        self.connections
            .retain(|c| !connection_ids.iter().any(|id| id == &c.id));
        self.containers
            .retain(|c| !container_ids.iter().any(|id| id == &c.id));
        Ok(())
    }
}

/// Find an environment by name, creating it (and recording it) if missing.
fn ensure_env(
    containers: &mut Vec<Container>,
    storage: &Storage,
    name: &str,
    db_type: DbType,
) -> Result<String> {
    if let Some(c) = containers
        .iter()
        .find(|c| c.kind == ContainerKind::Env && c.name == name && c.db_type == Some(db_type))
    {
        return Ok(c.id.clone());
    }
    let id = storage.create_container(ContainerKind::Env, name, None, Some(db_type))?;
    containers.push(Container {
        id: id.clone(),
        kind: ContainerKind::Env,
        name: name.to_string(),
        db_type: Some(db_type),
        parent: None,
        ord: 0,
    });
    Ok(id)
}

/// Find a group by (env, name), creating it if missing.
fn ensure_group(
    containers: &mut Vec<Container>,
    storage: &Storage,
    env_id: &str,
    name: &str,
) -> Result<String> {
    if let Some(c) = containers.iter().find(|c| {
        c.kind == ContainerKind::Group && c.parent.as_deref() == Some(env_id) && c.name == name
    }) {
        return Ok(c.id.clone());
    }
    let id = storage.create_container(ContainerKind::Group, name, Some(env_id), None)?;
    containers.push(Container {
        id: id.clone(),
        kind: ContainerKind::Group,
        name: name.to_string(),
        db_type: None,
        parent: Some(env_id.to_string()),
        ord: 0,
    });
    Ok(id)
}

fn gen_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("c{:x}", n)
}
