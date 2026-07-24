use crate::config::LlmConfig;
use crate::db::connection::ConnectionConfig;
use crate::error::Result;
use crate::llm::client::stream_chat;
use crate::llm::tools::{exec_tool, tool_schema};
use crate::mcp::host::McpHostManager;
use crate::model::{BackendMsg, ChatMessage, ChatRole, ToolCallBrief};
use std::sync::Arc;
use tokio::sync::mpsc::UnboundedSender;

/// Bound the tool-call round trips so a misbehaving model can't loop forever.
const MAX_TOOL_ITERS: usize = 5;

/// Run a full LLM turn: stream the assistant reply, execute any tool calls,
/// feed the results back, and loop until the model replies without tools.
/// Progress is reported over `tx` so the TUI can render live.
pub async fn run_turn(
    cfg: &LlmConfig,
    conns: Vec<ConnectionConfig>,
    mcp: Option<Arc<McpHostManager>>,
    history: &[ChatMessage],
    tx: &UnboundedSender<BackendMsg>,
) -> Result<()> {
    let mut tools = vec![tool_schema()];
    if let Some(m) = &mcp {
        tools.extend(m.all_tool_schemas().await);
    }
    let mut messages: Vec<ChatMessage> = history.to_vec();

    for _ in 0..MAX_TOOL_ITERS {
        let choice = stream_chat(cfg, &messages, &tools, &mut |delta: &str| {
            let _ = tx.send(BackendMsg::ChatToken(delta.to_string()));
        })
        .await?;

        if choice.tool_calls.is_empty() {
            if !choice.content.trim().is_empty() {
                messages.push(ChatMessage::assistant(choice.content.clone()));
            }
            break;
        }

        // Persist the assistant message carrying tool calls (required for the API round-trip).
        let tcs: Vec<ToolCallBrief> = choice
            .tool_calls
            .iter()
            .map(|t| ToolCallBrief {
                id: t.id.clone(),
                name: t.name.clone(),
                arguments: t.arguments.clone(),
            })
            .collect();
        messages.push(ChatMessage {
            role: ChatRole::Assistant,
            content: choice.content.clone(),
            tool_calls: Some(tcs),
            tool_call_id: None,
        });

        for tc in &choice.tool_calls {
            let (summary, detail) = exec_tool(tc, &conns, mcp.as_deref()).await;
            let _ = tx.send(BackendMsg::ChatTool(format!("{} → {}", tc.name, summary)));
            messages.push(ChatMessage {
                role: ChatRole::Tool,
                content: detail,
                tool_calls: None,
                tool_call_id: Some(tc.id.clone()),
            });
        }
    }

    Ok(())
}
