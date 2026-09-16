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
    #[serde(default)]
    format: String,
    #[serde(default)]
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
#[derive(Serialize, Default, Debug)]
pub struct ImportResult {
    /// Connections successfully added (ids regenerated, passwords re-encrypted).
    pub connections_added: usize,
    /// Connections updated/deduplicated (existing connection matched and updated).
    #[serde(default)]
    pub connections_updated: usize,
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
    let mut exported_conn_ids: std::collections::HashSet<String> = std::collections::HashSet::new();

    // Grouped connections under each (db_type, env, group).
    for db_type in [DbType::Mysql, DbType::Redis] {
        let db_key = match db_type {
            DbType::Mysql => "mysql",
            DbType::Redis => "redis",
        };
        // 匹配属于当前 db_type 的环境（显式设置或根据子连接推导），
        // 或虽归属其他类型但子分组中实际包含当前 db_type 连接的环境（跨类型容错）。
        let envs: Vec<&Container> = containers
            .iter()
            .filter(|c| {
                if c.kind != ContainerKind::Env {
                    return false;
                }
                if effective_env_db_type(c, containers, conns) == db_type {
                    return true;
                }
                let group_ids: Vec<&str> = containers
                    .iter()
                    .filter(|g| g.kind == ContainerKind::Group && g.parent.as_deref() == Some(&c.id))
                    .map(|g| g.id.as_str())
                    .collect();
                conns.iter().any(|conn| {
                    conn.db_type == db_type
                        && conn
                            .group_id
                            .as_deref()
                            .map_or(false, |gid| group_ids.contains(&gid))
                })
            })
            .collect();

        let mut db_tree = DbTree { envs: vec![] };
        for env in envs {
            let is_primary_env = effective_env_db_type(env, containers, conns) == db_type;
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
                let mut gconns = Vec::new();
                for c in conns
                    .iter()
                    .filter(|c| c.db_type == db_type && c.group_id.as_deref() == Some(&g.id))
                {
                    exported_conn_ids.insert(c.id.clone());
                    gconns.push(to_conn_export(c, cipher, k.as_ref()));
                }
                // 保留有连接的分组；若该环境本身即为主类型，亦保留空分组以保持拓扑结构
                if !gconns.is_empty() || is_primary_env {
                    env_exp.groups.push(GroupExport {
                        name: g.name.clone(),
                        connections: gconns,
                    });
                }
            }
            if !env_exp.groups.is_empty() || is_primary_env {
                db_tree.envs.push(env_exp);
            }
        }
        // 全量兜底保障：当前 db_type 下尚未被任何环境/分组导出的连接
        // （包括 group_id 为 None 的未分组连接、孤儿连接或层级断链连接），
        // 统统作为 UNGROUPED 导出，绝对不漏掉任何一个连接。
        let unexported_conns: Vec<&ConnectionConfig> = conns
            .iter()
            .filter(|c| c.db_type == db_type && !exported_conn_ids.contains(&c.id))
            .collect();
        let unexported: Vec<ConnExport> = unexported_conns
            .into_iter()
            .map(|c| {
                exported_conn_ids.insert(c.id.clone());
                to_conn_export(c, cipher, k.as_ref())
            })
            .collect();
        if !unexported.is_empty() {
            db_tree.envs.push(EnvExport {
                name: UNGROUPED.into(),
                groups: vec![GroupExport {
                    name: UNGROUPED.into(),
                    connections: unexported,
                }],
            });
        }
        if !db_tree.envs.is_empty() {
            root.dbs.insert(db_key.to_string(), db_tree);
        }
    }

    serde_yaml::to_string(&root).map_err(|e| AppError::Msg(format!("yaml 序列化失败: {}", e)))
}

/// Helper to determine an environment's effective DbType (ADR-022 compatible).
fn effective_env_db_type(
    env: &Container,
    containers: &[Container],
    conns: &[ConnectionConfig],
) -> DbType {
    if let Some(dt) = env.db_type {
        return dt;
    }
    // 兼容缺失 db_type 的旧容器：检查该环境下的所有连接
    let group_ids: Vec<&str> = containers
        .iter()
        .filter(|g| g.kind == ContainerKind::Group && g.parent.as_deref() == Some(&env.id))
        .map(|g| g.id.as_str())
        .collect();
    let env_conns: Vec<&ConnectionConfig> = conns
        .iter()
        .filter(|c| c.group_id.as_deref().map_or(false, |gid| group_ids.contains(&gid)))
        .collect();
    let has_redis = env_conns.iter().any(|c| c.db_type == DbType::Redis);
    let has_mysql = env_conns.iter().any(|c| c.db_type == DbType::Mysql);
    if has_redis && !has_mysql {
        DbType::Redis
    } else {
        DbType::Mysql
    }
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

/// Import connections from external tools (Navicat, DataGrip, JDBC/URIs) into the store.
pub fn import_external(store: &mut ConnectionStore, text: &str) -> Result<ImportResult> {
    let ext_conns = crate::db::external_import::parse_external_connections(text)?;
    let containers_before = store.list_containers().len();
    let mut result = ImportResult::default();

    for ce in ext_conns {
        // Required-field validation
        // Redis 通常无用户名（user 为空），故仅校验 name 与 host；MySQL 校验 name、host 与 user。
        let missing_required = ce.name.trim().is_empty()
            || ce.host.trim().is_empty()
            || (ce.db_type == DbType::Mysql && ce.user.trim().is_empty());
        if missing_required {
            result.skipped.push(ce.name.clone());
            continue;
        }

        let env_name = ce.env.as_deref().unwrap_or("外部导入");
        let group_name = ce.group.as_deref().unwrap_or("外部导入");

        let env_id = store.ensure_env(env_name, Some(ce.db_type))?;
        let group_id = Some(store.ensure_group(&env_id, group_name)?);

        let name = ce.name.trim().to_string();

        // 检查是否已有相同连接（同 group_id、同 db_type，且同名或物理端点完全相同）
        let existing = store.list().iter().find(|c| {
            c.db_type == ce.db_type
                && c.group_id == group_id
                && (c.name.trim() == name
                    || (!ce.host.trim().is_empty()
                        && c.host.trim() == ce.host.trim()
                        && c.port == ce.port
                        && c.user.trim() == ce.user.trim()
                        && c.database.trim() == ce.database.trim()))
        }).cloned();

        let (final_password, need_pw) = if !ce.password.trim().is_empty() {
            (ce.password.clone(), false)
        } else if let Some(ref ext) = existing {
            if !ext.password.trim().is_empty() {
                (ext.password.clone(), false)
            } else {
                (String::new(), true)
            }
        } else {
            (String::new(), true)
        };

        let conn_id = existing.as_ref().map(|e| e.id.clone()).unwrap_or_else(|| gen_id("c"));
        let port = if ce.port == 0 { ce.db_type.default_port() } else { ce.port };

        let cfg = ConnectionConfig {
            id: conn_id,
            name: name.clone(),
            db_type: ce.db_type,
            host: ce.host.trim().to_string(),
            port,
            user: ce.user.trim().to_string(),
            password: final_password,
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

        if existing.is_some() {
            store.update(cfg)?;
            result.connections_updated += 1;
        } else {
            store.add(cfg)?;
            result.connections_added += 1;
        }
        if need_pw {
            result.passwords_needed.push(name);
        }
    }

    result.containers_added = store.list_containers().len() - containers_before;
    Ok(result)
}

/// Parse and merge YAML (with a JSON fallback or external Navicat/DataGrip/URI formats) into the store.
/// Connection ids are regenerated to avoid clashes; passwords are decrypted per `cipher` then
/// immediately re-encrypted at rest with the local K (so an imported plaintext
/// file still lands encrypted on disk). Returns a summary for the UI.
pub fn import_yaml(store: &mut ConnectionStore, text: &str) -> Result<ImportResult> {
    // Check if the input matches any external formats (Navicat XML/JSON, DataGrip XML, JDBC/URI)
    if crate::db::external_import::detect_external_format(text).is_some() {
        return import_external(store, text);
    }

    // Prefer YAML; fall back to JSON for old exports.
    let root: ExportRoot = match serde_yaml::from_str::<ExportRoot>(text) {
        Ok(r) => r,
        Err(yaml_err) => match serde_json::from_str::<ExportRoot>(text) {
            Ok(r) => r,
            Err(_) => {
                // If native YAML/JSON failed, try external parsing as a fallback
                if let Ok(res) = import_external(store, text) {
                    return Ok(res);
                }
                return Err(AppError::Msg(format!(
                    "无法解析文件（YAML/JSON/外部格式均失败）: {}",
                    yaml_err
                )));
            }
        },
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
            let db_type = if db_key.eq_ignore_ascii_case("redis") {
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
            let db_type = if c.db_type.eq_ignore_ascii_case("redis") {
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
        // 注意：MySQL 需要用户名，而 Redis 绝大部分场景没有用户名（user 为空），因此 Redis 仅校验 name 与 host。
        let missing_required = ce.name.trim().is_empty()
            || ce.host.trim().is_empty()
            || (db_type == DbType::Mysql && ce.user.trim().is_empty());
        if missing_required {
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

        let name = ce.name.trim().to_string();

        // 检查是否已有相同连接（同 group_id、同 db_type，且同名或物理端点完全相同）
        let existing = store.list().iter().find(|c| {
            c.db_type == db_type
                && c.group_id == group_id
                && (c.name.trim() == name
                    || (!ce.host.trim().is_empty()
                        && c.host.trim() == ce.host.trim()
                        && c.port == ce.port
                        && c.user.trim() == ce.user.trim()
                        && c.database.trim() == ce.database.trim()))
        }).cloned();

        let (final_password, need_pw) = if !password.trim().is_empty() {
            (password, false)
        } else if let Some(ref ext) = existing {
            if !ext.password.trim().is_empty() {
                (ext.password.clone(), false)
            } else {
                (String::new(), true)
            }
        } else {
            (String::new(), true)
        };

        let conn_id = existing.as_ref().map(|e| e.id.clone()).unwrap_or_else(|| gen_id("c"));
        let port = if ce.port == 0 { db_type.default_port() } else { ce.port };

        let cfg = ConnectionConfig {
            id: conn_id,
            name: name.clone(),
            db_type,
            host: ce.host.trim().to_string(),
            port,
            user: ce.user.trim().to_string(),
            password: final_password,
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

        if existing.is_some() {
            store.update(cfg)?;
            result.connections_updated += 1;
        } else {
            store.add(cfg)?;
            result.connections_added += 1;
        }
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

    /// `Storage::open()` resolves its path from `XDG_CONFIG_HOME`, a
    /// *process-wide* variable — but Rust runs tests on parallel threads. Two
    /// tests each pointing it at their own temp dir will clobber each other and
    /// silently open the wrong database. Serialise them.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Take the env lock at the top of any test that calls `temp_store`. The
    /// guard MUST stay alive for the whole test body — dropping it early
    /// re-opens the race. Kept separate from `temp_store` so a single test can
    /// build several stores; the mutex is not reentrant and locking per-store
    /// would deadlock on the second call.
    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        // Recover from poisoning: one failed test shouldn't cascade into
        // failures elsewhere that mask the real cause.
        ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Caller must already hold `env_lock()`.
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
        let _env = env_lock();
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
        let _env = env_lock();
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

    #[test]
    fn import_external_navicat_and_datagrip() {
        let _env = env_lock();
        let mut store = temp_store();

        // 1. Test Navicat import
        let navicat_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<Connections>
  <Connection ConnectionName="navicat_prod" ConnType="MYSQL" Host="1.2.3.4" Port="3306" UserName="root" Password="" Database="db_nv" />
</Connections>"#;
        let res_nv = import_yaml(&mut store, navicat_xml).expect("import navicat xml");
        assert_eq!(res_nv.connections_added, 1);
        assert_eq!(res_nv.passwords_needed, vec!["navicat_prod"]);

        // Verify stored connection
        let conns = store.list();
        let nv = conns.iter().find(|c| c.name == "navicat_prod").expect("found nv conn");
        assert_eq!(nv.host, "1.2.3.4");
        assert_eq!(nv.database, "db_nv");

        // 2. Test DataGrip import
        let datagrip_xml = r#"<component name="DataSourceManagerImpl">
  <data-source name="dg_mysql">
    <jdbc-url>jdbc:mysql://5.6.7.8:3306/db_dg</jdbc-url>
    <user-name>app_user</user-name>
  </data-source>
</component>"#;
        let res_dg = import_yaml(&mut store, datagrip_xml).expect("import datagrip xml");
        assert_eq!(res_dg.connections_added, 1);
        assert_eq!(res_dg.passwords_needed, vec!["dg_mysql"]);

        let conns = store.list();
        let dg = conns.iter().find(|c| c.name == "dg_mysql").expect("found dg conn");
        assert_eq!(dg.host, "5.6.7.8");
        assert_eq!(dg.user, "app_user");
        assert_eq!(dg.database, "db_dg");
    }

    fn make_test_conn(name: &str, db_type: DbType, host: &str, port: u16, group_id: Option<String>) -> ConnectionConfig {
        ConnectionConfig {
            id: gen_id("c"),
            name: name.into(),
            db_type,
            host: host.into(),
            port,
            user: "root".into(),
            password: "pw".into(),
            database: String::new(),
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
            group_id,
        }
    }

    #[test]
    fn export_all_connections_including_missing_db_type_and_orphans() {
        let _env = env_lock();
        let store = temp_store();

        // 1. 创建一个 db_type 为 None 的环境和分组（模拟老数据）
        let env_id = store.storage().create_container(ContainerKind::Env, "老MySQL环境", None, None).unwrap();
        let grp_id = store.storage().create_container(ContainerKind::Group, "老分组", Some(&env_id), None).unwrap();
        // 重新 load store 以便 containers 加载进入
        let storage = Storage::open().unwrap();
        let mut store = ConnectionStore::load(storage).unwrap();

        // 连接 1: 挂在老分组下
        store.add(make_test_conn("老环境连接", DbType::Mysql, "1.1.1.1", 3306, Some(grp_id))).unwrap();

        // 连接 2: 孤儿连接（group_id 指向不存在的容器）
        store.add(make_test_conn("孤儿连接", DbType::Mysql, "2.2.2.2", 3306, Some("non_existent_group".into()))).unwrap();

        // 连接 3: 未分组连接
        store.add(make_test_conn("未分组连接", DbType::Mysql, "3.3.3.3", 3306, None)).unwrap();

        // 连接 4: Redis 连接
        store.add(make_test_conn("Redis连接", DbType::Redis, "4.4.4.4", 6379, None)).unwrap();

        assert_eq!(store.list().len(), 4);

        // 导出并解析
        let yaml = export_yaml(&store, "none").unwrap();
        let root: ExportRoot = serde_yaml::from_str(&yaml).unwrap();

        // 统计导出的所有连接数
        let mut exported_names = Vec::new();
        for (_, tree) in &root.dbs {
            for env in &tree.envs {
                for g in &env.groups {
                    for c in &g.connections {
                        exported_names.push(c.name.clone());
                    }
                }
            }
        }

        assert_eq!(exported_names.len(), 4, "所有4个连接都必须被导出");
        assert!(exported_names.contains(&"老环境连接".to_string()));
        assert!(exported_names.contains(&"孤儿连接".to_string()));
        assert!(exported_names.contains(&"未分组连接".to_string()));
        assert!(exported_names.contains(&"Redis连接".to_string()));
    }

    #[test]
    fn import_yaml_deduplication_on_repeated_import() {
        let _env = env_lock();
        let mut store = temp_store();

        let yaml_sample = r#"
format: chatquery-connections
version: 2
cipher: none
mysql:
  envs:
    - name: 测试环境
      groups:
        - name: 业务库
          connections:
            - name: 订单主库
              host: 192.168.1.10
              port: 3306
              user: root
              password: mypassword123
              database: orders
            - name: 用户从库
              host: 192.168.1.11
              port: 3306
              user: readonly
              password: ropassword456
              database: users
"#;

        // 第一次导入：新增 2 个连接
        let res1 = import_yaml(&mut store, yaml_sample).unwrap();
        assert_eq!(res1.connections_added, 2);
        assert_eq!(res1.connections_updated, 0);
        assert_eq!(store.list().len(), 2);

        let orig_order_id = store.list().iter().find(|c| c.name == "订单主库").unwrap().id.clone();

        // 第二次重复导入完全相同的 YAML：应该全部去重更新，不新增任何连接
        let res2 = import_yaml(&mut store, yaml_sample).unwrap();
        assert_eq!(res2.connections_added, 0, "重复导入不应新增连接");
        assert_eq!(res2.connections_updated, 2, "重复导入应更新/去重已有连接");
        assert_eq!(store.list().len(), 2, "连接总数依然保持为 2，没有产生重复连接");

        let after_order = store.list().iter().find(|c| c.name == "订单主库").unwrap();
        assert_eq!(after_order.id, orig_order_id, "已有连接的 ID 应当保持不变");
        assert_eq!(after_order.password, "mypassword123");

        // 第三次导入：无密码的导出，本地已有密码不应被清空
        let yaml_no_pw = r#"
format: chatquery-connections
version: 2
cipher: none
mysql:
  envs:
    - name: 测试环境
      groups:
        - name: 业务库
          connections:
            - name: 订单主库
              host: 192.168.1.99
              port: 3306
              user: root
              password: ""
              database: orders
"#;
        let res3 = import_yaml(&mut store, yaml_no_pw).unwrap();
        assert_eq!(res3.connections_added, 0);
        assert_eq!(res3.connections_updated, 1);
        assert_eq!(store.list().len(), 2);

        let updated_order = store.list().iter().find(|c| c.name == "订单主库").unwrap();
        assert_eq!(updated_order.host, "192.168.1.99", "host 应该被更新");
        assert_eq!(updated_order.password, "mypassword123", "导入密码为空时应保留既有密码");
    }

    #[test]
    fn import_redis_connection_empty_user_and_uri() {
        let _env = env_lock();
        let mut store = temp_store();

        // 1. 导入空 user 且无 format/version 声明的 Redis YAML
        let redis_yaml = r#"
redis:
  envs:
    - name: 缓存环境
      groups:
        - name: Redis主群
          connections:
            - name: 开发环境redis
              host: 10.11.0.100
              port: 6379
              user: ""
              password: myredispassword
"#;

        let res = import_yaml(&mut store, redis_yaml).expect("import redis yaml should succeed");
        assert_eq!(res.connections_added, 1, "Redis 连接应成功添加，不能被跳过");
        assert_eq!(res.skipped.len(), 0, "不应有被跳过的连接");
        assert_eq!(store.list().len(), 1);

        let redis_conn = store.list().iter().find(|c| c.name == "开发环境redis").unwrap();
        assert_eq!(redis_conn.db_type, DbType::Redis);
        assert_eq!(redis_conn.host, "10.11.0.100");
        assert_eq!(redis_conn.port, 6379);
        assert_eq!(redis_conn.password, "myredispassword");

        // 2. 重复导入该 Redis YAML：成功去重更新
        let res_repeat = import_yaml(&mut store, redis_yaml).unwrap();
        assert_eq!(res_repeat.connections_added, 0, "重复导入不能新增");
        assert_eq!(res_repeat.connections_updated, 1, "应更新/去重既有连接");
        assert_eq!(store.list().len(), 1);

        // 3. 从纯 redis:// URI 连接串导入
        let uri_text = "redis://:tokenpass@192.168.2.50:6379/1";
        let res_uri = import_yaml(&mut store, uri_text).expect("import redis uri");
        assert_eq!(res_uri.connections_added, 1);
        assert_eq!(store.list().len(), 2);

        let uri_conn = store.list().iter().find(|c| c.host == "192.168.2.50").unwrap();
        assert_eq!(uri_conn.db_type, DbType::Redis);
        assert_eq!(uri_conn.port, 6379);
        assert_eq!(uri_conn.password, "tokenpass");
    }
}
