use chatquery::crypto;
use chatquery::db::connection::{ConnectionConfig, DbType};
use chatquery::db::container::ContainerKind;
use chatquery::db::importexport::{
    export_template as export_template_yaml, export_yaml, import_yaml, ImportResult,
};
use chatquery::db::mysql::{
    ColumnInfo, ExplainVisual, ForeignKeyInfo, QueryResult, Schema, TableMeta, TableStructure,
};
use chatquery::llm::client::stream_chat;
use chatquery::llm::control::TurnControl;
use chatquery::model::BackendMsg;
use chatquery::model::{ChatMessage, ChatRole};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::time::timeout;

use crate::state::AppState;

/// 单条 ad-hoc 查询的服务端超时（秒）。兜底用：任何慢查询 / 卡死的网络
/// 都不会把前端 IPC 永久挂起，超时会以 Err 形式返回，UI 可正常提示。
const QUERY_TIMEOUT_SECS: u64 = 30;

// ---------------------------------------------------------------------------
// Frontend-facing DTOs (the Rust backend types are not all Serialize, so we
// translate at the boundary — keeps the wire contract stable and explicit).
// ---------------------------------------------------------------------------

/// Connection summary sent to the UI. Deliberately excludes `password` — the
/// secret stays in Rust and is never round-tripped to the frontend. Grouping
/// is now expressed as `group_id` (a first-class container, ADR-016); the UI
/// resolves the environment by walking containers.
#[derive(Serialize)]
pub struct ConnSummary {
    pub id: String,
    pub name: String,
    pub db_type: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: String,
    #[serde(default)]
    pub group_id: Option<String>,
}

/// Mutable connection input from the UI form.
#[derive(Deserialize)]
pub struct ConnInput {
    pub id: String,
    pub name: String,
    pub db_type: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub password: String,
    pub database: String,
    /// Group this connection belongs to (first-class container id). `None`
    /// means ungrouped.
    #[serde(default)]
    pub group_id: Option<String>,
    // --- SSL / TLS (#4) ---------------------------------------------------
    #[serde(default)]
    pub ssl_mode: String,
    #[serde(default)]
    pub ssl_ca: String,
    #[serde(default)]
    pub client_cert: String,
    #[serde(default)]
    pub client_key: String,
    // --- SSH tunnel / bastion (#5) ----------------------------------------
    #[serde(default)]
    pub ssh_host: String,
    #[serde(default)]
    pub ssh_port: u16,
    #[serde(default)]
    pub ssh_user: String,
    #[serde(default)]
    pub ssh_auth_kind: String,
    #[serde(default)]
    pub ssh_password: String,
    #[serde(default)]
    pub ssh_private_key: String,
}

/// A logged or saved query returned to the UI. `name` is None for auto-logged
/// history entries and Some for user-named snippets.
#[derive(Serialize)]
pub struct QueryItem {
    pub id: String,
    pub name: Option<String>,
    pub sql: String,
    pub conn_id: Option<String>,
    pub db: Option<String>,
    pub created: i64,
}

fn to_cfg(i: ConnInput) -> ConnectionConfig {
    ConnectionConfig {
        id: i.id,
        name: i.name,
        db_type: if i.db_type == "redis" {
            DbType::Redis
        } else {
            DbType::Mysql
        },
        host: i.host,
        port: i.port,
        user: i.user,
        password: i.password,
        database: i.database,
        group_id: i.group_id,
        ssl_mode: i.ssl_mode,
        ssl_ca: i.ssl_ca,
        client_cert: i.client_cert,
        client_key: i.client_key,
        ssh_host: i.ssh_host,
        ssh_port: i.ssh_port,
        ssh_user: i.ssh_user,
        ssh_auth_kind: i.ssh_auth_kind,
        ssh_password: i.ssh_password,
        ssh_private_key: i.ssh_private_key,
    }
}

/// Map a stored connection to its wire summary.
fn to_summary(c: &ConnectionConfig) -> ConnSummary {
    ConnSummary {
        id: c.id.clone(),
        name: c.name.clone(),
        db_type: match c.db_type {
            DbType::Mysql => "mysql",
            DbType::Redis => "redis",
        }
        .to_string(),
        host: c.host.clone(),
        port: c.port,
        user: c.user.clone(),
        database: c.database.clone(),
        group_id: c.group_id.clone(),
    }
}

/// Tagged union so the frontend can pattern-match the result shape.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum QueryOutput {
    Table {
        columns: Vec<String>,
        rows: Vec<Vec<String>>,
        truncated: bool,
        /// Total rows when known (browse path). None for arbitrary SQL so the
        /// UI knows not to render a pager.
        #[serde(default)]
        total: Option<usize>,
        /// Current 0-based page and page size (browse path).
        #[serde(default)]
        page: usize,
        #[serde(default)]
        page_size: usize,
        /// Primary-key column names (browse path only). Empty when there's no
        /// stable row identity, in which case the UI must disable editing.
        #[serde(default)]
        primary_keys: Vec<String>,
    },
    Redis {
        command: String,
        lines: Vec<String>,
        note: String,
        truncated: bool,
    },
}

#[derive(Serialize)]
pub struct StatusInfo {
    pub llm_enabled: bool,
    pub mask_enabled: bool,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

// --- Tree model (environments → groups → connections) ----------------------

#[derive(Serialize)]
pub struct GroupNode {
    pub id: String,
    pub name: String,
    pub order: i64,
    pub connections: Vec<ConnSummary>,
}

#[derive(Serialize)]
pub struct EnvNode {
    pub id: String,
    pub name: String,
    pub order: i64,
    /// Database type this environment is bound to (ADR-022). Empty/missing on
    /// disk is serialized as "mysql" for forward-compatible rendering.
    pub db_type: String,
    pub groups: Vec<GroupNode>,
}

#[derive(Serialize)]
pub struct TreeModel {
    pub environments: Vec<EnvNode>,
}

/// Full left-tree model: environments (ordered) → groups (ordered) →
/// connections under each group. Empty containers are included naturally.
/// Connections with no `group_id` are collected under a synthetic "未分组"
/// environment appended last. `list_connections` is superseded by this.
#[tauri::command]
pub fn list_tree(state: State<AppState>) -> TreeModel {
    let store = state.store.lock().unwrap();
    let containers = store.list_containers();
    let conns = store.list();
    let mut environments: Vec<EnvNode> = Vec::new();

    for env in containers.iter().filter(|c| c.kind == ContainerKind::Env) {
        let mut groups: Vec<GroupNode> = Vec::new();
        for g in containers.iter().filter(|c| {
            c.kind == ContainerKind::Group && c.parent.as_deref() == Some(&env.id)
        }) {
            let group_conns: Vec<ConnSummary> = conns
                .iter()
                .filter(|c| c.group_id.as_deref() == Some(&g.id))
                .map(to_summary)
                .collect();
            groups.push(GroupNode {
                id: g.id.clone(),
                name: g.name.clone(),
                order: g.ord,
                connections: group_conns,
            });
        }
        environments.push(EnvNode {
            id: env.id.clone(),
            name: env.name.clone(),
            order: env.ord,
            db_type: match env.db_type {
                Some(DbType::Redis) => "redis".to_string(),
                _ => "mysql".to_string(),
            },
            groups,
        });
    }

    // Ungrouped connections → synthetic "未分组" environment.
    let ungrouped: Vec<ConnSummary> = conns
        .iter()
        .filter(|c| c.group_id.is_none())
        .map(to_summary)
        .collect();
    if !ungrouped.is_empty() {
        environments.push(EnvNode {
            id: "__ungrouped".to_string(),
            name: "未分组".to_string(),
            order: i64::MAX,
            db_type: "mysql".to_string(),
            groups: vec![GroupNode {
                id: "__ungrouped".to_string(),
                name: String::new(),
                order: 0,
                connections: ungrouped,
            }],
        });
    }

    TreeModel { environments }
}

#[tauri::command]
pub fn add_connection(state: State<AppState>, cfg: ConnInput) -> Result<(), String> {
    state
        .store
        .lock()
        .unwrap()
        .add(to_cfg(cfg))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_connection(state: State<AppState>, cfg: ConnInput) -> Result<(), String> {
    let mut merged = to_cfg(cfg);
    // Empty sensitive fields on edit mean "keep the existing ones" (we never
    // send the real password/SSL keys back to the UI, so the form can't
    // repopulate them — saving blank must not wipe stored config).
    if let Some(existing) = state
        .store
        .lock()
        .unwrap()
        .list()
        .iter()
        .find(|c| c.id == merged.id)
    {
        if merged.password.is_empty() {
            merged.password = existing.password.clone();
        }
        if merged.ssl_ca.is_empty() {
            merged.ssl_ca = existing.ssl_ca.clone();
        }
        if merged.client_cert.is_empty() {
            merged.client_cert = existing.client_cert.clone();
        }
        if merged.client_key.is_empty() {
            merged.client_key = existing.client_key.clone();
        }
        if merged.ssh_password.is_empty() {
            merged.ssh_password = existing.ssh_password.clone();
        }
        if merged.ssh_private_key.is_empty() {
            merged.ssh_private_key = existing.ssh_private_key.clone();
        }
    }
    state
        .store
        .lock()
        .unwrap()
        .update(merged)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_connection(state: State<AppState>, id: String) -> Result<(), String> {
    state
        .store
        .lock()
        .unwrap()
        .remove(&id)
        .map_err(|e| e.to_string())
}

// --- Container (environment / group) CRUD (ADR-016) -------------------------

#[tauri::command]
pub fn create_environment(
    state: State<AppState>,
    name: String,
    db_type: Option<String>,
) -> Result<String, String> {
    // ADR-022: environments are bound to a single db_type so they can be
    // placed under the correct root even when empty. Unknown/missing ⇒ MySQL.
    let db_type = match db_type.as_deref() {
        Some("redis") => Some(DbType::Redis),
        _ => Some(DbType::Mysql),
    };
    state
        .store
        .lock()
        .unwrap()
        .create_env(&name, db_type)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_group(
    state: State<AppState>,
    env_id: String,
    name: String,
) -> Result<String, String> {
    state
        .store
        .lock()
        .unwrap()
        .create_group(&env_id, &name)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_container(
    state: State<AppState>,
    id: String,
    name: String,
) -> Result<(), String> {
    state
        .store
        .lock()
        .unwrap()
        .rename_container(&id, &name)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_container(state: State<AppState>, id: String) -> Result<(), String> {
    state
        .store
        .lock()
        .unwrap()
        .delete_container(&id)
        .map_err(|e| e.to_string())
}

// --- Query history / saved snippets ----------------------------------------

#[tauri::command]
pub fn log_query(
    state: State<AppState>,
    conn_id: Option<String>,
    db: Option<String>,
    sql: String,
) -> Result<(), String> {
    state
        .store
        .lock()
        .unwrap()
        .log_query(conn_id.as_deref(), db.as_deref(), &sql)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_queries(state: State<AppState>) -> Result<Vec<QueryItem>, String> {
    state
        .store
        .lock()
        .unwrap()
        .list_queries()
        .map(|rows| {
            rows.into_iter()
                .map(|r| QueryItem {
                    id: r.id,
                    name: r.name,
                    sql: r.sql,
                    conn_id: r.conn_id,
                    db: r.db,
                    created: r.created,
                })
                .collect()
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_query(
    state: State<AppState>,
    id: Option<String>,
    name: String,
    sql: String,
    conn_id: Option<String>,
    db: Option<String>,
) -> Result<String, String> {
    state
        .store
        .lock()
        .unwrap()
        .save_query(id.as_deref(), &name, &sql, conn_id.as_deref(), db.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_query(state: State<AppState>, id: String) -> Result<(), String> {
    state
        .store
        .lock()
        .unwrap()
        .delete_query(&id)
        .map_err(|e| e.to_string())
}

// --- Knowledge base (ADR-AI-6) ---------------------------------------------

#[derive(Serialize)]
pub struct KbBindingDto {
    pub conn_id: String,
    pub database: Option<String>,
}

#[derive(Serialize)]
pub struct KbDocDto {
    pub id: String,
    pub name: String,
    pub content: String,
    pub created: i64,
    pub updated: i64,
    pub bindings: Vec<KbBindingDto>,
}

#[derive(Deserialize)]
pub struct KbBindingInput {
    pub conn_id: String,
    #[serde(default)]
    pub database: Option<String>,
}

#[tauri::command]
pub fn add_kb_doc(
    state: State<AppState>,
    name: String,
    content: String,
) -> Result<String, String> {
    state
        .store
        .lock()
        .unwrap()
        .add_kb_doc(&name, &content)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_kb_doc(
    state: State<AppState>,
    id: String,
    name: String,
    content: String,
) -> Result<(), String> {
    state
        .store
        .lock()
        .unwrap()
        .update_kb_doc(&id, &name, &content)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_kb_docs(state: State<AppState>) -> Result<Vec<KbDocDto>, String> {
    let store = state.store.lock().unwrap();
    let docs = store.list_kb_docs().map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(docs.len());
    for d in docs {
        let bindings = store.get_kb_bindings(&d.id).map_err(|e| e.to_string())?;
        out.push(KbDocDto {
            id: d.id,
            name: d.name,
            content: d.content,
            created: d.created,
            updated: d.updated,
            bindings: bindings
                .into_iter()
                .map(|b| KbBindingDto {
                    conn_id: b.conn_id,
                    database: b.database,
                })
                .collect(),
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn delete_kb_doc(state: State<AppState>, id: String) -> Result<(), String> {
    state
        .store
        .lock()
        .unwrap()
        .delete_kb_doc(&id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_kb_bindings(
    state: State<AppState>,
    kb_id: String,
    bindings: Vec<KbBindingInput>,
) -> Result<(), String> {
    let bs: Vec<(String, Option<String>)> = bindings
        .into_iter()
        .map(|b| (b.conn_id, b.database))
        .collect();
    state
        .store
        .lock()
        .unwrap()
        .set_kb_bindings(&kb_id, &bs)
        .map_err(|e| e.to_string())
}

// --- EXPLAIN (execution plan) ------------------------------------------------

#[tauri::command]
pub async fn explain_query(
    state: State<'_, AppState>,
    conn_id: String,
    query: String,
    db: String,
) -> Result<QueryOutput, String> {
    let cfg = {
        let store = state.store.lock().unwrap();
        store
            .list()
            .iter()
            .find(|c| c.id == conn_id)
            .cloned()
    }
    .ok_or_else(|| "连接未找到".to_string())?;

    match cfg.db_type {
        DbType::Mysql => {
            let sql = format!("EXPLAIN {}", query);
            let target_db: Option<&str> = if db.is_empty() { None } else { Some(db.as_str()) };
            let r: QueryResult = chatquery::db::mysql::query(&cfg, &sql, target_db)
                .await
                .map_err(|e| e.to_string())?;
            Ok(QueryOutput::Table {
                columns: r.columns,
                rows: r.rows,
                truncated: r.truncated,
                total: None,
                page: 0,
                page_size: 0,
                primary_keys: vec![],
            })
        }
        DbType::Redis => Ok(QueryOutput::Redis {
            command: "EXPLAIN".to_string(),
            lines: vec![],
            note: "EXPLAIN 仅支持 SQL 连接（MySQL）".to_string(),
            truncated: false,
        }),
    }
}

#[tauri::command]
pub async fn test_connection(cfg: ConnInput) -> Result<bool, String> {
    let c = to_cfg(cfg);
    let res = match c.db_type {
        DbType::Mysql => chatquery::db::mysql::test(&c).await,
        DbType::Redis => chatquery::db::redis::test(&c).await,
    };
    match res {
        Ok(()) => Ok(true),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn execute_query(
    state: State<'_, AppState>,
    conn_id: String,
    query: String,
    db: String,
    page: u32,
    page_size: u32,
) -> Result<QueryOutput, String> {
    let cfg = {
        let store = state.store.lock().unwrap();
        store
            .list()
            .iter()
            .find(|c| c.id == conn_id)
            .cloned()
    }
    .ok_or_else(|| "连接未找到".to_string())?;

    let res = timeout(std::time::Duration::from_secs(QUERY_TIMEOUT_SECS), async {
        match cfg.db_type {
            DbType::Mysql => {
                let target_db: Option<&str> =
                    if db.is_empty() { None } else { Some(db.as_str()) };
                let r: QueryResult = chatquery::db::mysql::query_paged(
                    &cfg,
                    &query,
                    target_db,
                    page as usize,
                    page_size as usize,
                )
                .await
                .map_err(|e| e.to_string())?;
                Ok::<QueryOutput, String>(QueryOutput::Table {
                    columns: r.columns,
                    rows: r.rows,
                    truncated: r.truncated,
                    total: r.total,
                    page: page as usize,
                    page_size: page_size as usize,
                    primary_keys: vec![],
                })
            }
            DbType::Redis => {
                let r = chatquery::db::redis::query(&cfg, &query)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok::<QueryOutput, String>(QueryOutput::Redis {
                    command: r.command,
                    lines: r.lines,
                    note: r.note,
                    truncated: r.truncated,
                })
            }
        }
    })
    .await;

    match res {
        Ok(inner) => inner,
        Err(_) => Err(format!("查询超时（服务端限制 {} 秒）", QUERY_TIMEOUT_SECS)),
    }
}

#[tauri::command]
pub async fn get_schema(
    state: State<'_, AppState>,
    conn_id: String,
    db: Option<String>,
) -> Result<Schema, String> {
    load_schema_cached(&state, &conn_id, db.as_deref()).await
}

/// Load a connection's schema for a specific database, served from the bounded
/// per-(connection, database) cache. `db = None` resolves to the connection's
/// default database. Powers editor autocomplete and AI completion.
async fn load_schema_cached(
    state: &State<'_, AppState>,
    conn_id: &str,
    db: Option<&str>,
) -> Result<Schema, String> {
    let key = format!("{}::{}", conn_id, db.unwrap_or("DEFAULT"));
    if let Some(s) = state.schema_cache.lock().unwrap().get(&key) {
        return Ok(s.clone());
    }
    let cfg = resolve_cfg(state, conn_id).ok_or_else(|| "连接未找到".to_string())?;
    let schema = match cfg.db_type {
        DbType::Mysql => chatquery::db::mysql::schema(&cfg, db)
            .await
            .map_err(|e| e.to_string())?,
        DbType::Redis => Schema { tables: vec![] },
    };
    state
        .schema_cache
        .lock()
        .unwrap()
        .insert(key, schema.clone());
    Ok(schema)
}

/// Build a compact, LLM-friendly description of a schema: one line per table
/// with its column names. Bounded to the selected database (ADR-006).
fn summarize_schema(schema: &Schema, db: &str) -> String {
    if schema.tables.is_empty() {
        return format!("(no tables found in `{}`)", db);
    }
    let mut lines: Vec<String> = Vec::with_capacity(schema.tables.len());
    for t in &schema.tables {
        let cols: Vec<&str> = t.columns.iter().map(|c| c.name.as_str()).collect();
        lines.push(format!("- `{}`({})", t.name, cols.join(", ")));
    }
    lines.join("\n")
}

/// Strip a leading/trailing markdown code fence (```sql … ```) if the model
/// wrapped its answer. Returns None when no fence is present.
fn strip_code_fence(text: &str) -> Option<String> {
    let t = text.trim();
    if !t.starts_with("```") {
        return None;
    }
    let end = t.rfind("```")?;
    if end == 0 {
        return None;
    }
    let body = &t[3..end];
    // drop an optional language tag on the opening fence (e.g. "```sql")
    let body = body.lines().skip(1).collect::<Vec<_>>().join("\n");
    Some(body.trim().to_string())
}

/// Inline AI completion (Copilot-style): given the SQL typed so far, ask the
/// configured LLM for the remaining tokens and return them as a suffix. The
/// editor renders this as ghost text and accepts it on Tab. Off unless the
/// user enables it in settings (default off — avoids surprise latency/cost).
#[tauri::command]
pub async fn complete_sql(
    state: State<'_, AppState>,
    conn_id: String,
    db: Option<String>,
    prefix: String,
) -> Result<String, String> {
    let llm = state.llm.lock().unwrap().clone();
    if !llm.enabled() {
        return Err("LLM 未配置".to_string());
    }
    let cfg = resolve_cfg(&state, &conn_id).ok_or_else(|| "连接未找到".to_string())?;
    if cfg.db_type != DbType::Mysql {
        return Err("AI 补全仅支持 MySQL".to_string());
    }
    if prefix.trim().is_empty() {
        return Ok(String::new());
    }
    let schema = load_schema_cached(&state, &conn_id, db.as_deref()).await?;
    let db_name = db.clone().unwrap_or_else(|| cfg.database.clone());
    let schema_text = summarize_schema(&schema, &db_name);
    let system = format!(
        "You are a MySQL SQL completion engine. The user has typed the partial SQL shown after 'Partial SQL:'. The cursor is at the end of that text. Return ONLY the remaining SQL tokens that complete the current statement — do not repeat the prefix, do not add a trailing semicolon unless the statement is clearly complete, output raw SQL only with no markdown fences, no comments, and no explanation. If there is no sensible completion, return an empty string.\n\nSchema (database `{}`):\n{}",
        db_name, schema_text
    );
    let messages = vec![
        ChatMessage {
            role: ChatRole::System,
            content: system,
            tool_calls: None,
            tool_call_id: None,
        },
        ChatMessage::user(prefix),
    ];
    let choice = stream_chat(&llm, &messages, &[], &mut |_| {})
        .await
        .map_err(|e| e.to_string())?;
    let mut out = choice.content;
    if let Some(stripped) = strip_code_fence(&out) {
        out = stripped;
    }
    Ok(out.trim().to_string())
}

/// Resolve a stored connection config by id (cloned out of the lock so we
/// don't hold the MutexGuard across an await — std Mutex + async is a footgun).
fn resolve_cfg(state: &State<AppState>, conn_id: &str) -> Option<ConnectionConfig> {
    state
        .store
        .lock()
        .unwrap()
        .list()
        .iter()
        .find(|c| c.id == conn_id)
        .cloned()
}

// --- Schema tree navigation (lazy, bounded per ADR-006) ---------------------

#[tauri::command]
pub async fn list_databases(
    state: State<'_, AppState>,
    conn_id: String,
) -> Result<Vec<String>, String> {
    let cfg = resolve_cfg(&state, &conn_id).ok_or_else(|| "连接未找到".to_string())?;
    chatquery::db::mysql::list_databases(&cfg)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_redis_dbs(
    state: State<'_, AppState>,
    conn_id: String,
) -> Result<Vec<u8>, String> {
    let cfg = resolve_cfg(&state, &conn_id).ok_or_else(|| "连接未找到".to_string())?;
    chatquery::db::redis::list_dbs(&cfg)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_tables(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
) -> Result<Vec<TableMeta>, String> {
    let cfg = resolve_cfg(&state, &conn_id).ok_or_else(|| "连接未找到".to_string())?;
    chatquery::db::mysql::list_tables(&cfg, &database)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn search_tables(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    like: Option<String>,
    limit: usize,
) -> Result<Vec<TableMeta>, String> {
    let cfg = resolve_cfg(&state, &conn_id).ok_or_else(|| "连接未找到".to_string())?;
    chatquery::db::mysql::search_tables(&cfg, &database, like.as_deref(), limit)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_redis_keys(
    state: State<'_, AppState>,
    conn_id: String,
    db: u8,
    pattern: String,
    limit: usize,
) -> Result<Vec<String>, String> {
    let cfg = resolve_cfg(&state, &conn_id).ok_or_else(|| "连接未找到".to_string())?;
    chatquery::db::redis::list_keys(&cfg, db, &pattern, limit)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_columns(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
) -> Result<Vec<ColumnInfo>, String> {
    let cfg = resolve_cfg(&state, &conn_id).ok_or_else(|| "连接未找到".to_string())?;
    chatquery::db::mysql::list_columns(&cfg, &database, &table)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browse_table(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    page: usize,
    page_size: usize,
) -> Result<QueryOutput, String> {
    let cfg = resolve_cfg(&state, &conn_id).ok_or_else(|| "连接未找到".to_string())?;
    let r = chatquery::db::mysql::browse(&cfg, &database, &table, page, page_size)
        .await
        .map_err(|e| e.to_string())?;
    Ok(QueryOutput::Table {
        columns: r.columns,
        rows: r.rows,
        truncated: r.truncated,
        total: r.total,
        page,
        page_size,
        primary_keys: r.primary_keys,
    })
}

/// Write back edited cells of a single table row (ADR-018). `pk` is the row's
/// original primary-key values (the snapshot used to locate it); `set` is the
/// new column values. The backend folds these into one parameterized `UPDATE`
/// inside a transaction via `mysql::apply_edit`. No primary keys => the caller
/// must not send this (the UI disables editing in that case).
#[derive(Deserialize)]
pub struct PkPair {
    pub col: String,
    pub val: String,
}

#[derive(Deserialize)]
pub struct SetPair {
    pub col: String,
    pub val: String,
}

#[tauri::command]
pub async fn apply_edit(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    pk: Vec<PkPair>,
    set: Vec<SetPair>,
) -> Result<(), String> {
    let cfg = resolve_cfg(&state, &conn_id).ok_or_else(|| "连接未找到".to_string())?;
    let pk: Vec<(String, String)> = pk.into_iter().map(|p| (p.col, p.val)).collect();
    let set: Vec<(String, String)> = set.into_iter().map(|s| (s.col, s.val)).collect();
    if set.is_empty() {
        return Ok(());
    }
    chatquery::db::mysql::apply_edit(&cfg, &database, &table, pk, set)
        .await
        .map_err(|e| e.to_string())
}

/// Insert a new row (ADR-019). `values` is the list of column/value pairs the
/// user explicitly typed; columns not included fall back to DB defaults. Reuses
/// the `SetPair` DTO from apply_edit since the shape is identical.
#[tauri::command]
pub async fn insert_row(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    values: Vec<SetPair>,
) -> Result<(), String> {
    let cfg = resolve_cfg(&state, &conn_id).ok_or_else(|| "连接未找到".to_string())?;
    let values: Vec<(String, String)> = values.into_iter().map(|s| (s.col, s.val)).collect();
    if values.is_empty() {
        return Ok(());
    }
    chatquery::db::mysql::insert_row(&cfg, &database, &table, values)
        .await
        .map_err(|e| e.to_string())
}

/// Delete a single row by its primary-key snapshot (ADR-019). Reuses `PkPair`.
#[tauri::command]
pub async fn delete_row(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    pk: Vec<PkPair>,
) -> Result<(), String> {
    let cfg = resolve_cfg(&state, &conn_id).ok_or_else(|| "连接未找到".to_string())?;
    let pk: Vec<(String, String)> = pk.into_iter().map(|p| (p.col, p.val)).collect();
    chatquery::db::mysql::delete_row(&cfg, &database, &table, pk)
        .await
        .map_err(|e| e.to_string())
}

/// Fetch the full structure of a table: column details (with full type and
/// extra), index list, and the CREATE TABLE DDL. Powers the "表结构" view
/// (ADR-020). MySQL only — Redis has no schema to describe.
#[tauri::command]
pub async fn describe_table(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
) -> Result<TableStructure, String> {
    let cfg = resolve_cfg(&state, &conn_id).ok_or_else(|| "连接未找到".to_string())?;
    chatquery::db::mysql::describe_table(&cfg, &database, &table)
        .await
        .map_err(|e| e.to_string())
}

/// List all foreign-key relationships in a database (ADR-021). Powers the ER /
/// table-relationship view. MySQL only — Redis has no schema to describe.
#[tauri::command]
pub async fn list_relationships(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
) -> Result<Vec<ForeignKeyInfo>, String> {
    let cfg = resolve_cfg(&state, &conn_id).ok_or_else(|| "连接未找到".to_string())?;
    chatquery::db::mysql::list_relationships(&cfg, &database)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browse_redis_key(
    state: State<'_, AppState>,
    conn_id: String,
    db: u8,
    key: String,
) -> Result<QueryOutput, String> {
    let cfg = resolve_cfg(&state, &conn_id).ok_or_else(|| "连接未找到".to_string())?;
    let r = chatquery::db::redis::browse_key(&cfg, db, &key)
        .await
        .map_err(|e| e.to_string())?;
    Ok(QueryOutput::Redis {
        command: r.command,
        lines: r.lines,
        note: r.note,
        truncated: r.truncated,
    })
}

#[tauri::command]
pub fn get_status(state: State<AppState>) -> StatusInfo {
    StatusInfo {
        llm_enabled: state.llm.lock().unwrap().enabled(),
        mask_enabled: chatquery::mask::masking_enabled(),
    }
}

/// Non-secret view of the current LLM config for the settings UI. The api_key
/// is deliberately NOT returned — the form shows an empty field and only sends
/// a new key when the user types one (empty input = keep the stored key).
#[derive(Serialize)]
pub struct LlmConfigDto {
    pub vendor: String,
    pub base_url: String,
    pub model: String,
    pub provider: String,
    pub enabled: bool,
}

#[tauri::command]
pub fn get_llm_config(state: State<AppState>) -> LlmConfigDto {
    let llm = state.llm.lock().unwrap();
    LlmConfigDto {
        vendor: llm.vendor.clone(),
        base_url: llm.base_url.clone(),
        model: llm.model.clone(),
        provider: llm.provider.as_str().to_string(),
        enabled: llm.enabled(),
    }
}

/// A selectable vendor preset surfaced in the settings dropdown.
#[derive(Serialize)]
pub struct VendorPresetDto {
    pub id: String,
    pub label: String,
    pub provider: String,
    pub base_url: String,
    pub model: String,
}

#[tauri::command]
pub fn get_vendor_presets() -> Vec<VendorPresetDto> {
    chatquery::config::VENDOR_PRESETS
        .iter()
        .map(|p| VendorPresetDto {
            id: p.id.to_string(),
            label: p.label.to_string(),
            provider: p.provider.as_str().to_string(),
            base_url: p.base_url.to_string(),
            model: p.model.to_string(),
        })
        .collect()
}

/// Mutable LLM config input from the settings UI.
#[derive(Deserialize)]
pub struct LlmConfigInput {
    pub vendor: String,
    pub base_url: String,
    pub model: String,
    /// Empty = keep the currently stored key (don't overwrite with blank).
    #[serde(default)]
    pub api_key: String,
}

#[tauri::command]
pub fn save_llm_config(
    state: State<AppState>,
    input: LlmConfigInput,
) -> Result<(), String> {
    let provider = chatquery::config::provider_for_vendor(&input.vendor);
    let existing = state.llm.lock().unwrap().api_key.clone();
    let api_key = if input.api_key.is_empty() {
        existing
    } else {
        input.api_key
    };
    let cfg = chatquery::config::LlmConfig {
        provider,
        vendor: input.vendor,
        base_url: input.base_url,
        api_key,
        model: input.model,
    };
    cfg.save()?;
    *state.llm.lock().unwrap() = cfg;
    Ok(())
}

/// Monotonic turn counter. Combined with the process-start instant this gives
/// ids that are unique for the lifetime of the app without a uuid dependency.
static TURN_SEQ: AtomicU64 = AtomicU64::new(1);

fn next_turn_id() -> String {
    let n = TURN_SEQ.fetch_add(1, Ordering::Relaxed);
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("t{}-{}", ms, n)
}

/// Run one LLM turn. The model streams tokens (and emits tool notices) which
/// we forward to the frontend as Tauri events — mirroring the old TUI's
/// `BackendMsg` channel, but over the webview's event bus. Results sent to the
/// model are still masked on the cloud path (see `llm::tools::exec_builtin`).
///
/// Returns the turn id. The UI needs it to cancel the turn (`cancel_turn`) or
/// to answer a write confirmation (`resolve_confirm`) — both of which target a
/// run that is still in flight, so the id must be handed back synchronously,
/// before any streaming begins.
#[tauri::command]
pub async fn chat_turn(
    app: AppHandle,
    state: State<'_, AppState>,
    conn_id: String,
    messages: Vec<ChatMessage>,
) -> Result<String, String> {
    let conns: Vec<ConnectionConfig> = state.store.lock().unwrap().list().to_vec();
    let llm = state.llm.lock().unwrap().clone();
    let mcp = state.mcp.clone();

    // Build the knowledge-base loader closure (ADR-AI-6): it reads docs bound
    // to the active connection/db from the store. The `Arc` keeps it 'static
    // so it can cross into the spawned LLM future; a TUI turn passes a no-op.
    let store = Arc::clone(&state.store);
    let kb_loader: chatquery::llm::KbLoader = Arc::new(move |conn_id: &str, db: Option<&str>| {
        let store = store.lock().unwrap();
        match store.get_injected_kb_docs(conn_id, db) {
            Ok(docs) => docs.into_iter().map(|d| (d.name, d.content)).collect(),
            Err(_) => Vec::new(),
        }
    });

    // Audit sink (ADR-AI-1 决策3): persist write-guardrail decisions to the
    // store. Mirrors `kb_loader` — the `Arc` keeps it 'static for the future.
    // A TUI turn passes a no-op sink.
    let store_audit = Arc::clone(&state.store);
    let audit: chatquery::llm::AuditSink = Arc::new(move |e: &chatquery::llm::AuditEvent| {
        let _ = store_audit.lock().unwrap().add_audit(
            &e.conn_id,
            &e.conn_name,
            e.db.as_deref(),
            &e.sql,
            e.decision,
        );
    });

    let turn_id = next_turn_id();
    let ctl = TurnControl::new(turn_id.clone());
    state
        .turns
        .lock()
        .unwrap()
        .insert(turn_id.clone(), ctl.clone());

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<BackendMsg>();

    // Drive the LLM turn. Terminal errors and completion both travel through
    // `tx` (not a direct emit) so they stay ordered behind the tokens already
    // queued in the channel — otherwise `chat-done` can overtake the tail of
    // the stream and the UI commits a truncated message.
    tauri::async_runtime::spawn(async move {
        let r = chatquery::llm::session::run_turn(
            &llm,
            conns,
            mcp,
            &messages,
            &conn_id,
            &tx,
                ctl.clone(),
                kb_loader,
                audit,
        )
        .await;
        if let Err(e) = r {
            let _ = tx.send(BackendMsg::Error(e.to_string()));
        }
        let _ = tx.send(BackendMsg::ChatDone);
        // Release any confirmation still waiting on a UI that never answered.
        ctl.cancel();
    });

    // Bridge backend messages -> frontend events.
    let bridge_turn_id = turn_id.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(msg) = rx.recv().await {
            match msg {
                BackendMsg::ChatToken(s) => {
                    let _ = app.emit("chat-token", s);
                }
                BackendMsg::ChatTool(s) => {
                    let _ = app.emit("chat-tool", s);
                }
                BackendMsg::ChatPlan(steps) => {
                    let _ = app.emit("chat-plan", steps);
                }
                BackendMsg::ChatConfirm(req) => {
                    let _ = app.emit("chat-confirm", req);
                }
                BackendMsg::ChatUsage(u) => {
                    let _ = app.emit("chat-usage", u);
                }
                BackendMsg::ChatDone => {
                    let _ = app.emit("chat-done", ());
                }
                BackendMsg::Error(s) => {
                    let _ = app.emit("chat-error", s);
                }
                _ => {}
            }
        }
        // Channel closed => the turn is over. Drop its control handle so the
        // registry doesn't grow across a long session.
        app.state::<AppState>()
            .turns
            .lock()
            .unwrap()
            .remove(&bridge_turn_id);
    });

    Ok(turn_id)
}

/// Read the write-guardrail audit trail (ADR-AI-1 决策3). Returns
/// (conn_name, db, sql, decision, ts) rows, newest first.
#[tauri::command]
pub async fn list_audit_logs(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> Result<Vec<(String, Option<String>, String, String, i64)>, String> {
    let store = state.store.lock().unwrap();
    store
        .list_audits(limit.unwrap_or(100))
        .map_err(|e| e.to_string())
}

/// Stop an in-flight LLM turn (ADR-AI-4). Best-effort and idempotent: an
/// unknown or already-finished id is a no-op, not an error.
#[tauri::command]
pub fn cancel_turn(state: State<AppState>, turn_id: String) {
    let ctl = state.turns.lock().unwrap().get(&turn_id).cloned();
    if let Some(c) = ctl {
        c.cancel();
    }
}

/// Answer a pending write confirmation raised by the guardrail. `approved`
/// true runs the statement, false feeds a refusal back to the model.
#[tauri::command]
pub fn resolve_confirm(state: State<AppState>, turn_id: String, id: String, approved: bool) {
    let ctl = state.turns.lock().unwrap().get(&turn_id).cloned();
    if let Some(c) = ctl {
        c.resolve(&id, approved);
    }
}

// --- Encryption key management (#0) ----------------------------------------

/// Non-secret view of the configurable connection key K. `configured` tells
/// the UI whether the user has set a custom key (otherwise K degenerates to
/// the built-in KEK and behaves exactly like the pre-#0 install).
#[derive(Serialize)]
pub struct KeyStatus {
    pub configured: bool,
}

#[tauri::command]
pub fn get_key_status() -> KeyStatus {
    KeyStatus {
        configured: crypto::key_configured(),
    }
}

/// Configure or rotate the connection encryption key K (#0). The field is the
/// user's secret passphrase; K is derived deterministically from it (HKDF) so
/// the same passphrase on another machine yields the same K — that's the
/// cross-machine portability story. All stored connections are re-encrypted
/// atomically to the new K. An empty field resets K back to the default KEK.
#[tauri::command]
pub fn set_encryption_key(
    state: State<AppState>,
    field: String,
) -> Result<(), String> {
    state
        .store
        .lock()
        .unwrap()
        .rotate_key(&field)
        .map_err(|e| e.to_string())
}

// --- Connection import / export (#1, #2) -----------------------------------

/// Export all connections (containers + configs) to a YAML string. `cipher`
/// is `"system-key"` (passwords AES-GCM under K) or `"none"` (plaintext —
/// high-risk, the UI must warn before allowing this).
#[tauri::command]
pub fn export_connections(
    state: State<AppState>,
    cipher: String,
) -> Result<String, String> {
    let store = state.store.lock().unwrap();
    export_yaml(&store, &cipher).map_err(|e| e.to_string())
}

/// Import connections from a YAML string (v2 hierarchical or v1 flat). Returns
/// a summary of what was added / skipped so the UI can show a toast.
#[tauri::command]
pub fn import_connections(
    state: State<AppState>,
    yaml: String,
) -> Result<ImportResult, String> {
    let mut store = state.store.lock().unwrap();
    import_yaml(&mut store, &yaml).map_err(|e| e.to_string())
}

/// A ready-to-fill YAML template (plaintext cipher) for users to hand-edit and
/// re-import. The UI typically offers this as a file download.
#[tauri::command]
pub fn export_template() -> String {
    export_template_yaml()
}

// --- EXPLAIN visualisation (#6) --------------------------------------------

/// Run EXPLAIN on a (SELECT) query and return a parsed execution-plan tree.
/// The UI renders this as a plan tab. Non-SELECT or unsupported server version
/// falls back to a legacy text plan (still returned, format = "legacy").
#[tauri::command]
pub async fn explain_visual(
    state: State<'_, AppState>,
    conn_id: String,
    query: String,
    db: String,
) -> Result<ExplainVisual, String> {
    let cfg = resolve_cfg(&state, &conn_id).ok_or_else(|| "连接未找到".to_string())?;
    if cfg.db_type != DbType::Mysql {
        return Err("EXPLAIN 可视化仅支持 MySQL".to_string());
    }
    let db_ref: Option<&str> = if db.is_empty() { None } else { Some(db.as_str()) };
    chatquery::db::mysql::explain_visual(&cfg, &query, db_ref)
        .await
        .map_err(|e| e.to_string())
}
