use crate::config::LlmProvider;
use crate::config::LlmConfig;
use crate::error::{AppError, Result};
use crate::model::{role_str, ChatMessage};
use futures::StreamExt;
use serde_json::{json, Value};
use std::collections::HashMap;

/// A single tool invocation requested by the model during a streaming turn.
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

/// The assembled assistant choice after a streaming call completes.
pub struct ChatChoice {
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
}

/// Stream one chat-completion call, dispatching on the configured protocol.
///
/// OpenAI-compatible vendors (OpenAI, 阿里云, 腾讯云, DeepSeek, 智谱,
/// OpenRouter, Ollama …) share one client. Anthropic speaks a different
/// protocol (auth header, top-level `system`, `tool_use` blocks) and has its
/// own implementation below.
pub async fn stream_chat(
    cfg: &LlmConfig,
    messages: &[ChatMessage],
    tools: &[Value],
    on_delta: &mut (dyn FnMut(&str) + Send),
) -> Result<ChatChoice> {
    match cfg.provider {
        LlmProvider::OpenAi => {
            stream_chat_openai(cfg, messages, tools, on_delta).await
        }
        LlmProvider::Anthropic => {
            stream_chat_anthropic(cfg, messages, tools, on_delta).await
        }
    }
}

/// OpenAI-compatible streaming chat completion (SSE). Incrementally invokes
/// `on_delta` with assistant text; tool calls are accumulated from the
/// streamed `tool_calls` deltas and returned in `ChatChoice`.
async fn stream_chat_openai(
    cfg: &LlmConfig,
    messages: &[ChatMessage],
    tools: &[Value],
    on_delta: &mut (dyn FnMut(&str) + Send),
) -> Result<ChatChoice> {
    let client = reqwest::Client::new();
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));

    let msgs: Vec<Value> = messages
        .iter()
        .map(|m| {
            let mut o = serde_json::Map::new();
            o.insert("role".into(), json!(role_str(m.role)));
            o.insert("content".into(), json!(m.content));
            if let Some(tcs) = &m.tool_calls {
                o.insert("tool_calls".into(), json!(tcs));
            }
            if let Some(id) = &m.tool_call_id {
                o.insert("tool_call_id".into(), json!(id));
            }
            Value::Object(o)
        })
        .collect();

    let mut body = json!({
        "model": cfg.model,
        "messages": msgs,
        "stream": true,
    });
    if !tools.is_empty() {
        body["tools"] = json!(tools);
        body["tool_choice"] = json!("auto");
    }

    let resp = client
        .post(&url)
        .bearer_auth(&cfg.api_key)
        .json(&body)
        .send()
        .await
        .map_err(AppError::Reqwest)?;

    if !resp.status().is_success() {
        let status = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        return Err(AppError::Msg(format!("LLM HTTP {}: {}", status, txt)));
    }

    let mut stream = resp.bytes_stream();
    let mut sse_buf = String::new();
    let mut data_lines: Vec<String> = Vec::new();
    let mut content = String::new();
    let mut tool_acc: HashMap<usize, (String, String, String)> = HashMap::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(AppError::Reqwest)?;
        let text = String::from_utf8_lossy(&chunk);
        parse_sse(&mut sse_buf, &text, &mut data_lines);

        for data in data_lines.drain(..) {
            if let Ok(v) = serde_json::from_str::<Value>(&data) {
                if let Some(ch) = v
                    .get("choices")
                    .and_then(|c| c.as_array())
                    .and_then(|c| c.first())
                {
                    if let Some(delta) = ch.get("delta") {
                        if let Some(c) = delta.get("content").and_then(|x| x.as_str()) {
                            if !c.is_empty() {
                                content.push_str(c);
                                on_delta(c);
                            }
                        }
                        if let Some(tcs) = delta.get("tool_calls").and_then(|x| x.as_array()) {
                            for tc in tcs {
                                let idx = tc
                                    .get("index")
                                    .and_then(|x| x.as_u64())
                                    .unwrap_or(0) as usize;
                                let id = tc
                                    .get("id")
                                    .and_then(|x| x.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let name = tc
                                    .get("function")
                                    .and_then(|f| f.get("name"))
                                    .and_then(|x| x.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let args = tc
                                    .get("function")
                                    .and_then(|f| f.get("arguments"))
                                    .and_then(|x| x.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let e = tool_acc
                                    .entry(idx)
                                    .or_insert_with(|| (String::new(), String::new(), String::new()));
                                if !id.is_empty() {
                                    e.0 = id;
                                }
                                if !name.is_empty() {
                                    e.1 = name;
                                }
                                e.2.push_str(&args);
                            }
                        }
                    }
                }
            }
        }
    }

    let tool_calls = tool_acc
        .into_iter()
        .map(|(_, (id, name, arguments))| ToolCall {
            id,
            name,
            arguments,
        })
        .collect();

    Ok(ChatChoice { content, tool_calls })
}

/// Anthropic Messages API streaming chat completion (SSE).
///
/// Differences from OpenAI: `x-api-key` + `anthropic-version` auth, `system`
/// is a top-level field (not a message), tool calls become `tool_use` content
/// blocks, and tool results become a `user` message whose `content` is an
/// array of `tool_result` blocks. Text arrives as `text_delta`; tool arguments
/// stream as `input_json_delta` partial JSON.
async fn stream_chat_anthropic(
    cfg: &LlmConfig,
    messages: &[ChatMessage],
    tools: &[Value],
    on_delta: &mut (dyn FnMut(&str) + Send),
) -> Result<ChatChoice> {
    let client = reqwest::Client::new();
    let url = format!("{}/messages", cfg.base_url.trim_end_matches('/'));

    let mut system = String::new();
    let mut ant_msgs: Vec<Value> = Vec::new();
    // Tool results are buffered into one `user` message (Anthropic wants them
    // grouped as `tool_result` blocks in a single user turn).
    let mut pending_tool_results: Vec<Value> = Vec::new();

    for m in messages {
        match m.role {
            crate::model::ChatRole::System => {
                if !system.is_empty() {
                    system.push('\n');
                }
                system.push_str(&m.content);
            }
            crate::model::ChatRole::User => {
                if !pending_tool_results.is_empty() {
                    let blocks = std::mem::take(&mut pending_tool_results);
                    ant_msgs.push(json!({ "role": "user", "content": blocks }));
                }
                ant_msgs.push(json!({ "role": "user", "content": m.content }));
            }
            crate::model::ChatRole::Assistant => {
                if let Some(tcs) = &m.tool_calls {
                    let mut blocks: Vec<Value> = Vec::new();
                    if !m.content.is_empty() {
                        blocks.push(json!({ "type": "text", "text": m.content }));
                    }
                    for t in tcs {
                        let input =
                            serde_json::from_str::<Value>(&t.arguments).unwrap_or(Value::Null);
                        blocks.push(json!({
                            "type": "tool_use",
                            "id": t.id,
                            "name": t.name,
                            "input": input
                        }));
                    }
                    ant_msgs.push(json!({ "role": "assistant", "content": blocks }));
                } else {
                    ant_msgs.push(json!({ "role": "assistant", "content": m.content }));
                }
            }
            crate::model::ChatRole::Tool => {
                let id = m.tool_call_id.clone().unwrap_or_default();
                pending_tool_results.push(json!({
                    "type": "tool_result",
                    "tool_use_id": id,
                    "content": m.content
                }));
            }
        }
    }
    if !pending_tool_results.is_empty() {
        ant_msgs.push(json!({ "role": "user", "content": pending_tool_results }));
    }

    // OpenAI-style `{type:function, function:{name,description,parameters}}`
    // → Anthropic `{name, description, input_schema: parameters}`.
    let tools_ant: Vec<Value> = tools
        .iter()
        .filter_map(|t| {
            t.get("function").map(|f| {
                json!({
                    "name": f.get("name").cloned().unwrap_or(Value::Null),
                    "description": f.get("description").cloned().unwrap_or(Value::Null),
                    "input_schema": f.get("parameters").cloned().unwrap_or(json!({})),
                })
            })
        })
        .collect();

    let mut body = json!({
        "model": cfg.model,
        "max_tokens": 4096,
        "messages": ant_msgs,
    });
    if !system.is_empty() {
        body["system"] = json!(system);
    }
    if !tools_ant.is_empty() {
        body["tools"] = json!(tools_ant);
        body["tool_choice"] = json!({ "type": "auto" });
    }

    let resp = client
        .post(&url)
        .header("x-api-key", &cfg.api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .map_err(AppError::Reqwest)?;

    if !resp.status().is_success() {
        let status = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        return Err(AppError::Msg(format!("LLM HTTP {}: {}", status, txt)));
    }

    let mut stream = resp.bytes_stream();
    let mut sse_buf = String::new();
    let mut data_lines: Vec<String> = Vec::new();
    let mut content = String::new();
    // index → (id, name, accumulated partial_json) for in-progress tool blocks.
    let mut tool_blocks: HashMap<usize, (String, String, String)> = HashMap::new();
    // Finalized tool calls, moved here on `content_block_stop`.
    let mut tool_calls: Vec<ToolCall> = Vec::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(AppError::Reqwest)?;
        let text = String::from_utf8_lossy(&chunk);
        parse_sse(&mut sse_buf, &text, &mut data_lines);

        for data in data_lines.drain(..) {
            if let Ok(v) = serde_json::from_str::<Value>(&data) {
                let etype = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
                match etype {
                    "content_block_start" => {
                        if v.get("content_block")
                            .and_then(|b| b.get("type"))
                            .and_then(|x| x.as_str())
                            == Some("tool_use")
                        {
                            let idx = v.get("index").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
                            let id = v
                                .get("content_block")
                                .and_then(|b| b.get("id"))
                                .and_then(|x| x.as_str())
                                .unwrap_or("")
                                .to_string();
                            let name = v
                                .get("content_block")
                                .and_then(|b| b.get("name"))
                                .and_then(|x| x.as_str())
                                .unwrap_or("")
                                .to_string();
                            tool_blocks.insert(idx, (id, name, String::new()));
                        }
                    }
                    "content_block_delta" => {
                        let idx = v.get("index").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
                        if let Some(delta) = v.get("delta") {
                            match delta.get("type").and_then(|x| x.as_str()) {
                                Some("text_delta") => {
                                    if let Some(t) =
                                        delta.get("text").and_then(|x| x.as_str())
                                    {
                                        if !t.is_empty() {
                                            content.push_str(t);
                                            on_delta(t);
                                        }
                                    }
                                }
                                Some("input_json_delta") => {
                                    if let Some(p) = delta
                                        .get("partial_json")
                                        .and_then(|x| x.as_str())
                                    {
                                        if let Some(e) = tool_blocks.get_mut(&idx) {
                                            e.2.push_str(p);
                                        }
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    "content_block_stop" => {
                        let idx = v.get("index").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
                        // A tool_use block carries an id; a text block does not.
                        if let Some((id, name, args)) = tool_blocks.remove(&idx) {
                            if !id.is_empty() {
                                tool_calls.push(ToolCall {
                                    id,
                                    name,
                                    arguments: args,
                                });
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    // Any block still in-flight at stream end (shouldn't happen, but be safe).
    for (_, (id, name, arguments)) in tool_blocks {
        if !id.is_empty() {
            tool_calls.push(ToolCall { id, name, arguments });
        }
    }

    Ok(ChatChoice { content, tool_calls })
}

/// Append `new_data` to `buffer`, extract any *complete* `data:` SSE lines,
/// leaving any trailing partial line in `buffer` for the next call.
/// `data: [DONE]` is skipped (OpenAI convention; Anthropic has no such marker
/// but its `data:` lines are plain JSON events, which parse fine).
pub fn parse_sse(buffer: &mut String, new_data: &str, out: &mut Vec<String>) {
    buffer.push_str(new_data);
    while let Some(nl) = buffer.find('\n') {
        let line: String = buffer.drain(..=nl).collect();
        let line = line.trim_end().to_string();
        if let Some(data) = line.strip_prefix("data:") {
            let data = data.trim();
            if !data.is_empty() && data != "[DONE]" {
                out.push(data.to_string());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_sse_extracts_data_lines() {
        let mut buf = String::new();
        let mut out = Vec::new();
        parse_sse(&mut buf, "data: {\"a\":1}\n\ndata: {\"b\":2}\n", &mut out);
        assert_eq!(out, vec!["{\"a\":1}".to_string(), "{\"b\":2}".to_string()]);

        // a partial line should be retained, not emitted
        let mut out2 = Vec::new();
        parse_sse(&mut buf, "data: {\"c\":", &mut out2);
        assert!(out2.is_empty());

        // completion of the partial line
        parse_sse(&mut buf, "3}\n", &mut out2);
        assert_eq!(out2, vec!["{\"c\":3}".to_string()]);
    }
}
