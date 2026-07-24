use crate::db::mysql::QueryResult;
use crate::db::redis::RedisResult;
use serde::{Deserialize, Serialize};

/// Unified query result produced by DB adapters for the TUI.
/// Redis commands return key/value/array outputs, not a fixed table —
/// hence the union rather than forcing everything into MySQL's shape.
#[derive(Debug)]
pub enum DisplayResult {
    Table(QueryResult),
    Redis(RedisResult),
}

/// Messages sent from the async backend to the TUI event loop.
#[derive(Debug)]
pub enum BackendMsg {
    /// A DB query finished (success).
    Result(DisplayResult),
    /// Any backend error (DB or LLM).
    Error(String),
    /// Incremental assistant text delta during an LLM turn.
    ChatToken(String),
    /// A tool invocation notice, e.g. "execute_query → demo: 12 行".
    ChatTool(String),
    /// The LLM turn finished; commit any streamed assistant text.
    ChatDone,
    /// Connection health update (id, ok?).
    ConnHealth(String, bool),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    User,
    Assistant,
    Tool,
    System,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ToolCallBrief {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: String,
    /// Present on assistant messages that requested tool calls (for the API round-trip).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCallBrief>>,
    /// Present on tool-result messages (matches the originating tool_call id).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

impl ChatMessage {
    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: ChatRole::User,
            content: content.into(),
            tool_calls: None,
            tool_call_id: None,
        }
    }
    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: ChatRole::Assistant,
            content: content.into(),
            tool_calls: None,
            tool_call_id: None,
        }
    }
    pub fn tool(content: impl Into<String>) -> Self {
        Self {
            role: ChatRole::Tool,
            content: content.into(),
            tool_calls: None,
            tool_call_id: None,
        }
    }
}

pub fn role_str(r: ChatRole) -> &'static str {
    match r {
        ChatRole::User => "user",
        ChatRole::Assistant => "assistant",
        ChatRole::Tool => "tool",
        ChatRole::System => "system",
    }
}
