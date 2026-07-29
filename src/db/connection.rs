use crate::error::Result;
use crate::db::container::{Container, ContainerKind};
use crate::store::{QueryRow, Storage};
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
    /// First-class grouping reference (ADR-016). The connection belongs to the
    /// group whose id is stored here; the group's parent environment is found
    /// by walking the container tree. `None` means ungrouped (rendered under a
    /// synthetic "未分组" bucket). `serde(default)` keeps legacy blobs (which
    /// carried `env`/`group` strings instead) loadable — the migration in
    /// `ConnectionStore::load` synthesizes containers and fills this in.
    #[serde(default)]
    pub group_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DbType {
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
                    let env_id = ensure_env(&mut containers, &storage, env_name)?;
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
                group_id: Some(group_id),
            });
        }
        // Persist migrated connections so group_id survives a reload.
        if dirty {
            for c in &connections {
                storage.upsert_connection(c)?;
            }
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

    // --- Query history / saved snippets ----------------------------------

    pub fn log_query(&self, conn_id: Option<&str>, db: Option<&str>, sql: &str) -> Result<()> {
        self.storage.log_query(conn_id, db, sql)
    }

    pub fn list_queries(&self) -> Result<Vec<QueryRow>> {
        self.storage.list_queries()
    }

    pub fn save_query(
        &self,
        id: Option<&str>,
        name: &str,
        sql: &str,
        conn_id: Option<&str>,
        db: Option<&str>,
    ) -> Result<String> {
        self.storage
            .save_query(id, name, sql, conn_id, db)
    }

    pub fn delete_query(&self, id: &str) -> Result<()> {
        self.storage.delete_query(id)
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
        if !self.containers.iter().any(|c| {
            c.kind == ContainerKind::Env && c.id == env_id
        }) {
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
                let used = self
                    .connections
                    .iter()
                    .any(|c| child_groups.iter().any(|g| c.group_id.as_deref() == Some(g)));
                if used {
                    return Err(crate::error::AppError::Msg(
                        "该环境还有连接，请先移除连接".into(),
                    ));
                }
            }
            ContainerKind::Group => {
                if self.connections.iter().any(|c| c.group_id.as_deref() == Some(id)) {
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
}

/// Find an environment by name, creating it (and recording it) if missing.
fn ensure_env(
    containers: &mut Vec<Container>,
    storage: &Storage,
    name: &str,
) -> Result<String> {
    if let Some(c) = containers
        .iter()
        .find(|c| c.kind == ContainerKind::Env && c.name == name)
    {
        return Ok(c.id.clone());
    }
    let id = storage.create_container(ContainerKind::Env, name, None, None)?;
    containers.push(Container {
        id: id.clone(),
        kind: ContainerKind::Env,
        name: name.to_string(),
        db_type: None,
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
        c.kind == ContainerKind::Group
            && c.parent.as_deref() == Some(env_id)
            && c.name == name
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
