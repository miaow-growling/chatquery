//! Connection import / export / template — YAML, cross-machine safe (#1, #2).
//!
//! Unified file format (`version: 2`): a four-level, self-describing tree
//! `db_type → envs → groups → connections` that mirrors the in-app connection
//! tree (environments / groups are first-class containers per ADR-016/022).
//! A legacy flat `connections:` list (`version: 1`) is still accepted and
//! normalised on import.
//!
//! Cipher (top-level, applies to every password in the file):
//! - `system-key`: passwords are AES-GCM ciphertext under the configurable key
//!   K (see `crypto`). The same key field on the importing machine decrypts
//!   them — this is the cross-machine mechanism (#0) and the default path.
//! - `none`: passwords are stored in plaintext. High-risk; the UI must warn
//!   loudly and only use it on explicit opt-in.

use crate::crypto;
use crate::db::connection::{ConnectionConfig, DbType};
use crate::db::container::{gen_id, Container, ContainerKind};
use crate::error::{AppError, Result};
use crate::db::connection::ConnectionStore;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const EXPORT_FORMAT: &str = "chatquery-connections";
const EXPORT_VERSION: u32 = 2;

/// Marker for ungrouped connections in the export tree (mirrors the app's
/// synthetic "未分组" bucket). On import, an env/group by this name is *not*
/// materialised as a real container — its connections stay ungrouped.
const UNGROUPED: &str = "__ungrouped";

// ---------------------------------------------------------------------------
// YAML shapes
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
struct ExportRoot {
    format: String,
    version: u32,
    /// "system-key" | "none". Missing ⇒ treated as "none" (plaintext).
    #[serde(default)]
    cipher: String,
    /// v2: one entry per db_type (`mysql` / `redis`) keyed by that name.
    #[serde(flatten)]
    dbs: HashMap<String, DbTree>,
    /// v1 fallback: a flat list of connections (each carrying its own
    /// `db_type` / `env` / `group` strings). Ignored when `dbs` is non-empty.
    #[serde(default)]
    connections: Option<Vec<ConnExport>>,
}

#[derive(Serialize, Deserialize, Default)]
struct DbTree {
    #[serde(default)]
    envs: Vec<EnvExport>,
}

#[derive(Serialize, Deserialize)]
struct EnvExport {
    name: String,
    #[serde(default)]
    groups: Vec<GroupExport>,
}

#[derive(Serialize, Deserialize)]
struct GroupExport {
    name: String,
    #[serde(default)]
    connections: Vec<ConnExport>,
}

/// A single connection as it appears in the YAML file. Field-for-field with
/// `ConnectionConfig` except for the optional `db_type` / `env` / `group`
/// strings, which only matter for the v1 flat format.
#[derive(Serialize, Deserialize, Clone, Default)]
struct ConnExport {
    name: String,
    host: String,
    port: u16,
    user: String,
    password: String,
    #[serde(default)]
    database: String,
    #[serde(default)]
    db_type: String,
    #[serde(default)]
    env: String,
    #[serde(default)]
    group: String,
    #[serde(default)]
    ssl_mode: String,
    #[serde(default)]
    ssl_ca: String,
    #[serde(default)]
    client_cert: String,
    #[serde(default)]
    client_key: String,
    #[serde(default)]
    ssh_host: String,
    #[serde(default)]
    ssh_port: u16,
    #[serde(default)]
    ssh_user: String,
    #[serde(default)]
    ssh_auth_kind: String,
    #[serde(default)]
    ssh_password: String,
    #[serde(default)]
    ssh_private_key: String,
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/// Outcome of an import, surfaced to the UI for a summary toast.
#[derive(Serialize, Default)]
pub struct ImportResult {
    /// Connections successfully added (ids regenerated, passwords re-encrypted).
    pub connections_added: usize,
    /// Environments + groups created to host the imported connections.
    pub containers_added: usize,
    /// Names of connections whose (decrypted) password is empty — the user
    /// must fill these in before they can connect.
    pub passwords_needed: Vec<String>,
    /// Names skipped because a required field (name/host/user) was empty.
    pub skipped: Vec<String>,
    /// Non-fatal notices (e.g. a placeholder value was detected).
    pub warnings: Vec<String>,
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/// Serialise the whole tree (containers + connections) to a YAML string.
/// `cipher` selects how passwords are written:
/// - `"system-key"` → AES-GCM under K (cross-machine portable).
/// - `"none"` → plaintext (high-risk; the caller/UI owns the warning).
pub fn export_yaml(store: &ConnectionStore, cipher: &str) -> Result<String> {
    if cipher != "system-key" && cipher != "none" {
        return Err(AppError::Msg(format!("未知 cipher: {}", cipher)));
    }
    // For system-key we encrypt with the *current* K (load_encryption_key).
    let k = if cipher == "system-key" {
        Some(crypto::load_encryption_key()?)
    } else {
        None
    };

    let mut root = ExportRoot {
        format: EXPORT_FORMAT.into(),
        version: EXPORT_VERSION,
        cipher: cipher.to_string(),
        dbs: HashMap::new(),
        connections: None,
    };

    let containers = store.list_containers();
    let conns = store.list();

    // Grouped connections under each (db_type, env, group).
    for db_type in [DbType::Mysql, DbType::Redis] {
        let db_key = match db_type {
            DbType::Mysql => "mysql",
            DbType::Redis => "redis",
        };
        let envs: Vec<&Container> = containers
            .iter()
            .filter(|c| c.kind == ContainerKind::Env && c.db_type == Some(db_type))
            .collect();
        let mut db_tree = DbTree { envs: vec![] };
        for env in envs {
            let mut env_exp = EnvExport {
                name: env.name.clone(),
                groups: vec![],
            };
            let groups: Vec<&Container> = containers
                .iter()
                .filter(|c| {
                    c.kind == ContainerKind::Group && c.parent.as_deref() == Some(&env.id)
                })
                .collect();
            for g in groups {
                let gconns: Vec<ConnExport> = conns
                    .iter()
                    .filter(|c| c.db_type == db_type && c.group_id.as_deref() == Some(&g.id))
                    .map(|c| to_conn_export(c, cipher, k.as_ref()))
                    .collect();
                env_exp.groups.push(GroupExport {
                    name: g.name.clone(),
                    connections: gconns,
                });
            }
            db_tree.envs.push(env_exp);
        }
        // Ungrouped connections (group_id == None) for this db_type → synthetic
        // env/group named UNGROUPED so they round-trip as ungrouped.
        let ungrouped: Vec<ConnExport> = conns
            .iter()
            .filter(|c| c.db_type == db_type && c.group_id.is_none())
            .map(|c| to_conn_export(c, cipher, k.as_ref()))
            .collect();
        if !ungrouped.is_empty() {
            db_tree.envs.push(EnvExport {
                name: UNGROUPED.into(),
                groups: vec![GroupExport {
                    name: UNGROUPED.into(),
                    connections: ungrouped,
                }],
            });
        }
        if !db_tree.envs.is_empty() {
            root.dbs.insert(db_key.to_string(), db_tree);
        }
    }

    serde_yaml::to_string(&root).map_err(|e| AppError::Msg(format!("yaml 序列化失败: {}", e)))
}

fn to_conn_export(c: &ConnectionConfig, cipher: &str, k: Option<&[u8; 32]>) -> ConnExport {
    let password = match cipher {
        "system-key" => k
            .and_then(|key| crypto::encrypt(&c.password, key).ok())
            .unwrap_or_default(),
        _ => c.password.clone(),
    };
    ConnExport {
        name: c.name.clone(),
        host: c.host.clone(),
        port: c.port,
        user: c.user.clone(),
        password,
        database: c.database.clone(),
        db_type: String::new(),
        env: String::new(),
        group: String::new(),
        ssl_mode: c.ssl_mode.clone(),
        ssl_ca: c.ssl_ca.clone(),
        client_cert: c.client_cert.clone(),
        client_key: c.client_key.clone(),
        ssh_host: c.ssh_host.clone(),
        ssh_port: c.ssh_port,
        ssh_user: c.ssh_user.clone(),
        ssh_auth_kind: c.ssh_auth_kind.clone(),
        ssh_password: c.ssh_password.clone(),
        ssh_private_key: c.ssh_private_key.clone(),
    }
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/// Parse and merge YAML (with a JSON fallback) into the store. Connection ids
/// are regenerated to avoid clashes; passwords are decrypted per `cipher` then
/// immediately re-encrypted at rest with the local K (so an imported plaintext
/// file still lands encrypted on disk). Returns a summary for the UI.
pub fn import_yaml(store: &mut ConnectionStore, text: &str) -> Result<ImportResult> {
    // Prefer YAML; fall back to JSON for old exports.
    let root: ExportRoot = match serde_yaml::from_str::<ExportRoot>(text) {
        Ok(r) => r,
        Err(_) => serde_json::from_str::<ExportRoot>(text)
            .map_err(|e| AppError::Msg(format!("无法解析文件（YAML/JSON 均失败）: {}", e)))?,
    };

    let cipher = if root.cipher.is_empty() { "none" } else { root.cipher.as_str() };
    let k = if cipher == "system-key" {
        Some(crypto::load_encryption_key()?)
    } else {
        None
    };

    // Normalise both v2 (dbs tree) and v1 (flat list) into one flat list of
    // (db_type, env_name, group_name, ConnExport) tuples. `None` env/group ⇒
    // ungrouped.
    let mut norm: Vec<(DbType, Option<String>, Option<String>, ConnExport)> = Vec::new();
    if !root.dbs.is_empty() {
        for (db_key, tree) in &root.dbs {
            let db_type = if db_key == "redis" {
                DbType::Redis
            } else {
                DbType::Mysql
            };
            for env in &tree.envs {
                let env_name = if env.name == UNGROUPED {
                    None
                } else {
                    Some(env.name.clone())
                };
                for g in &env.groups {
                    let group_name = if g.name == UNGROUPED {
                        None
                    } else {
                        Some(g.name.clone())
                    };
                    for c in &g.connections {
                        norm.push((db_type, env_name.clone(), group_name.clone(), c.clone()));
                    }
                }
            }
        }
    } else if let Some(list) = &root.connections {
        for c in list {
            let db_type = if c.db_type == "redis" {
                DbType::Redis
            } else {
                DbType::Mysql
            };
            let env_name = if c.env.trim().is_empty() {
                None
            } else {
                Some(c.env.trim().to_string())
            };
            let group_name = if c.group.trim().is_empty() {
                None
            } else {
                Some(c.group.trim().to_string())
            };
            norm.push((db_type, env_name, group_name, c.clone()));
        }
    } else {
        return Err(AppError::Msg(
            "文件结构无法识别：缺少 mysql/redis 子树或 connections 列表".into(),
        ));
    }

    let containers_before = store.list_containers().len();
    let mut result = ImportResult::default();

    for (db_type, env_name, group_name, ce) in norm {
        // Required-field validation (lightweight; #2).
        if ce.name.trim().is_empty() || ce.host.trim().is_empty() || ce.user.trim().is_empty() {
            result.skipped.push(ce.name.clone());
            continue;
        }
        // Placeholder detection → warning, not a block.
        if is_placeholder(&ce.password) || is_placeholder(&ce.host) {
            result
                .warnings
                .push(format!("连接「{}」疑似含占位符，请检查后修正", ce.name));
        }

        // Resolve / create the container path. Ungrouped (None env) ⇒ no env.
        let group_id = match (&env_name, &group_name) {
            (None, _) => None, // ungrouped: no container
            (Some(env), None) => {
                let env_id = store.ensure_env(env, Some(db_type))?;
                // A connection directly under an env (no group) → put it in a
                // synthetic UNGROUPED group so it has a real group_id.
                Some(store.ensure_group(&env_id, UNGROUPED)?)
            }
            (Some(env), Some(grp)) => {
                let env_id = store.ensure_env(env, Some(db_type))?;
                Some(store.ensure_group(&env_id, grp)?)
            }
        };

        // Decrypt the password for this cipher.
        let password = match cipher {
            "system-key" => match k.and_then(|key| crypto::decrypt(&ce.password, &key).ok()) {
                Some(p) => p,
                None => {
                    return Err(AppError::Msg(
                        "密钥不匹配：无法解密连接密码。请在系统配置填入导出时使用的加密密钥后重新导入"
                            .into(),
                    ))
                }
            },
            _ => ce.password.clone(),
        };

        let cfg = ConnectionConfig {
            id: gen_id("c"),
            name: ce.name.trim().to_string(),
            db_type,
            host: ce.host.trim().to_string(),
            port: ce.port,
            user: ce.user.trim().to_string(),
            password,
            database: ce.database.trim().to_string(),
            ssl_mode: ce.ssl_mode.trim().to_string(),
            ssl_ca: ce.ssl_ca.trim().to_string(),
            client_cert: ce.client_cert.trim().to_string(),
            client_key: ce.client_key.trim().to_string(),
            ssh_host: ce.ssh_host.trim().to_string(),
            ssh_port: ce.ssh_port,
            ssh_user: ce.ssh_user.trim().to_string(),
            ssh_auth_kind: ce.ssh_auth_kind.trim().to_string(),
            ssh_password: ce.ssh_password.clone(),
            ssh_private_key: ce.ssh_private_key.clone(),
            group_id,
        };
        let need_pw = cfg.password.is_empty();
        let name = cfg.name.clone();
        store.add(cfg)?;
        result.connections_added += 1;
        if need_pw {
            result.passwords_needed.push(name);
        }
    }

    result.containers_added = store.list_containers().len() - containers_before;
    Ok(result)
}

/// True when a value looks like an unfilled template placeholder.
fn is_placeholder(v: &str) -> bool {
    let s = v.trim();
    if s.is_empty() {
        return false;
    }
    s.starts_with("{{")
        || s.ends_with("}}")
        || s.eq_ignore_ascii_case("CHANGE_ME")
        || s.contains("请填")
        || s.eq_ignore_ascii_case("example.com")
        || s.eq_ignore_ascii_case("请改名")
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

/// A ready-to-edit template: one placeholder connection under a sample env/group
/// so the user can copy the block to batch-create connections (#2). Plaintext
/// (`cipher: none`) — the UI warns on download and import.
pub fn export_template() -> String {
    let mut root = ExportRoot {
        format: EXPORT_FORMAT.into(),
        version: EXPORT_VERSION,
        cipher: "none".into(),
        dbs: HashMap::new(),
        connections: None,
    };
    let mut mysql = DbTree { envs: vec![] };
    mysql.envs.push(EnvExport {
        name: "生产环境".into(),
        groups: vec![GroupExport {
            name: "订单库".into(),
            connections: vec![ConnExport {
                name: "示例连接-请改名".into(),
                host: "127.0.0.1".into(),
                port: 3306,
                user: "root".into(),
                password: "请填密码".into(),
                database: "mydb".into(),
                db_type: String::new(),
                env: String::new(),
                group: String::new(),
                ssl_mode: "disabled".into(),
                ..Default::default()
            }],
        }],
    });
    root.dbs.insert("mysql".into(), mysql);
    serde_yaml::to_string(&root).expect("template is a fixed, valid structure")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::connection::ConnectionStore;
    use crate::store::Storage;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp() -> std::path::PathBuf {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let p = std::env::temp_dir().join(format!("cqtest_{}", n));
        let _ = std::fs::create_dir_all(&p);
        p
    }

    fn temp_store() -> ConnectionStore {
        let dir = unique_temp();
        std::env::set_var("XDG_CONFIG_HOME", &dir);
        let storage = Storage::open().unwrap();
        ConnectionStore::load(storage).unwrap()
    }

    #[test]
    fn template_is_valid_yaml_with_plaintext_cipher() {
        let t = export_template();
        let root: ExportRoot = serde_yaml::from_str(&t).unwrap();
        assert_eq!(root.format, "chatquery-connections");
        assert_eq!(root.version, 2);
        assert_eq!(root.cipher, "none");
        let mysql = root.dbs.get("mysql").unwrap();
        assert_eq!(mysql.envs.len(), 1);
        assert_eq!(mysql.envs[0].groups[0].connections[0].name, "示例连接-请改名");
    }

    #[test]
    fn export_import_roundtrip_none_cipher() {
        let mut store = temp_store();
        let cfg = ConnectionConfig {
            id: gen_id("c"),
            name: "主库".into(),
            db_type: DbType::Mysql,
            host: "10.0.0.1".into(),
            port: 3306,
            user: "dba".into(),
            password: "s3cret".into(),
            database: "orders".into(),
            ssl_mode: String::new(),
            ssl_ca: String::new(),
            client_cert: String::new(),
            client_key: String::new(),
            ssh_host: String::new(),
            ssh_port: 22,
            ssh_user: String::new(),
            ssh_auth_kind: String::new(),
            ssh_password: String::new(),
            ssh_private_key: String::new(),
            group_id: None,
        };
        store.add(cfg).unwrap();

        let yaml = export_yaml(&store, "none").unwrap();
        // Password should be plaintext in the YAML.
        assert!(yaml.contains("s3cret"));

        let mut store2 = temp_store();
        let before = store2.list().len();
        let res = import_yaml(&mut store2, &yaml).unwrap();
        assert_eq!(res.connections_added, 1);
        assert_eq!(store2.list().len(), before + 1);
        let imported = store2.list().iter().find(|c| c.name == "主库").unwrap();
        // Re-encrypted at rest with the local K, but in memory it's the real pw.
        assert_eq!(imported.password, "s3cret");
    }

    #[test]
    fn system_key_cipher_encrypts_password() {
        // With no key configured, K == KEK. Export under system-key must still
        // produce ciphertext (not the literal password) in the YAML.
        let store = temp_store();
        let cfg = ConnectionConfig {
            id: gen_id("c"),
            name: "密库".into(),
            db_type: DbType::Mysql,
            host: "10.0.0.2".into(),
            port: 3306,
            user: "u".into(),
            password: "topsecret".into(),
            database: "d".into(),
            ssl_mode: String::new(),
            ssl_ca: String::new(),
            client_cert: String::new(),
            client_key: String::new(),
            ssh_host: String::new(),
            ssh_port: 22,
            ssh_user: String::new(),
            ssh_auth_kind: String::new(),
            ssh_password: String::new(),
            ssh_private_key: String::new(),
            group_id: None,
        };
        // can't add without &mut; build a mutable copy
        let mut store = store;
        store.add(cfg).unwrap();
        let yaml = export_yaml(&store, "system-key").unwrap();
        assert!(!yaml.contains("topsecret"), "system-key 导出不应含明文密码");
    }
}
