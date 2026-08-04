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
