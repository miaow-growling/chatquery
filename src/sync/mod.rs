pub mod git;

use crate::config::{self, LlmConfig, LlmProvider, VendorProfile};
use crate::crypto;
use crate::db::connection::ConnectionConfig;
use crate::db::container::Container;
use crate::error::{AppError, Result};
use crate::model::StoredChatMessage;
use crate::store::{QueryRow, Storage};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

pub const BACKUP_SALT: &[u8] = b"chatquery::git-sync-backup::v1::salt";
pub const BACKUP_INFO: &[u8] = b"chatquery:git-backup:v1";
pub const CURRENT_BACKUP_VERSION: u32 = 1;

fn default_true() -> bool {
    true
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// -----------------------------------------------------------------------------
// 同步配置实体与持久化 (~/.config/chatquery/git_sync.json)
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitSyncConfig {
    pub git_url: String,
    #[serde(default)]
    pub encryption_key_enc: String,
    #[serde(default = "default_true")]
    pub sync_connections: bool,
    #[serde(default = "default_true")]
    pub sync_models: bool,
    #[serde(default = "default_true")]
    pub sync_snippets: bool,
    #[serde(default)]
    pub sync_history: bool,
    #[serde(default)]
    pub last_backup_time: Option<i64>,
    #[serde(default)]
    pub last_restore_time: Option<i64>,
    #[serde(default)]
    pub last_status: Option<String>,
}

impl Default for GitSyncConfig {
    fn default() -> Self {
        Self {
            git_url: String::new(),
            encryption_key_enc: String::new(),
            sync_connections: true,
            sync_models: true,
            sync_snippets: true,
            sync_history: false,
            last_backup_time: None,
            last_restore_time: None,
            last_status: None,
        }
    }
}

pub fn git_sync_config_path() -> PathBuf {
    crypto::config_dir().join("git_sync.json")
}

pub fn load_git_sync_config() -> GitSyncConfig {
    let path = git_sync_config_path();
    if let Ok(content) = std::fs::read_to_string(&path) {
        if let Ok(cfg) = serde_json::from_str::<GitSyncConfig>(&content) {
            return cfg;
        }
    }
    GitSyncConfig::default()
}

pub fn save_git_sync_config(cfg: &GitSyncConfig) -> Result<()> {
    let path = git_sync_config_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let data = serde_json::to_vec_pretty(cfg)
        .map_err(|e| AppError::Msg(format!("序列化同步配置失败: {}", e)))?;
    std::fs::write(&path, data).map_err(|e| AppError::Msg(format!("保存同步配置失败: {}", e)))?;
    Ok(())
}

pub fn get_decrypted_encryption_key(cfg: &GitSyncConfig) -> Result<Option<String>> {
    if cfg.encryption_key_enc.is_empty() {
        return Ok(None);
    }
    let key = crypto::load_key()?;
    let raw = cfg
        .encryption_key_enc
        .strip_prefix('$')
        .unwrap_or(&cfg.encryption_key_enc);
    let plain = crypto::decrypt(raw, &key)
        .map_err(|e| AppError::Msg(format!("解密本地保存的同步密钥失败: {}", e)))?;
    Ok(Some(plain))
}

pub fn set_encrypted_encryption_key(cfg: &mut GitSyncConfig, plain_key: &str) -> Result<()> {
    if plain_key.trim().is_empty() {
        cfg.encryption_key_enc = String::new();
        return Ok(());
    }
    let key = crypto::load_key()?;
    let enc = crypto::encrypt(plain_key.trim(), &key)?;
    cfg.encryption_key_enc = format!("${}", enc);
    Ok(())
}

// -----------------------------------------------------------------------------
// 密钥派生与备份加解密
// -----------------------------------------------------------------------------

pub fn derive_backup_key(passphrase: &str) -> Result<[u8; 32]> {
    let trimmed = passphrase.trim();
    if trimmed.is_empty() {
        return Err(AppError::Msg("备份加密密钥不能为空".into()));
    }
    let hk = Hkdf::<Sha256>::new(Some(BACKUP_SALT), trimmed.as_bytes());
    let mut okm = [0u8; 32];
    hk.expand(BACKUP_INFO, &mut okm)
        .map_err(|e| AppError::Msg(format!("派生备份加密密钥失败: {}", e)))?;
    Ok(okm)
}

pub fn encrypt_backup_payload(payload: &BackupPayload, key: &[u8; 32]) -> Result<String> {
    let json = serde_json::to_string(payload)
        .map_err(|e| AppError::Msg(format!("序列化备份数据失败: {}", e)))?;
    crypto::encrypt(&json, key)
}

pub fn decrypt_backup_payload(ciphertext_b64: &str, key: &[u8; 32]) -> Result<BackupPayload> {
    let json = crypto::decrypt(ciphertext_b64, key).map_err(|_| {
        AppError::Msg(
            "解密失败：加密密钥不正确或备份文件已损坏。请确认两台电脑输入的加密密钥完全一致".into(),
        )
    })?;
    serde_json::from_str(&json)
        .map_err(|e| AppError::Msg(format!("解析解密后的备份数据失败: {}", e)))
}

// -----------------------------------------------------------------------------
// 备份数据载荷定义 (BackupPayload)
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupPayload {
    pub version: u32,
    pub app: String,
    pub app_version: String,
    pub timestamp: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connections: Option<ConnectionsBackup>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<ModelsBackup>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snippets: Option<Vec<SnippetBackupItem>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history: Option<HistoryBackup>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionsBackup {
    pub containers: Vec<Container>,
    pub connections: Vec<ConnectionConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelsBackup {
    pub active_config: Option<ActiveModelConfig>,
    pub vendor_profiles: Vec<VendorProfile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveModelConfig {
    pub provider: Option<LlmProvider>,
    pub vendor: String,
    pub base_url: String,
    pub model: String,
    pub api_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnippetBackupItem {
    pub id: String,
    pub name: String,
    pub sql: String,
    pub conn_id: Option<String>,
    pub db: Option<String>,
    pub created: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryBackup {
    pub queries: Vec<QueryHistoryBackupItem>,
    pub conversations: Vec<ConversationBackupItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryHistoryBackupItem {
    pub id: String,
    pub sql: String,
    pub conn_id: Option<String>,
    pub db: Option<String>,
    pub created: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationBackupItem {
    pub id: String,
    pub title: String,
    pub conn_id: Option<String>,
    pub created: i64,
    pub updated: i64,
    pub pinned: bool,
    pub messages: Vec<StoredChatMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupManifest {
    pub version: u32,
    pub app: String,
    pub app_version: String,
    pub timestamp: i64,
    pub included_items: Vec<String>,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncResultSummary {
    pub success: bool,
    pub message: String,
    pub timestamp: i64,
    pub connections_count: usize,
    pub models_count: usize,
    pub snippets_count: usize,
    pub history_count: usize,
}

// -----------------------------------------------------------------------------
// 数据收集 (打包待备份项)
// -----------------------------------------------------------------------------

pub fn collect_backup_payload(
    storage: &Storage,
    sync_conn: bool,
    sync_models: bool,
    sync_snippets: bool,
    sync_history: bool,
) -> Result<BackupPayload> {
    let connections_backup = if sync_conn {
        let containers = storage.load_containers()?;
        let connections = storage.load_connections()?;
        Some(ConnectionsBackup {
            containers,
            connections,
        })
    } else {
        None
    };

    let models_backup = if sync_models {
        let active = LlmConfig::load();
        let vendor_profiles = config::load_vendor_profiles();
        Some(ModelsBackup {
            active_config: Some(ActiveModelConfig {
                provider: Some(active.provider),
                vendor: active.vendor,
                base_url: active.base_url,
                model: active.model,
                api_key: active.api_key,
            }),
            vendor_profiles,
        })
    } else {
        None
    };

    let snippets_backup = if sync_snippets {
        let snippets_rows: Vec<QueryRow> = storage.list_all_snippets()?;
        let items: Vec<SnippetBackupItem> = snippets_rows
            .into_iter()
            .map(|r| SnippetBackupItem {
                id: r.id,
                name: r.name.unwrap_or_else(|| "未命名代码片段".into()),
                sql: r.sql,
                conn_id: r.conn_id,
                db: r.db,
                created: r.created,
            })
            .collect();
        Some(items)
    } else {
        None
    };

    let history_backup = if sync_history {
        let query_history = storage.list_queries_history_raw(500)?;
        let q_items: Vec<QueryHistoryBackupItem> = query_history
            .into_iter()
            .map(|r| QueryHistoryBackupItem {
                id: r.id,
                sql: r.sql,
                conn_id: r.conn_id,
                db: r.db,
                created: r.created,
            })
            .collect();

        let convs_summary = storage.list_conversations()?;
        let mut conv_items = Vec::new();
        for c in convs_summary {
            if let Ok((info, messages)) = storage.get_conversation(&c.id, 0, 1000) {
                conv_items.push(ConversationBackupItem {
                    id: info.id,
                    title: info.title,
                    conn_id: info.conn_id,
                    created: info.created,
                    updated: info.updated,
                    pinned: info.pinned,
                    messages,
                });
            }
        }

        Some(HistoryBackup {
            queries: q_items,
            conversations: conv_items,
        })
    } else {
        None
    };

    Ok(BackupPayload {
        version: CURRENT_BACKUP_VERSION,
        app: "chatquery".to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        timestamp: now_secs(),
        connections: connections_backup,
        models: models_backup,
        snippets: snippets_backup,
        history: history_backup,
    })
}

// -----------------------------------------------------------------------------
// 数据应用 (解密后还原入库)
// -----------------------------------------------------------------------------

pub fn apply_backup_payload(
    storage: &Storage,
    payload: &BackupPayload,
    sync_conn: bool,
    sync_models: bool,
    sync_snippets: bool,
    sync_history: bool,
) -> Result<SyncResultSummary> {
    let mut connections_count = 0;
    let mut models_count = 0;
    let mut snippets_count = 0;
    let mut history_count = 0;

    // 1. 恢复连接与环境/分组容器（端点级智能去重）
    if sync_conn {
        if let Some(conn_data) = &payload.connections {
            let local_containers = storage.load_containers().unwrap_or_default();
            let mut container_id_map: std::collections::HashMap<String, String> =
                std::collections::HashMap::new();

            for c in &conn_data.containers {
                // 检查本地是否已有同名、同类型的容器
                if let Some(existing) = local_containers.iter().find(|lc| {
                    lc.name.trim() == c.name.trim()
                        && lc.kind == c.kind
                        && lc.db_type == c.db_type
                }) {
                    container_id_map.insert(c.id.clone(), existing.id.clone());
                } else {
                    let _ = storage.upsert_container(c);
                }
            }

            let local_conns = storage.load_connections().unwrap_or_default();
            for conn in &conn_data.connections {
                let mut target_conn = conn.clone();
                // 若所属环境/分组映射到了本地既有容器，重映射 group_id
                if let Some(ref gid) = target_conn.group_id {
                    if let Some(mapped) = container_id_map.get(gid) {
                        target_conn.group_id = Some(mapped.clone());
                    }
                }

                // 检查是否已有相同连接（同 ID，或同类型且 [同名 OR 同 host:port:user:database]）
                let existing = local_conns.iter().find(|lc| {
                    lc.id == target_conn.id
                        || (lc.db_type == target_conn.db_type
                            && lc.name.trim() == target_conn.name.trim())
                        || (lc.db_type == target_conn.db_type
                            && !target_conn.host.trim().is_empty()
                            && lc.host.trim() == target_conn.host.trim()
                            && lc.port == target_conn.port
                            && lc.user.trim() == target_conn.user.trim()
                            && lc.database.trim() == target_conn.database.trim())
                });

                if let Some(lc) = existing {
                    // 复用本地连接 ID 原地更新，保留既有收藏与 Tab 绑定关系
                    target_conn.id = lc.id.clone();
                }

                storage.upsert_connection(&target_conn)?;
                connections_count += 1;
            }
        }
    }

    // 2. 恢复模型与供应商配置（按供应商 ID/名称智能合并）
    if sync_models {
        if let Some(models_data) = &payload.models {
            let mut current_profiles = config::load_vendor_profiles();
            for p in &models_data.vendor_profiles {
                if let Some(pos) = current_profiles.iter().position(|cp| {
                    cp.id == p.id || cp.name.trim() == p.name.trim()
                }) {
                    let mut merged = p.clone();
                    merged.id = current_profiles[pos].id.clone();
                    current_profiles[pos] = merged;
                } else {
                    current_profiles.push(p.clone());
                }
                models_count += 1;
            }
            config::save_vendor_profiles(&current_profiles)
                .map_err(|e| AppError::Msg(format!("保存合并后的供应商配置失败: {}", e)))?;

            if let Some(active) = &models_data.active_config {
                let cfg = LlmConfig {
                    provider: active.provider.unwrap_or(LlmProvider::OpenAi),
                    vendor: active.vendor.clone(),
                    base_url: active.base_url.clone(),
                    api_key: active.api_key.clone(),
                    model: active.model.clone(),
                };
                let _ = cfg.save();
            }
        }
    }

    // 3. 恢复命名 SQL 片段（名称与内容去重）
    if sync_snippets {
        if let Some(snippets) = &payload.snippets {
            let local_snippets = storage.list_all_snippets().unwrap_or_default();
            for s in snippets {
                let existing = local_snippets.iter().find(|ls| {
                    ls.id == s.id
                        || (ls.name.as_deref() == Some(&s.name) && ls.sql.trim() == s.sql.trim())
                });

                let target_id = existing.map(|e| e.id.as_str()).unwrap_or(&s.id);
                storage.upsert_snippet_full(
                    target_id,
                    &s.name,
                    &s.sql,
                    s.conn_id.as_deref(),
                    s.db.as_deref(),
                    s.created,
                )?;
                snippets_count += 1;
            }
        }
    }

    // 4. 恢复查询历史与 AI 会话
    if sync_history {
        if let Some(hist) = &payload.history {
            for q in &hist.queries {
                let _ = storage.insert_query_history_raw(
                    &q.id,
                    &q.sql,
                    q.conn_id.as_deref(),
                    q.db.as_deref(),
                    q.created,
                );
                history_count += 1;
            }
            for conv in &hist.conversations {
                let _ = storage.upsert_conversation_raw(
                    &conv.id,
                    &conv.title,
                    conv.conn_id.as_deref(),
                    conv.created,
                    conv.updated,
                    conv.pinned,
                );
                for m in &conv.messages {
                    let meta_str = m.meta.as_ref().map(|v| v.to_string());
                    let _ = storage.upsert_chat_message_raw(
                        &m.id,
                        &conv.id,
                        0,
                        &m.role,
                        &m.content,
                        meta_str.as_deref(),
                        m.ts,
                    );
                }
            }
        }
    }

    let summary = format!(
        "数据恢复完成：共恢复 {} 个连接，{} 个模型配置，{} 条代码片段，{} 条执行历史",
        connections_count, models_count, snippets_count, history_count
    );

    Ok(SyncResultSummary {
        success: true,
        message: summary,
        timestamp: now_secs(),
        connections_count,
        models_count,
        snippets_count,
        history_count,
    })
}

// -----------------------------------------------------------------------------
// 高级编排函数：立即备份 / 立即恢复
// -----------------------------------------------------------------------------

pub fn execute_backup_to_git(
    storage: &Storage,
    key_override: Option<&str>,
) -> Result<SyncResultSummary> {
    let mut cfg = load_git_sync_config();
    git::validate_git_url(&cfg.git_url)?;

    let passphrase = match key_override {
        Some(k) if !k.trim().is_empty() => k.trim().to_string(),
        _ => get_decrypted_encryption_key(&cfg)?.ok_or_else(|| {
            AppError::Msg("尚未配置加密密钥，请在同步设置中输入加密口令".into())
        })?,
    };

    let aes_key = derive_backup_key(&passphrase)?;

    // 1. 收集待同步内容
    let payload = collect_backup_payload(
        storage,
        cfg.sync_connections,
        cfg.sync_models,
        cfg.sync_snippets,
        cfg.sync_history,
    )?;

    // 2. 加密载荷
    let ciphertext = encrypt_backup_payload(&payload, &aes_key)?;

    // 3. 计算哈希值与生成 manifest
    let mut hasher = Sha256::new();
    hasher.update(ciphertext.as_bytes());
    let sha256_hex = format!("{:x}", hasher.finalize());

    let mut included_items = Vec::new();
    if cfg.sync_connections {
        included_items.push("connections".to_string());
    }
    if cfg.sync_models {
        included_items.push("models".to_string());
    }
    if cfg.sync_snippets {
        included_items.push("snippets".to_string());
    }
    if cfg.sync_history {
        included_items.push("history".to_string());
    }

    let manifest = BackupManifest {
        version: CURRENT_BACKUP_VERSION,
        app: "chatquery".to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        timestamp: now_secs(),
        included_items,
        sha256: sha256_hex,
    };

    // 4. 准备本地 Git 仓库
    let repo_dir = git::get_sync_repo_dir();
    git::prepare_repo(&repo_dir, &cfg.git_url)?;

    // 5. 写入备份文件
    let data_file = repo_dir.join("chatquery_backup.enc");
    std::fs::write(&data_file, ciphertext)?;

    let manifest_file = repo_dir.join("manifest.json");
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|e| AppError::Msg(format!("序列化 manifest 失败: {}", e)))?;
    std::fs::write(&manifest_file, manifest_bytes)?;

    let now_dt = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();

    let readme_file = repo_dir.join("README.md");
    let readme_text = format!(
        "# ChatQuery Encrypted Backup\n\n\
         本仓库存储由 [ChatQuery](https://github.com/hel04/chatquery) 生成的加密备份数据。\n\n\
         - **数据密文**: `chatquery_backup.enc` (AES-256-GCM 高强度端到端加密)\n\
         - **元数据**: `manifest.json`\n\
         - **备份时间**: {}\n\n\
         > ⚠️ 安全提示：数据中的所有敏感凭据（数据库密码、SSH 密钥、API Key）均已由您的个人加密口令加密，Git 远端无法读取任何明文。\n",
        now_dt
    );
    let _ = std::fs::write(&readme_file, readme_text);

    // 6. 提交并推送到远端 Git
    let commit_msg = format!("chore(backup): 加密备份于 {}", now_dt);
    let pushed = git::push_backup(&repo_dir, &commit_msg)?;

    // 7. 更新配置记录
    cfg.last_backup_time = Some(now_secs());
    cfg.last_status = Some("备份成功".into());
    let _ = save_git_sync_config(&cfg);

    let conn_count = payload.connections.as_ref().map(|c| c.connections.len()).unwrap_or(0);
    let model_count = payload.models.as_ref().map(|m| m.vendor_profiles.len()).unwrap_or(0);
    let snippet_count = payload.snippets.as_ref().map(|s| s.len()).unwrap_or(0);
    let hist_count = payload.history.as_ref().map(|h| h.queries.len()).unwrap_or(0);

    let msg = if pushed {
        format!(
            "已成功加密并推送至 Git 远端：{} 个连接，{} 个模型配置，{} 条代码片段，{} 条执行历史",
            conn_count, model_count, snippet_count, hist_count
        )
    } else {
        "数据未发生变化，备份仓库已处于最新状态".to_string()
    };

    Ok(SyncResultSummary {
        success: true,
        message: msg,
        timestamp: now_secs(),
        connections_count: conn_count,
        models_count: model_count,
        snippets_count: snippet_count,
        history_count: hist_count,
    })
}

pub fn execute_restore_from_git(
    storage: &Storage,
    key_override: Option<&str>,
) -> Result<SyncResultSummary> {
    let mut cfg = load_git_sync_config();
    git::validate_git_url(&cfg.git_url)?;

    let passphrase = match key_override {
        Some(k) if !k.trim().is_empty() => k.trim().to_string(),
        _ => get_decrypted_encryption_key(&cfg)?.ok_or_else(|| {
            AppError::Msg("尚未配置加密密钥，请在同步设置中输入加密口令".into())
        })?,
    };

    let aes_key = derive_backup_key(&passphrase)?;

    let repo_dir = git::get_sync_repo_dir();
    git::prepare_repo(&repo_dir, &cfg.git_url)?;
    git::pull_repo(&repo_dir)?;

    let data_file = repo_dir.join("chatquery_backup.enc");
    if !data_file.exists() {
        return Err(AppError::Msg(
            "Git 仓库中未找到备份数据文件 (chatquery_backup.enc)，可能该仓库尚未执行过备份".into(),
        ));
    }

    let ciphertext = std::fs::read_to_string(&data_file)
        .map_err(|e| AppError::Msg(format!("读取密文备份文件失败: {}", e)))?;

    let payload = decrypt_backup_payload(&ciphertext, &aes_key)?;

    let summary = apply_backup_payload(
        storage,
        &payload,
        cfg.sync_connections,
        cfg.sync_models,
        cfg.sync_snippets,
        cfg.sync_history,
    )?;

    cfg.last_restore_time = Some(now_secs());
    cfg.last_status = Some("恢复成功".into());
    let _ = save_git_sync_config(&cfg);

    Ok(summary)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupVersionDto {
    pub hash: String,
    pub short_hash: String,
    pub timestamp: i64,
    pub message: String,
    pub app_version: Option<String>,
    pub included_items: Vec<String>,
}

/// 获取 Git 备份的历史版本列表（默认取最近 20 条）
pub fn list_backup_history(limit: usize) -> Result<Vec<BackupVersionDto>> {
    let cfg = load_git_sync_config();
    if cfg.git_url.trim().is_empty() {
        return Ok(Vec::new());
    }
    let repo_dir = git::get_sync_repo_dir();
    git::prepare_repo(&repo_dir, &cfg.git_url)?;

    let commits = git::list_commits(&repo_dir, limit)?;
    let mut out = Vec::new();
    for c in commits {
        let manifest_content = git::show_file_at_commit(&repo_dir, &c.hash, "manifest.json").ok();
        let (app_version, included_items) = if let Some(text) = manifest_content {
            if let Ok(m) = serde_json::from_str::<BackupManifest>(&text) {
                (Some(m.app_version), m.included_items)
            } else {
                (None, Vec::new())
            }
        } else {
            (None, Vec::new())
        };

        out.push(BackupVersionDto {
            hash: c.hash,
            short_hash: c.short_hash,
            timestamp: c.timestamp,
            message: c.message,
            app_version,
            included_items,
        });
    }
    Ok(out)
}

/// 回滚至指定的 Commit 版本
pub fn rollback_to_commit(
    storage: &Storage,
    commit_hash: &str,
    key_override: Option<&str>,
) -> Result<SyncResultSummary> {
    let mut cfg = load_git_sync_config();
    git::validate_git_url(&cfg.git_url)?;

    let passphrase = match key_override {
        Some(k) if !k.trim().is_empty() => k.trim().to_string(),
        _ => get_decrypted_encryption_key(&cfg)?.ok_or_else(|| {
            AppError::Msg("尚未配置加密密钥，请在同步设置中输入加密口令".into())
        })?,
    };

    let aes_key = derive_backup_key(&passphrase)?;

    let repo_dir = git::get_sync_repo_dir();
    git::prepare_repo(&repo_dir, &cfg.git_url)?;

    let ciphertext = git::show_file_at_commit(&repo_dir, commit_hash, "chatquery_backup.enc")
        .map_err(|e| AppError::Msg(format!("未能获取该历史版本的备份文件: {}", e)))?;

    let payload = decrypt_backup_payload(&ciphertext, &aes_key)?;

    let mut summary = apply_backup_payload(
        storage,
        &payload,
        cfg.sync_connections,
        cfg.sync_models,
        cfg.sync_snippets,
        cfg.sync_history,
    )?;

    let short_hash = if commit_hash.len() > 7 {
        &commit_hash[..7]
    } else {
        commit_hash
    };

    summary.message = format!(
        "已成功回滚至版本 [{}]：共还原 {} 个连接，{} 个模型配置，{} 条代码片段，{} 条执行历史",
        short_hash, summary.connections_count, summary.models_count, summary.snippets_count, summary.history_count
    );

    cfg.last_restore_time = Some(now_secs());
    cfg.last_status = Some(format!("已回滚至 {}", short_hash));
    let _ = save_git_sync_config(&cfg);

    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_backup_key_derivation() {
        let k1 = derive_backup_key("my-secret-passphrase-123").unwrap();
        let k2 = derive_backup_key("my-secret-passphrase-123").unwrap();
        let k3 = derive_backup_key("different-passphrase").unwrap();
        assert_eq!(k1, k2);
        assert_ne!(k1, k3);
    }

    #[test]
    fn test_payload_encryption_and_decryption() {
        let key = derive_backup_key("correct-passphrase").unwrap();
        let payload = BackupPayload {
            version: 1,
            app: "chatquery".into(),
            app_version: "0.1.0".into(),
            timestamp: 123456789,
            connections: None,
            models: None,
            snippets: Some(vec![SnippetBackupItem {
                id: "q_1".into(),
                name: "测试片段".into(),
                sql: "SELECT 1".into(),
                conn_id: None,
                db: None,
                created: 123456789,
            }]),
            history: None,
        };

        let ciphertext = encrypt_backup_payload(&payload, &key).unwrap();
        assert!(!ciphertext.is_empty());

        // 解密成功
        let decrypted = decrypt_backup_payload(&ciphertext, &key).unwrap();
        assert_eq!(decrypted.app, "chatquery");
        assert_eq!(decrypted.snippets.as_ref().unwrap().len(), 1);
        assert_eq!(decrypted.snippets.as_ref().unwrap()[0].name, "测试片段");

        // 错误密钥解密失败
        let wrong_key = derive_backup_key("wrong-passphrase").unwrap();
        assert!(decrypt_backup_payload(&ciphertext, &wrong_key).is_err());
    }

    #[test]
    fn test_git_url_validation() {
        assert!(git::validate_git_url("git@github.com:user/repo.git").is_ok());
        assert!(git::validate_git_url("https://github.com/user/repo.git").is_ok());
        assert!(git::validate_git_url("ssh://git@myhost.com/repo.git").is_ok());
        assert!(git::validate_git_url("ftp://example.com/repo.git").is_err());
        assert!(git::validate_git_url("not-a-git-url").is_err());
        assert!(git::validate_git_url("").is_err());
    }
}
