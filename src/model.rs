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

/// A write statement the guardrail stopped, waiting for the user's verdict
/// (ADR-AI-1 + ADR-AI-4). Serialized straight to the UI, which renders a modal
/// and answers via `resolve_confirm(turn_id, id, approved)`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfirmRequest {
    /// Unique id of this confirmation (scoped by turn).
    pub id: String,
    /// The turn that is blocked on the answer.
    pub turn_id: String,
    /// Connection name the statement targets.
    pub connection: String,
    /// The exact statement that will run if approved.
    pub sql: String,
    /// Human-readable reason the guardrail intervened.
    pub reason: String,
}

/// Token accounting for a single LLM turn (ADR-AI-4 决策3: cost observability).
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct TokenUsage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
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
    /// The orchestrator's execution plan, as structured steps. Sent instead of
    /// inlining the plan into the token stream so the UI can render it as its
    /// own card rather than as assistant prose.
    ChatPlan(Vec<String>),
    /// The agent needs the user to approve a write statement before it runs.
    ChatConfirm(ConfirmRequest),
    /// The LLM turn finished; commit any streamed assistant text.
    ChatDone,
    /// Cumulative token usage for the turn, emitted before `ChatDone`.
    ChatUsage(TokenUsage),
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
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: ChatRole::System,
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
