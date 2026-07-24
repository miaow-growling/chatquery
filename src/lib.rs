// ChatQuery backend library.
//
// All domain logic (db adapters, LLM, MCP, masking, storage) lives here as a
// plain Rust library with no UI dependency. The TUI (`mod tui`, behind the
// `tui` feature) and the Tauri desktop frontend (`src-tauri/`) both consume
// this crate — the backend is written once and shared.

pub mod config;
pub mod crypto;
pub mod db;
pub mod error;
pub mod llm;
pub mod mask;
pub mod mcp;
pub mod model;
pub mod store;

// The terminal UI is optional: the Tauri desktop build pulls in this crate
// with `default-features = false` so it never compiles ratatui/crossterm.
#[cfg(feature = "tui")]
pub mod tui;
