use serde::Deserialize;
use std::env;

/// LLM connection settings, sourced from environment variables.
///
/// - `CHATQUERY_LLM_BASE_URL` (default `https://api.openai.com/v1`)
/// - `CHATQUERY_LLM_API_KEY`  (required; empty => LLM disabled)
/// - `CHATQUERY_LLM_MODEL`    (default `gpt-4o-mini`)
///
/// Keeping config in env (not the SQLite store) means no secret is persisted
/// on disk — consistent with ADR-004 (don't write plaintext credentials).
#[derive(Debug, Clone)]
pub struct LlmConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

impl LlmConfig {
    pub fn from_env() -> Self {
        let base_url = env_or("CHATQUERY_LLM_BASE_URL", "https://api.openai.com/v1");
        let api_key = env::var("CHATQUERY_LLM_API_KEY").unwrap_or_default();
        let model = env_or("CHATQUERY_LLM_MODEL", "gpt-4o-mini");
        Self {
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
