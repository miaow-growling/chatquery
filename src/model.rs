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
    /// 目标库（AI 未显式传库时为自动应用的当前库）；None = 连接默认库。
    pub db: Option<String>,
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
    #[serde(default)]
    pub cached_tokens: u32,
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

/// SQL the user attached to a chat turn from the query editor (ADR: Chat 引用
/// SQL, 方案 B). It travels *beside* the message text rather than inside it, so
/// the agent gets the statement together with its provenance — which connection
/// and database it came from. That provenance is the whole point: without it the
/// model has to ask "which instance?" before it can run or reason about the SQL.
///
/// Per-turn only: references are attached to the turn being sent and are never
/// replayed as history, so an old reference can't silently steer a later answer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqlReference {
    /// Connection the SQL came from — the *editor tab's* connection, which may
    /// differ from the one the chat panel is bound to.
    pub conn_id: String,
    /// Id of the editor tab the SQL was referenced from, so a chat `ref` card
    /// can jump back to it. `None` when not applicable (e.g. TUI, or a full
    /// document with no single tab concept).
    pub tab_id: Option<String>,
    /// Source database; `None` means the connection's default.
    pub db: Option<String>,
    /// `"statement"` = one statement snapped to `;` boundaries, `"full"` = the
    /// whole editor document. Free-form on the wire; unknown values degrade to
    /// a generic label rather than failing the turn.
    pub scope: String,
    pub sql: String,
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

/// 会话列表条目（docs/chat-conversation-design.md §3.2）。`conn_name` 是
/// join 连接名，仅供 UI 展示标签；`last_preview` 为最后一条消息前 60 字。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationSummary {
    pub id: String,
    pub title: String,
    pub conn_id: Option<String>,
    pub conn_name: Option<String>,
    pub created: i64,
    pub updated: i64,
    pub pinned: bool,
    pub last_preview: String,
    pub msg_count: i64,
}

/// 追加消息的入参。`id`/`seq` 由后端生成（前端只负责展示与加载），
/// `role` 走白名单：user/assistant/tool/system/plan/ref。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewChatMessage {
    pub role: String,
    pub content: String,
    /// 装饰卡片的结构化数据：ref→refs[]；plan→steps[]；assistant→usage。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<serde_json::Value>,
}

/// 已落盘的消息（回读用），`seq` 保证会话内顺序。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredChatMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<serde_json::Value>,
    pub ts: i64,
}

/// 跨会话引用（docs/chat-conversation-design.md §6）。`scope` 为
/// "session"（整段对话）或 "message"（单条消息）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationRef {
    pub conv_id: String,
    pub scope: String,
    pub message_id: Option<String>,
}

pub fn role_str(r: ChatRole) -> &'static str {
    match r {
        ChatRole::User => "user",
        ChatRole::Assistant => "assistant",
        ChatRole::Tool => "tool",
        ChatRole::System => "system",
    }
}

/// 助手绑定的数据库目标：包含连接实例 ID 及具体数据库名（database 为 None 表示使用连接的默认库）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AssistantDbBinding {
    pub conn_id: String,
    #[serde(default)]
    pub database: Option<String>,
}

/// 数据助手模型 (Data Assistant)
/// 允许用户配置专属助手：预设提示词、多选绑定具体数据库、多选绑定知识库
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataAssistant {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub avatar: Option<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default)]
    pub bound_databases: Vec<AssistantDbBinding>,
    #[serde(default)]
    pub bound_knowledge_base_ids: Vec<String>,
    pub created: i64,
    pub updated: i64,
}

/// 自动化脚本类型：shell, webhook, python, javascript
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ScriptType {
    #[default]
    Shell,
    Webhook,
    Python,
    Javascript,
}

impl ScriptType {
    pub fn as_str(&self) -> &'static str {
        match self {
            ScriptType::Shell => "shell",
            ScriptType::Webhook => "webhook",
            ScriptType::Python => "python",
            ScriptType::Javascript => "javascript",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s.to_ascii_lowercase().as_str() {
            "webhook" => ScriptType::Webhook,
            "python" => ScriptType::Python,
            "javascript" | "js" => ScriptType::Javascript,
            _ => ScriptType::Shell,
        }
    }
}

/// 数据库自动化脚本与生命周期钩子模型
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbScript {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub script_type: ScriptType,
    /// 脚本代码内容或 Webhook 配置 JSON
    #[serde(default)]
    pub content: String,
    /// 超时时间（秒，默认 30）
    #[serde(default = "default_timeout_secs")]
    pub timeout_secs: u64,
    /// 自定义环境变量或 Webhook Headers (JSON 字符串)
    #[serde(default)]
    pub env_vars: String,
    /// 绑定的数据库连接 ID 列表
    #[serde(default)]
    pub bound_conn_ids: Vec<String>,
    /// 是否在连接/查询鉴权报错时触发自愈
    #[serde(default)]
    pub trigger_on_error: bool,
    /// 错误匹配正则或关键词（如 "Access denied|password.*expired|1045"）
    #[serde(default)]
    pub error_pattern: String,
    /// 脚本成功后是否自动重试刚才的查询
    #[serde(default = "default_true")]
    pub auto_retry_query: bool,
    pub created: i64,
    pub updated: i64,
}

fn default_true() -> bool {
    true
}

fn default_timeout_secs() -> u64 {
    30
}

/// 脚本执行结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScriptExecResult {
    pub success: bool,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
    /// 是否检测到新凭证并自动更新了连接密码
    pub updated_credentials: bool,
    /// 更新后的简要提示信息（如有）
    pub update_message: Option<String>,
}


