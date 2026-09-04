use crate::db::connection::DbType;
use serde::{Deserialize, Serialize};

/// A tree container: either an environment (top-level bucket) or a group
/// (nested under an environment). Promoted to a first-class entity in
/// ADR-016 so empty containers can exist independently of connections.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ContainerKind {
    Env,
    Group,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Container {
    pub id: String,
    pub kind: ContainerKind,
    pub name: String,
    /// Database type this environment is bound to (ADR-022). Lets an empty
    /// environment be placed under the correct root (MySQL/Redis) before it
    /// holds any connection. Only meaningful for environments; groups and
    /// legacy containers use None. Missing on disk ⇒ treated as MySQL.
    #[serde(default)]
    pub db_type: Option<DbType>,
    /// Parent environment id. Only meaningful for groups; envs use None.
    #[serde(default)]
    pub parent: Option<String>,
    /// Sort order within the parent. Display order falls back to insertion
    /// sequence when ties occur (ADR-016: reordering is a future nicety).
    #[serde(default)]
    pub ord: i64,
}

/// On-disk connection shape from the pre-container era (env/group were plain
/// string fields on the connection). Kept only so legacy encrypted blobs still
/// parse; `ConnectionStore::load` reads these strings, synthesizes real
/// containers, and migrates the connection onto `group_id`.
#[derive(Debug, Clone, Deserialize)]
pub struct LegacyConnection {
    pub id: String,
    pub name: String,
    pub db_type: crate::db::connection::DbType,
    pub host: String,
    pub port: u16,
    pub user: String,
    /// Persisted encrypted at rest; only ever held in plaintext in memory.
    pub password: String,
    pub database: String,
    #[serde(default)]
    pub ssl_mode: String,
    #[serde(default)]
    pub ssl_ca: String,
    #[serde(default)]
    pub client_cert: String,
    #[serde(default)]
    pub client_key: String,
    #[serde(default)]
    pub ssh_host: String,
    #[serde(default = "default_ssh_port")]
    pub ssh_port: u16,
    #[serde(default)]
    pub ssh_user: String,
    #[serde(default)]
    pub ssh_auth_kind: String,
    #[serde(default)]
    pub ssh_password: String,
    #[serde(default)]
    pub ssh_private_key: String,
    #[serde(default)]
    pub env: String,
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub group_id: Option<String>,
}

/// Time-based id generator (mirrors `connection::gen_id`). Prefix keeps ids
/// self-describing in logs.
fn default_ssh_port() -> u16 {
    22
}

pub fn gen_id(prefix: &str) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("{}{:x}", prefix, n)
}
