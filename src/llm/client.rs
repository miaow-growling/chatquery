use crate::config::LlmProvider;
use crate::config::LlmConfig;
use crate::error::{AppError, Result};
use crate::model::{role_str, ChatMessage, TokenUsage};
use futures::StreamExt;
use serde_json::{json, Value};
use std::collections::HashMap;

/// A single tool invocation requested by the model during a streaming turn.
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

/// Fetch a vendor's model catalog: OpenAI-compatible `GET {base}/models`
/// (Bearer auth) or Anthropic's `GET {base}/models` (x-api-key). Powers the
/// settings UI's "从远程拉取" button so users never hand-type model ids.
/// Returns sorted, deduped ids.
pub async fn list_models(base_url: &str, api_key: &str, anthropic: bool) -> Result<Vec<String>> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(AppError::Reqwest)?;
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let resp = if anthropic {
        client
            .get(&url)
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .send()
            .await
            .map_err(AppError::Reqwest)?
    } else {
        client
            .get(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .send()
            .await
            .map_err(AppError::Reqwest)?
    };
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        // Keep (a slice of) the body: providers put the actionable reason
        // there — quota exhausted, invalid key, wrong region …
        let short: String = text.chars().take(300).collect();
        return Err(AppError::Msg(format!("HTTP {}: {}", status, short)));
    }

    let val: Value = serde_json::from_str(&text)
        .map_err(|e| AppError::Msg(format!("响应解析 JSON 失败: {}", e)))?;

    let mut ids = Vec::new();
    let array_opt = val
        .get("data")
        .or_else(|| val.get("models"))
        .or_else(|| val.get("items"))
        .and_then(|v| v.as_array())
        .or_else(|| val.as_array());

    if let Some(arr) = array_opt {
        for item in arr {
            if let Some(s) = item.as_str() {
                if !s.is_empty() {
                    ids.push(s.to_string());
                }
            } else if let Some(obj) = item.as_object() {
                let id = obj
                    .get("id")
                    .or_else(|| obj.get("name"))
                    .or_else(|| obj.get("model_name"))
                    .or_else(|| obj.get("model"))
                    .and_then(|v| v.as_str());
                if let Some(s) = id {
                    if !s.is_empty() {
                        ids.push(s.to_string());
                    }
                }
            }
        }
    }

    ids.sort();
    ids.dedup();
    if ids.is_empty() {
        return Err(AppError::Msg("接口返回的模型列表为空".into()));
    }
    Ok(ids)
}

/// The assembled assistant choice after a streaming call completes.
pub struct ChatChoice {
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
    /// Token usage if the provider reported it (OpenAI `usage` chunk, Anthropic
    /// `message_start`+`message_delta`). `None` when the endpoint didn't report.
    pub usage: Option<TokenUsage>,
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

/// Extract token usage from an OpenAI streaming `usage` chunk. OpenAI emits a
/// final chunk whose `choices` is empty and `usage` carries the totals; we take
/// the last one seen (later chunks override earlier).
fn extract_openai_usage(v: &Value) -> Option<TokenUsage> {
    let u = v.get("usage")?.as_object()?;
    let p = u.get("prompt_tokens").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
    let c = u.get("completion_tokens").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
    let t = u.get("total_tokens").and_then(|x| x.as_u64()).unwrap_or((p + c) as u64) as u32;
    let cached = u
        .get("prompt_tokens_details")
        .and_then(|d| d.get("cached_tokens"))
        .and_then(|x| x.as_u64())
        .or_else(|| u.get("prompt_cache_hit_tokens").and_then(|x| x.as_u64()))
        .unwrap_or(0) as u32;
    Some(TokenUsage {
        prompt_tokens: p,
        completion_tokens: c,
        total_tokens: t,
        cached_tokens: cached,
    })
}

/// Fold Anthropic token usage from a single SSE event into the running totals.
/// `input_tokens` lives in `message_start`; `output_tokens` in `message_delta`.
fn extract_anthropic_usage(v: &Value, input: &mut u32, output: &mut u32, cached: &mut u32) {
    match v.get("type").and_then(|t| t.as_str()) {
        Some("message_start") => {
            if let Some(u) = v.get("message").and_then(|m| m.get("usage")) {
                *input = u.get("input_tokens").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
                *cached = u.get("cache_read_input_tokens").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
            }
        }
        Some("message_delta") => {
            if let Some(u) = v.get("delta").and_then(|d| d.get("usage")) {
                *output = u.get("output_tokens").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
            }
        }
        _ => {}
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
                // OpenAI protocol requires assistant tool_calls to be wrapped
                // as `{id, type:"function", function:{name, arguments}}`.
                // `ToolCallBrief` is a flat `{id, name, arguments}` for our own
                // bookkeeping, so we re-shape it here at the wire boundary.
                // (Anthropic path has its own converter further down — it
                // never goes through this branch.) 2026-08-14.
                let wire: Vec<Value> = tcs
                    .iter()
                    .map(|t| {
                        json!({
                            "id": t.id,
                            "type": "function",
                            "function": {
                                "name": t.name,
                                "arguments": t.arguments,
                            }
                        })
                    })
                    .collect();
                o.insert("tool_calls".into(), Value::Array(wire));
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
        "max_tokens": 4096,
        // OpenAI streams omit `usage` by default; this asks the provider to
        // append a final `usage` chunk so the token strip shows real numbers
        // (honoured by OpenAI / DeepSeek / Kimi / Qwen / vLLM / Ollama …;
        // services that ignore it just keep streaming normally). 2026-08-12.
        "stream_options": { "include_usage": true },
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
    let mut is_reasoning = false;
    let mut finish_reason_length = false;
    let mut stream_buf = String::new();
    let mut in_tool_tag = false;
    let mut usage: Option<TokenUsage> = None;
    let mut tool_acc: HashMap<usize, (String, String, String)> = HashMap::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(AppError::Reqwest)?;
        let text = String::from_utf8_lossy(&chunk);
        parse_sse(&mut sse_buf, &text, &mut data_lines);

        for data in data_lines.drain(..) {
            if let Ok(v) = serde_json::from_str::<Value>(&data) {
                if let Some(u) = extract_openai_usage(&v) {
                    usage = Some(u);
                }
                if let Some(ch) = v
                    .get("choices")
                    .and_then(|c| c.as_array())
                    .and_then(|c| c.first())
                {
                    if let Some(fr) = ch.get("finish_reason").and_then(|x| x.as_str()) {
                        if fr == "length" {
                            finish_reason_length = true;
                        }
                    }
                    if let Some(delta) = ch.get("delta") {
                        // Reasoning/thinking tokens from models like DeepSeek-R1, MiniMax, Qwen
                        let reasoning = delta
                            .get("reasoning_content")
                            .or_else(|| delta.get("reasoning"))
                            .and_then(|x| x.as_str());
                        if let Some(r) = reasoning {
                            if !r.is_empty() {
                                if !is_reasoning {
                                    is_reasoning = true;
                                    content.push_str("<think>\n");
                                    on_delta("<think>\n");
                                }
                                content.push_str(r);
                                on_delta(r);
                            }
                        }

                        if let Some(c) = delta.get("content").and_then(|x| x.as_str()) {
                            if !c.is_empty() {
                                if is_reasoning {
                                    is_reasoning = false;
                                    content.push_str("\n</think>\n\n");
                                    on_delta("\n</think>\n\n");
                                }
                                content.push_str(c);
                                stream_buf.push_str(c);

                                if in_tool_tag {
                                    if let Some(end_idx) = find_tag_end(&stream_buf) {
                                        in_tool_tag = false;
                                        let remaining = stream_buf[end_idx..].to_string();
                                        stream_buf = remaining;
                                    } else {
                                        stream_buf.clear();
                                    }
                                }

                                if !in_tool_tag {
                                    if stream_buf.contains("<<function_calls>>")
                                        || stream_buf.contains("<invoke")
                                        || stream_buf.contains("<tool_call>")
                                    {
                                        in_tool_tag = true;
                                        let earliest = [
                                            stream_buf.find("<<function_calls>>"),
                                            stream_buf.find("<invoke"),
                                            stream_buf.find("<tool_call>"),
                                        ]
                                        .iter()
                                        .filter_map(|&x| x)
                                        .min()
                                        .unwrap_or(0);

                                        if earliest > 0 {
                                            on_delta(&stream_buf[..earliest]);
                                        }
                                        let remaining = stream_buf[earliest..].to_string();
                                        stream_buf = remaining;
                                    } else {
                                        // Buffer any trailing prefix of a potential tool tag so "<" or "<<" never leaks to UI
                                        const PREFIXES: &[&str] = &[
                                            "<<function_calls>", "<<function_calls", "<<function_call",
                                            "<<function_cal", "<<function_ca", "<<function_c",
                                            "<<function_", "<<function", "<<functio", "<<functi",
                                            "<<funct", "<<func", "<<fun", "<<fu", "<<f", "<<",
                                            "<invoke", "<invok", "<invo", "<inv", "<in", "<i",
                                            "<tool_call>", "<tool_call", "<tool_cal", "<tool_ca",
                                            "<tool_c", "<tool_", "<tool", "<too", "<to", "<t",
                                            "<",
                                        ];
                                        let mut hold_len = 0;
                                        for p in PREFIXES {
                                            if stream_buf.ends_with(p) && p.len() > hold_len {
                                                hold_len = p.len();
                                            }
                                        }

                                        if hold_len > 0 {
                                            let emit_len = stream_buf.len() - hold_len;
                                            if emit_len > 0 {
                                                on_delta(&stream_buf[..emit_len]);
                                                let held = stream_buf[emit_len..].to_string();
                                                stream_buf = held;
                                            }
                                        } else {
                                            on_delta(&stream_buf);
                                            stream_buf.clear();
                                        }
                                    }
                                }
                            }
                        }
                        if let Some(tcs) = delta.get("tool_calls").and_then(|x| x.as_array()) {
                            if is_reasoning {
                                is_reasoning = false;
                                content.push_str("\n</think>\n\n");
                                on_delta("\n</think>\n\n");
                            }
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

    if is_reasoning {
        content.push_str("\n</think>\n\n");
        on_delta("\n</think>\n\n");
    }

    if !in_tool_tag && !stream_buf.is_empty() {
        on_delta(&stream_buf);
    }

    if finish_reason_length {
        let warn = "\n\n⚠️ [已达到单次生成 Token 上限截断]";
        content.push_str(warn);
        on_delta(warn);
    }

    let mut tool_calls: Vec<ToolCall> = tool_acc
        .into_iter()
        .map(|(_, (id, name, arguments))| ToolCall {
            id,
            name,
            arguments,
        })
        .collect();

    // Fallback: models (such as MiniMax-M3) occasionally emit tool calls as text
    // inside `content` instead of in `delta.tool_calls`. Extract and clean them.
    if tool_calls.is_empty() {
        tool_calls = extract_text_tool_calls(&mut content);
    }

    Ok(ChatChoice { content, tool_calls, usage })
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
    let mut is_reasoning = false;
    let mut finish_reason_length = false;
    // index → (id, name, accumulated partial_json) for in-progress tool blocks.
    let mut tool_blocks: HashMap<usize, (String, String, String)> = HashMap::new();
    // Token usage split across events: input_tokens in `message_start`,
    // output_tokens in `message_delta`.
    let mut input_tokens: u32 = 0;
    let mut output_tokens: u32 = 0;
    let mut cached_tokens: u32 = 0;
    // Finalized tool calls, moved here on `content_block_stop`.
    let mut tool_calls: Vec<ToolCall> = Vec::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(AppError::Reqwest)?;
        let text = String::from_utf8_lossy(&chunk);
        parse_sse(&mut sse_buf, &text, &mut data_lines);

        for data in data_lines.drain(..) {
            if let Ok(v) = serde_json::from_str::<Value>(&data) {
                let etype = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
                extract_anthropic_usage(&v, &mut input_tokens, &mut output_tokens, &mut cached_tokens);
                match etype {
                    "content_block_start" => {
                        if v.get("content_block")
                            .and_then(|b| b.get("type"))
                            .and_then(|x| x.as_str())
                            == Some("tool_use")
                        {
                            if is_reasoning {
                                is_reasoning = false;
                                content.push_str("\n</think>\n\n");
                                on_delta("\n</think>\n\n");
                            }
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
                                Some("thinking_delta") => {
                                    if let Some(t) =
                                        delta.get("thinking").and_then(|x| x.as_str())
                                    {
                                        if !t.is_empty() {
                                            if !is_reasoning {
                                                is_reasoning = true;
                                                content.push_str("<think>\n");
                                                on_delta("<think>\n");
                                            }
                                            content.push_str(t);
                                            on_delta(t);
                                        }
                                    }
                                }
                                Some("text_delta") => {
                                    if is_reasoning {
                                        is_reasoning = false;
                                        content.push_str("\n</think>\n\n");
                                        on_delta("\n</think>\n\n");
                                    }
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
                                    if is_reasoning {
                                        is_reasoning = false;
                                        content.push_str("\n</think>\n\n");
                                        on_delta("\n</think>\n\n");
                                    }
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
                    "message_delta" => {
                        if let Some(d) = v.get("delta") {
                            if let Some(sr) = d.get("stop_reason").and_then(|x| x.as_str()) {
                                if sr == "max_tokens" {
                                    finish_reason_length = true;
                                }
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

    if is_reasoning {
        content.push_str("\n</think>\n\n");
        on_delta("\n</think>\n\n");
    }

    if finish_reason_length {
        let warn = "\n\n⚠️ [已达到单次生成 Token 上限截断]";
        content.push_str(warn);
        on_delta(warn);
    }

    // Any block still in-flight at stream end (shouldn't happen, but be safe).
    for (_, (id, name, arguments)) in tool_blocks {
        if !id.is_empty() {
            tool_calls.push(ToolCall { id, name, arguments });
        }
    }

    if tool_calls.is_empty() {
        tool_calls = extract_text_tool_calls(&mut content);
    }

    let usage = if input_tokens > 0 || output_tokens > 0 {
        Some(TokenUsage {
            prompt_tokens: input_tokens,
            completion_tokens: output_tokens,
            total_tokens: input_tokens + output_tokens,
            cached_tokens,
        })
    } else {
        None
    };
    Ok(ChatChoice { content, tool_calls, usage })
}

fn find_tag_end(buf: &str) -> Option<usize> {
    let ends = [
        buf.find("</invoke>").map(|i| i + "</invoke>".len()),
        buf.find("</function_calls>>").map(|i| i + "</function_calls>>".len()),
        buf.find("</tool_call>").map(|i| i + "</tool_call>".len()),
    ];
    ends.iter().filter_map(|&x| x).max()
}

/// Extract text-based function calls from `content` (such as MiniMax's
/// `<<function_calls>> <invoke name="...">` or `<tool_call>...` blocks).
/// When found, builds real `ToolCall` instances and strips the raw tags from `content`.
pub fn extract_text_tool_calls(content: &mut String) -> Vec<ToolCall> {
    let mut tool_calls = Vec::new();

    // 1. MiniMax format: <<function_calls>> <invoke name="..."> <parameter name="...">value</parameter> </invoke>
    if content.contains("<invoke") || content.contains("<<function_calls>>") {
        let mut rest = content.as_str();
        while let Some(invoke_start) = rest.find("<invoke") {
            let after_invoke = &rest[invoke_start..];
            if let Some(name_start_idx) = after_invoke.find("name=") {
                let quote_char = after_invoke[name_start_idx + 5..].chars().next().unwrap_or('"');
                if quote_char == '"' || quote_char == '\'' {
                    let name_val_start = name_start_idx + 6;
                    if let Some(name_val_end) = after_invoke[name_val_start..].find(quote_char) {
                        let tool_name = &after_invoke[name_val_start..name_val_start + name_val_end];
                        let invoke_end_offset = after_invoke
                            .find("</invoke>")
                            .map(|idx| idx + "</invoke>".len())
                            .or_else(|| after_invoke[7..].find("<invoke").map(|idx| idx + 7))
                            .unwrap_or(after_invoke.len());

                        let invoke_block = &after_invoke[..invoke_end_offset];
                        let mut params_map = serde_json::Map::new();
                        let mut param_rest = invoke_block;
                        while let Some(param_start) = param_rest.find("<parameter") {
                            let after_param = &param_rest[param_start..];
                            if let Some(pname_start) = after_param.find("name=") {
                                let p_quote = after_param[pname_start + 5..].chars().next().unwrap_or('"');
                                if p_quote == '"' || p_quote == '\'' {
                                    let p_start = pname_start + 6;
                                    if let Some(p_end) = after_param[p_start..].find(p_quote) {
                                        let param_name = &after_param[p_start..p_start + p_end];
                                        if let Some(tag_close) = after_param[p_start + p_end..].find('>') {
                                            let val_start = p_start + p_end + tag_close + 1;
                                            let val_end = if let Some(pend) = after_param[val_start..].find("</parameter>") {
                                                val_start + pend
                                            } else if let Some(next_p) = after_param[val_start..].find("<parameter") {
                                                val_start + next_p
                                            } else if let Some(end_inv) = after_param[val_start..].find("</invoke>") {
                                                val_start + end_inv
                                            } else {
                                                after_param.len()
                                            };
                                            let param_val = after_param[val_start..val_end].trim();
                                            params_map.insert(
                                                param_name.to_string(),
                                                serde_json::Value::String(param_val.to_string()),
                                            );
                                            param_rest = &after_param[val_end..];
                                            continue;
                                        }
                                    }
                                }
                            }
                            param_rest = &after_param[10.min(after_param.len())..];
                        }

                        if !tool_name.trim().is_empty() {
                            let nanos = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_nanos();
                            tool_calls.push(ToolCall {
                                id: format!("call_txt_{:x}", nanos),
                                name: tool_name.trim().to_string(),
                                arguments: serde_json::Value::Object(params_map).to_string(),
                            });
                        }
                    }
                }
            }
            rest = &after_invoke[7.min(after_invoke.len())..];
        }
    }

    // 2. Generic <tool_call> {"name": "...", "arguments": {...}} </tool_call>
    if content.contains("<tool_call>") {
        let mut rest = content.as_str();
        while let Some(start) = rest.find("<tool_call>") {
            let after = &rest[start + "<tool_call>".len()..];
            if let Some(end) = after.find("</tool_call>") {
                let json_str = after[..end].trim();
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(json_str) {
                    if let Some(name) = v.get("name").and_then(|x| x.as_str()) {
                        let arguments = match v.get("arguments") {
                            Some(serde_json::Value::String(s)) => s.clone(),
                            Some(other) => other.to_string(),
                            None => "{}".to_string(),
                        };
                        let nanos = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_nanos();
                        tool_calls.push(ToolCall {
                            id: format!("call_json_{:x}", nanos),
                            name: name.to_string(),
                            arguments,
                        });
                    }
                }
                rest = &after[end + "</tool_call>".len()..];
            } else {
                break;
            }
        }
    }

    // If any tool calls were parsed, strip the XML/tool tags from content so they don't leak into UI.
    if !tool_calls.is_empty() {
        let intermediate = content
            .replace("<<function_calls>>", "")
            .replace("</function_calls>>", "")
            .replace("<function_calls>", "")
            .replace("</function_calls>", "");

        let mut clean = String::with_capacity(intermediate.len());
        let mut curr = intermediate.as_str();
        while let Some(start) = curr.find("<invoke") {
            clean.push_str(&curr[..start]);
            if let Some(end) = curr[start..].find("</invoke>") {
                curr = &curr[start + end + "</invoke>".len()..];
            } else {
                curr = "";
                break;
            }
        }
        clean.push_str(curr);

        let mut clean2 = String::with_capacity(clean.len());
        let mut curr2 = clean.as_str();
        while let Some(start) = curr2.find("<tool_call>") {
            clean2.push_str(&curr2[..start]);
            if let Some(end) = curr2[start..].find("</tool_call>") {
                curr2 = &curr2[start + end + "</tool_call>".len()..];
            } else {
                curr2 = "";
                break;
            }
        }
        clean2.push_str(curr2);

        *content = clean2.trim().to_string();
    }

    tool_calls
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
    fn extracts_openai_usage() {
        let v: Value = serde_json::from_str(
            r#"{"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}"#,
        )
        .unwrap();
        let u = extract_openai_usage(&v).unwrap();
        assert_eq!(u.prompt_tokens, 10);
        assert_eq!(u.completion_tokens, 5);
        assert_eq!(u.total_tokens, 15);
    }

    #[test]
    fn openai_usage_absent_is_none() {
        let v: Value = serde_json::from_str(r#"{"choices":[]}"#).unwrap();
        assert!(extract_openai_usage(&v).is_none());
    }

    #[test]
    fn extracts_anthropic_usage() {
        let start: Value =
            serde_json::from_str(r#"{"type":"message_start","message":{"usage":{"input_tokens":7,"cache_read_input_tokens":4}}}"#)
                .unwrap();
        let delta: Value =
            serde_json::from_str(r#"{"type":"message_delta","delta":{"usage":{"output_tokens":3}}}"#)
                .unwrap();
        let mut i = 0u32;
        let mut o = 0u32;
        let mut c = 0u32;
        extract_anthropic_usage(&start, &mut i, &mut o, &mut c);
        assert_eq!(i, 7);
        assert_eq!(c, 4);
        extract_anthropic_usage(&delta, &mut i, &mut o, &mut c);
        assert_eq!(o, 3);
    }

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

    #[test]
    fn extracts_minimax_function_calls() {
        let mut content = "我来帮您查询配置。\n<<function_calls>> <invoke name=\"execute_query\"> <parameter name=\"connection\">华为云租户库01</parameter> <parameter name=\"query\">SELECT * FROM yk_config WHERE code = 'ai_kefu_scope';</parameter> </invoke>".to_string();
        let tools = extract_text_tool_calls(&mut content);
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "execute_query");
        let args: Value = serde_json::from_str(&tools[0].arguments).unwrap();
        assert_eq!(args["connection"], "华为云租户库01");
        assert_eq!(args["query"], "SELECT * FROM yk_config WHERE code = 'ai_kefu_scope';");
        // Check that raw tags were stripped from content
        assert!(!content.contains("<<function_calls>>"));
        assert!(!content.contains("<invoke"));
        assert_eq!(content, "我来帮您查询配置。");
    }

    #[test]
    fn extracts_tool_call_json_block() {
        let mut content = "准备执行查询：\n<tool_call>\n{\"name\": \"execute_query\", \"arguments\": {\"connection\": \"c1\", \"query\": \"SELECT 1\"}}\n</tool_call>".to_string();
        let tools = extract_text_tool_calls(&mut content);
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "execute_query");
        let args: Value = serde_json::from_str(&tools[0].arguments).unwrap();
        assert_eq!(args["connection"], "c1");
        assert!(!content.contains("<tool_call>"));
        assert_eq!(content, "准备执行查询：");
    }
}
