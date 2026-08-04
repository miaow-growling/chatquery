pub mod client;
pub mod control;
pub mod memory;
pub mod planner;
pub mod policy;
pub mod session;
pub mod tools;
pub mod worker;

/// Closure injected by the command layer so the `llm` crate stays free of the
/// storage backend. Given a connection id and an optional database, it returns
/// the knowledge-base docs (name, content) bound to that context. A no-op
/// (empty vec) is the safe default for environments without a store (TUI).
pub type KbLoader = std::sync::Arc<
    dyn Fn(&str, Option<&str>) -> Vec<(String, String)> + Send + Sync,
>;

/// Audit event for a write operation gated by the safety guardrail (ADR-AI-1
/// 决策3). Emitted by the agent and persisted by the host (Tauri command) via
/// `AuditSink`. Kept as plain data so it serializes trivially if needed.
pub struct AuditEvent {
    pub conn_id: String,
    pub conn_name: String,
    pub db: Option<String>,
    pub sql: String,
    /// One of: "write-approved" | "write-rejected" | "write-expired" | "deny".
    pub decision: &'static str,
}

/// Host callback that persists an `AuditEvent`. Injected by the Tauri command
/// (writes to the store) and by the TUI (no-op). Mirrors `KbLoader` so the
/// `llm` crate stays free of the storage backend.
pub type AuditSink = std::sync::Arc<dyn Fn(&AuditEvent) + Send + Sync>;
