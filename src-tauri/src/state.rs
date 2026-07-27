use chatquery::config::LlmConfig;
use chatquery::db::connection::ConnectionStore;
use chatquery::db::mysql::Schema;
use chatquery::mcp::host::McpHostManager;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Shared application state managed by Tauri.
///
/// `ConnectionStore` owns the encrypted SQLite store; the schema cache is a
/// bounded per-connection map (ADR-006: we only keep what the user has
/// actually opened). `mcp` is optional and lazily spawns child processes.
pub struct AppState {
    pub store: Mutex<ConnectionStore>,
    pub schema_cache: Mutex<HashMap<String, Schema>>,
    /// LLM config is now mutable at runtime (settings page can change vendor /
    /// key / model without a restart) — hence behind a Mutex. Loaded from the
    /// encrypted config file at startup, falling back to env vars.
    pub llm: Mutex<LlmConfig>,
    pub mcp: Option<Arc<McpHostManager>>,
}
