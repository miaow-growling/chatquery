use crate::db::connection::{ConnectionConfig, DbType};
use crate::db::mysql;
use crate::db::redis;
use crate::llm::client::ToolCall;
use crate::mcp::host::McpHostManager;
use serde_json::json;

/// JSON schema for the built-in `execute_query` tool (OpenAI-compatible).
pub fn tool_schema() -> serde_json::Value {
    json!({
        "type": "function",
        "function": {
            "name": "execute_query",
            "description": "在已配置的数据库连接上执行查询。MySQL 传 SQL 语句；Redis 传单条命令（如 GET foo）。",
            "parameters": {
                "type": "object",
                "properties": {
                    "connection": {"type": "string", "description": "连接名称（add 时指定的 name）"},
                    "query": {"type": "string", "description": "MySQL 写 SQL；Redis 写单条命令"}
                },
                "required": ["connection", "query"]
            }
        }
    })
}

/// Execute a tool call. Built-in `execute_query` talks to a configured DB;
/// anything prefixed `mcp__` is routed to the MCP host manager. Returns
/// `(one-line summary for the UI, full detail fed back to the model)`.
pub async fn exec_tool(
    tc: &ToolCall,
    conns: &[ConnectionConfig],
    mcp: Option<&McpHostManager>,
) -> (String, String) {
    if tc.name == "execute_query" {
        return exec_builtin(tc, conns).await;
    }
    if let Some(mgr) = mcp {
        if let Some((server, tool)) = decode_mcp_tool(&tc.name) {
            let args: serde_json::Value =
                serde_json::from_str(&tc.arguments).unwrap_or(serde_json::Value::Null);
            return match mgr.call(&server, &tool, args).await {
                Ok(out) => (format!("mcp:{}/{}", server, tool), out),
                Err(e) => (format!("mcp:{}/{} 失败", server, tool), e.to_string()),
            };
        }
    }
    ("未知工具".into(), format!("不支持的工具: {}", tc.name))
}

/// Decode `mcp__<server>__<tool>` back into its parts.
pub fn decode_mcp_tool(name: &str) -> Option<(String, String)> {
    let rest = name.strip_prefix("mcp__")?;
    let mut it = rest.splitn(2, "__");
    let server = it.next()?.to_string();
    let tool = it.next()?.to_string();
    Some((server, tool))
}

/// Built-in `execute_query` tool: runs SQL on MySQL or a command on Redis.
async fn exec_builtin(tc: &ToolCall, conns: &[ConnectionConfig]) -> (String, String) {
    let args: serde_json::Value = match serde_json::from_str(&tc.arguments) {
        Ok(v) => v,
        Err(e) => return ("参数解析失败".into(), format!("工具参数不是合法 JSON: {}", e)),
    };
    let conn_name = args
        .get("connection")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let query = args
        .get("query")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let cfg = match conns.iter().find(|c| c.name == conn_name) {
        Some(c) => c,
        None => {
            return (
                "连接未找到".into(),
                format!("找不到连接 '{}'，请用 add 添加或检查名称", conn_name),
            )
        }
    };

    match cfg.db_type {
        DbType::Mysql => match mysql::query(cfg, &query, None).await {
            Ok(r) => {
                let summary = format!("{}: {} 行", conn_name, r.rows.len());
                // The detail is what reaches the cloud model — mask it (the
                // local TUI still shows the real data via a separate path).
                let detail = if crate::mask::masking_enabled() {
                    let m = crate::mask::mask_query_result(&r);
                    format_result_table(&m.columns, &m.rows)
                } else {
                    format_result_table(&r.columns, &r.rows)
                };
                (summary, detail)
            }
            Err(e) => ("MySQL 执行失败".into(), e.to_string()),
        },
        DbType::Redis => match redis::query(cfg, &query).await {
            Ok(r) => {
                if r.lines.is_empty() {
                    (format!("{}: {}", conn_name, r.note), r.note.clone())
                } else {
                    let summary = format!("{}: {} 项", conn_name, r.lines.len());
                    let detail = if crate::mask::masking_enabled() {
                        let m = crate::mask::mask_redis_result(&r);
                        m.lines.join("\n")
                    } else {
                        r.lines.join("\n")
                    };
                    (summary, detail)
                }
            }
            Err(e) => ("Redis 执行失败".into(), e.to_string()),
        },
    }
}

fn format_result_table(columns: &[String], rows: &[Vec<String>]) -> String {
    if columns.is_empty() {
        return "(无结果集)".into();
    }
    let mut s = String::new();
    s.push_str(&columns.join("\t"));
    s.push('\n');
    for row in rows {
    s.push_str(&row.join("\t"));
    s.push('\n');
    }
    s
}
