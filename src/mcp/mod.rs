//! MCP (Model Context Protocol) host support.
//!
//! An MCP server runs as a *separate OS process* under our control: we spawn
//! it, talk JSON-RPC 2.0 over its stdin/stdout, and kill it on shutdown. This
//! is deliberate process isolation (ADR-003): a misbehaving or crashing MCP
//! server cannot corrupt the main program's memory, and the memory it uses is
//! never counted against our <30MB working set.

pub mod host;
pub mod transport;
