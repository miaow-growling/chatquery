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
    pub llm: LlmConfig,
    pub mcp: Option<Arc<McpHostManager>>,
}
