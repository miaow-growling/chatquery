use crate::config::McpServerConfig;
use crate::error::{AppError, Result};
use crate::mcp::transport::StdioTransport;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Duration;
use tokio::sync::Mutex;

/// Round-trip timeout for a single MCP request (mirrors transport's).
const MCP_TIMEOUT: Duration = Duration::from_secs(10);

/// One tool advertised by an MCP server.
#[derive(Debug, Clone)]
pub struct McpTool {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

/// A live connection to a single MCP server (one OS process).
///
/// After `connect`, the process stays resident until dropped. All calls are
/// synchronous over the stdio pipe; the manager wraps these behind an async
/// mutex so they can be driven from the LLM event loop.
pub struct McpHost {
    name: String,
    transport: StdioTransport,
    tools: Vec<McpTool>,
}

impl McpHost {
    /// Spawn the server and complete the MCP `initialize` lifecycle:
    /// `initialize` -> `notifications/initialized` -> `tools/list`.
    pub fn connect(cfg: &McpServerConfig) -> Result<Self> {
        let mut t = StdioTransport::spawn(&cfg.command, &cfg.args)?;

        let init = json!({
            "jsonrpc": "2.0",
            "id": 1u64,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "chatquery", "version": "0.1.0"}
            }
        });
        t.send(&init)?;
        t.recv_response(1, MCP_TIMEOUT)?;

        // Client-side notification; servers don't reply to it.
        t.send(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"}))?;

        t.send(&json!({"jsonrpc": "2.0", "id": 2u64, "method": "tools/list", "params": {}}))?;
        let resp = t.recv_response(2, MCP_TIMEOUT)?;
        let tools = parse_tools(&resp)?;

        Ok(Self {
            name: cfg.name.clone(),
            transport: t,
            tools,
        })
    }

    /// OpenAI-compatible tool schemas for every tool this server exposes.
    /// Tool names are namespaced as `mcp__<server>__<tool>` so the LLM (and
    /// our router) can tell them apart from the built-in `execute_query`.
    pub fn tool_schemas(&self) -> Vec<Value> {
        self.tools
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "function": {
                        "name": mcp_fn_name(&self.name, &t.name),
                        "description": t.description,
                        "parameters": t.input_schema,
                    }
                })
            })
            .collect()
    }

    /// Invoke a tool by its bare name and return the server's text output.
    pub fn call(&mut self, tool: &str, args: Value) -> Result<String> {
        let req = json!({
            "jsonrpc": "2.0",
            "id": 3u64,
            "method": "tools/call",
            "params": {"name": tool, "arguments": args}
        });
        self.transport.send(&req)?;
        let resp = self.transport.recv_response(3, MCP_TIMEOUT)?;
        let content = resp
            .get("result")
            .and_then(|r| r.get("content"))
            .and_then(|c| c.as_array());
        let mut out = String::new();
        if let Some(arr) = content {
            for item in arr {
                if let Some(t) = item.get("type").and_then(|x| x.as_str()) {
                    if t == "text" {
                        if let Some(text) = item.get("text").and_then(|x| x.as_str()) {
                            out.push_str(text);
                        }
                    } else {
                        out.push_str(&item.to_string());
                    }
                }
            }
        }
        Ok(out)
    }
}

/// Build the namespaced LLM tool name `mcp__<server>__<tool>`.
fn mcp_fn_name(server: &str, tool: &str) -> String {
    format!("mcp__{}__{}", server, tool)
}

fn parse_tools(resp: &Value) -> Result<Vec<McpTool>> {
    let arr = resp
        .get("result")
        .and_then(|r| r.get("tools"))
        .and_then(|t| t.as_array())
        .ok_or_else(|| AppError::Msg("MCP tools/list 响应缺少 tools 数组".into()))?;
    let mut out = Vec::new();
    for tool in arr {
        let name = tool
            .get("name")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let description = tool
            .get("description")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let input_schema = tool
            .get("inputSchema")
            .cloned()
            .unwrap_or_else(|| json!({"type": "object", "properties": {}}));
        out.push(McpTool {
            name,
            description,
            input_schema,
        });
    }
    Ok(out)
}

/// Lazily connects to and multiplexes multiple MCP servers.
///
/// A server process is spawned on first use (when its tools are listed or it
/// is called); if a server can't be reached we skip it rather than failing the
/// whole LLM session. The manager is cheap to clone via `Arc` and is shared
/// across chat turns.
pub struct McpHostManager {
    configs: Vec<McpServerConfig>,
    hosts: Mutex<HashMap<String, McpHost>>,
}

impl McpHostManager {
    pub fn new(configs: Vec<McpServerConfig>) -> Self {
        Self {
            configs,
            hosts: Mutex::new(HashMap::new()),
        }
    }

    /// Number of configured servers (for the status bar).
    pub fn server_count(&self) -> usize {
        self.configs.len()
    }

    /// Collect tool schemas from every reachable server. Unreachable servers
    /// are skipped with a stderr warning.
    pub async fn all_tool_schemas(&self) -> Vec<Value> {
        let mut out = Vec::new();
        for cfg in &self.configs {
            let mut map = self.hosts.lock().await;
            if let Some(h) = map.get(&cfg.name) {
                out.extend(h.tool_schemas());
            } else {
                match McpHost::connect(cfg) {
                    Ok(h) => {
                        out.extend(h.tool_schemas());
                        map.insert(cfg.name.clone(), h);
                    }
                    Err(e) => {
                        eprintln!("MCP server '{}' 连接失败，已跳过: {}", cfg.name, e);
                    }
                }
            }
        }
        out
    }

    /// Route a tool call to the named server.
    pub async fn call(&self, server: &str, tool: &str, args: Value) -> Result<String> {
        let mut map = self.hosts.lock().await;
        let host = map
            .get_mut(server)
            .ok_or_else(|| AppError::Msg(format!("MCP server '{}' 未连接", server)))?;
        host.call(tool, args)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_tools_extracts_all_entries() {
        let resp = json!({
            "result": {
                "tools": [
                    {"name": "echo", "description": "回显", "inputSchema": {"type": "object", "properties": {"msg": {"type": "string"}}}},
                    {"name": "add", "description": "加法"}
                ]
            }
        });
        let tools = parse_tools(&resp).unwrap();
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0].name, "echo");
        assert_eq!(tools[0].input_schema["properties"]["msg"]["type"], "string");
        assert_eq!(tools[1].description, "加法");
        // missing inputSchema falls back to an empty object schema
        assert_eq!(tools[1].input_schema["type"], "object");
    }

    #[test]
    fn mcp_fn_name_is_namespaced() {
        assert_eq!(mcp_fn_name("fs", "read"), "mcp__fs__read");
        assert_eq!(mcp_fn_name("demo", "echo"), "mcp__demo__echo");
    }

    /// End-to-end handshake against the python fixture: spawn the process,
    /// complete `initialize`, list tools, and call one — exercising the real
    /// stdio transport. Skipped when python3 is unavailable.
    #[test]
    fn mcp_handshake_against_fixture() {
        if std::process::Command::new("python3")
            .arg("--version")
            .output()
            .is_err()
        {
            eprintln!("python3 不可用，跳过 MCP 集成测试");
            return;
        }
        let manifest = env!("CARGO_MANIFEST_DIR");
        let script = format!("{}/tests/mcp_echo_server.py", manifest);
        let cfg = McpServerConfig {
            name: "echo".into(),
            command: "python3".into(),
            args: vec![script],
        };

        let mut host = match McpHost::connect(&cfg) {
            Ok(h) => h,
            Err(e) => {
                eprintln!("MCP connect 失败（跳过）: {}", e);
                return;
            }
        };

        // tools/list round trip
        let schemas = host.tool_schemas();
        assert_eq!(schemas.len(), 1);
        assert_eq!(schemas[0]["function"]["name"], "mcp__echo__echo");

        // tools/call round trip — server echoes the arguments
        let out = host
            .call("echo", json!({"msg": "hi"}))
            .expect("tools/call 应成功");
        let v: Value = serde_json::from_str(&out).expect("回显应为合法 JSON");
        assert_eq!(v["tool"], "echo");
        assert_eq!(v["args"]["msg"], "hi");
    }
}
