use crate::crypto;
use serde::{Deserialize, Serialize};
use std::env;

/// Which wire protocol the chosen vendor speaks.
///
/// `OpenAi` covers every OpenAI-compatible endpoint (OpenAI itself, 阿里云
/// 通义千问 DashScope, 腾讯云混元, DeepSeek, 智谱 GLM, OpenRouter, Ollama,
/// Azure OpenAI …) — they all expose `/chat/completions` with bearer auth.
/// `Anthropic` is NOT OpenAI-compatible: different auth header, a top-level
/// `system` field, and `tool_use`/`tool_result` content blocks, so it needs
/// its own client branch (see `llm::client::stream_chat_anthropic`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LlmProvider {
    OpenAi,
    Anthropic,
}

impl LlmProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            LlmProvider::OpenAi => "openai",
            LlmProvider::Anthropic => "anthropic",
        }
    }
}

/// A selectable vendor preset shown in the settings UI. `base_url`/`model`
/// are just defaults — the UI lets the user edit both after picking a vendor.
pub struct VendorPreset {
    pub id: &'static str,
    pub label: &'static str,
    pub provider: LlmProvider,
    pub base_url: &'static str,
    pub model: &'static str,
}

/// Built-in vendor presets. `custom` is the "bring your own OpenAI-compatible
/// endpoint" escape hatch (empty base_url/model so the user fills them in).
pub const VENDOR_PRESETS: &[VendorPreset] = &[
    VendorPreset {
        id: "openai",
        label: "OpenAI",
        provider: LlmProvider::OpenAi,
        base_url: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
    },
    VendorPreset {
        id: "aliyun",
        label: "阿里云通义千问",
        provider: LlmProvider::OpenAi,
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen-plus",
    },
    VendorPreset {
        id: "tencent",
        label: "腾讯云混元",
        provider: LlmProvider::OpenAi,
        base_url: "https://api.hunyuan.cloud.tencent.com/v1",
        model: "hunyuan-turbo",
    },
    VendorPreset {
        id: "tokenhub",
        label: "腾讯 TokenHub",
        provider: LlmProvider::OpenAi,
        base_url: "https://tokenhub.tencentmaas.com/v1",
        model: "hy3",
    },
    VendorPreset {
        id: "deepseek",
        label: "DeepSeek",
        provider: LlmProvider::OpenAi,
        base_url: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
    },
    VendorPreset {
        id: "zhipu",
        label: "智谱 GLM",
        provider: LlmProvider::OpenAi,
        base_url: "https://open.bigmodel.cn/api/ai/v1",
        model: "glm-4-flash",
    },
    VendorPreset {
        id: "openrouter",
        label: "OpenRouter",
        provider: LlmProvider::OpenAi,
        base_url: "https://openrouter.ai/api/v1",
        model: "openai/gpt-4o-mini",
    },
    VendorPreset {
        id: "ollama",
        label: "Ollama (本地)",
        provider: LlmProvider::OpenAi,
        base_url: "http://localhost:11434/v1",
        model: "llama3",
    },
    VendorPreset {
        id: "anthropic",
        label: "Anthropic Claude",
        provider: LlmProvider::Anthropic,
        base_url: "https://api.anthropic.com/v1",
        model: "claude-3-7-sonnet-20250219",
    },
    VendorPreset {
        id: "custom",
        label: "自定义 (OpenAI 兼容)",
        provider: LlmProvider::OpenAi,
        base_url: "",
        model: "",
    },
];

/// Resolve the protocol for a vendor id. Unknown / `custom` → OpenAI-compatible.
pub fn provider_for_vendor(vendor: &str) -> LlmProvider {
    VENDOR_PRESETS
        .iter()
        .find(|p| p.id == vendor)
        .map(|p| p.provider)
        .unwrap_or(LlmProvider::OpenAi)
}

/// LLM connection settings.
///
/// Secrets are persisted encrypted-at-rest (ADR-004): `api_key` is written as
/// an AES-GCM ciphertext via `crypto`, never in plaintext, reusing the same
/// encrypted-store mechanism as DB connection passwords. `base_url`/`model`/
/// `vendor`/`provider` are non-sensitive and stored as plaintext in the same
/// JSON file (`~/.config/chatquery/llm.json`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmConfig {
    pub provider: LlmProvider,
    pub vendor: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

/// On-disk shape. `api_key_enc` is the encrypted api_key (empty = no key).
/// `provider` is optional for forward-compat with older files.
#[derive(Serialize, Deserialize)]
struct LlmConfigFile {
    #[serde(default)]
    provider: Option<LlmProvider>,
    #[serde(default)]
    vendor: String,
    base_url: String,
    model: String,
    #[serde(default)]
    api_key_enc: String,
}

impl LlmConfig {
    /// Load persisted config (decrypting the api_key). Falls back to env vars
    /// when no file exists yet — so dev workflows keep working unchanged.
    pub fn load() -> Self {
        let path = llm_config_path();
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(f) = serde_json::from_str::<LlmConfigFile>(&text) {
                let api_key = f
                    .api_key_enc
                    .as_str()
                    .strip_prefix('$')
                    .filter(|e| !e.is_empty())
                    .and_then(|e| crypto::load_key().ok().and_then(|k| crypto::decrypt(e, &k).ok()))
                    .unwrap_or_default();
                return LlmConfig {
                    provider: f.provider.unwrap_or(LlmProvider::OpenAi),
                    vendor: f.vendor,
                    base_url: f.base_url,
                    api_key,
                    model: f.model,
                };
            }
        }
        LlmConfig::from_env()
    }

    /// Persist config: non-secret fields plaintext, api_key encrypted.
    pub fn save(&self) -> Result<(), String> {
        let key = crypto::load_key().map_err(|e| e.to_string())?;
        let api_key_enc = if self.api_key.is_empty() {
            String::new()
        } else {
            "$".to_string()
                + &crypto::encrypt(&self.api_key, &key).map_err(|e| e.to_string())?
        };
        let f = LlmConfigFile {
            provider: Some(self.provider),
            vendor: self.vendor.clone(),
            base_url: self.base_url.clone(),
            model: self.model.clone(),
            api_key_enc,
        };
        let path = llm_config_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let bytes = serde_json::to_vec_pretty(&f).map_err(|e| e.to_string())?;
        std::fs::write(&path, bytes).map_err(|e| e.to_string())
    }

    /// Dev override via env vars. `CHATQUERY_LLM_VENDOR=anthropic` selects the
    /// Anthropic protocol; everything else is treated as OpenAI-compatible.
    pub fn from_env() -> Self {
        let vendor = env_or("CHATQUERY_LLM_VENDOR", "custom");
        let base_url = env_or("CHATQUERY_LLM_BASE_URL", "https://api.openai.com/v1");
        let api_key = env::var("CHATQUERY_LLM_API_KEY").unwrap_or_default();
        let model = env_or("CHATQUERY_LLM_MODEL", "gpt-4o-mini");
        let provider = if vendor == "anthropic" {
            LlmProvider::Anthropic
        } else {
            LlmProvider::OpenAi
        };
        Self {
            provider,
            vendor,
            base_url,
            api_key,
            model,
        }
    }

    pub fn enabled(&self) -> bool {
        !self.api_key.is_empty()
    }
}

fn env_or(key: &str, default: &str) -> String {
    env::var(key).unwrap_or_else(|_| default.to_string())
}

fn llm_config_path() -> std::path::PathBuf {
    crypto::config_dir().join("llm.json")
}

/// A single MCP server to launch as a child process (stdio transport).
/// Sourced from `CHATQUERY_MCP_SERVERS` as a JSON array, e.g.:
/// `[{"name":"fs","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"]}]`
///
/// Kept in env (not the SQLite store) so no command/arg is persisted on disk
/// and nothing here is a secret — consistent with ADR-004.
#[derive(Debug, Clone, Deserialize)]
pub struct McpServerConfig {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
}

/// Parse MCP server definitions from the `CHATQUERY_MCP_SERVERS` env var.
/// Returns an empty vec when unset or unparseable (LLM just won't see MCP
/// tools) — never crashes startup on a bad value.
pub fn load_mcp_servers() -> Vec<McpServerConfig> {
    match env::var("CHATQUERY_MCP_SERVERS") {
        Ok(s) if !s.trim().is_empty() => serde_json::from_str(&s).unwrap_or_default(),
        _ => Vec::new(),
    }
}
