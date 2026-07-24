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

/// Stream one chat-completion call (OpenAI-compatible, SSE).
///
/// Incrementally invokes `on_delta` with assistant text as it arrives. Tool
/// calls are accumulated from the streamed `tool_calls` deltas and returned
/// in `ChatChoice` once the stream ends.
pub async fn stream_chat(
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

/// Append `new_data` to `buffer`, extract any *complete* `data:` SSE lines,
/// leaving any trailing partial line in `buffer` for the next call.
/// `data: [DONE]` is skipped.
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
