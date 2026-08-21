use crate::db::connection::{ConnectionConfig, DbType};
use crate::db::mysql;
use crate::db::redis;
use crate::llm::client::ToolCall;
use crate::llm::KbLoader;
use crate::mcp::host::McpHostManager;
use serde_json::Value;

/// Shared context handed to every tool when it runs. Replacing the old
/// `exec_tool` string-match with a registry means different agents (future
/// sub-agent workers) can carry different tool subsets — the foundation for
/// the multi-agent topology.
pub struct ToolContext<'a> {
    pub conns: &'a [ConnectionConfig],
    pub mcp: Option<&'a McpHostManager>,
    /// Injected knowledge-base loader (ADR-AI-6). Lets `search_knowledge` read
    /// docs bound to the active connection/db without coupling to the store.
    pub kb_loader: KbLoader,
    /// The user's currently-selected database (from the composer + →
    /// "选择数据库" picker). `execute_query` applies it automatically so the
    /// model doesn't need to pass a `db` argument on every call. None means
    /// "use the connection's default database".
    pub current_db: Option<&'a str>,
}

/// A built-in capability the agent can invoke. Modeled as an enum (not a
/// `dyn Trait`) so the registry needs no trait objects; new capabilities are
/// new variants. Different agents get registries with different subsets.
pub enum BuiltinTool {
    ExecuteQuery,
    SearchKnowledge,
}

impl BuiltinTool {
    fn name(&self) -> &str {
        match self {
            BuiltinTool::ExecuteQuery => "execute_query",
            BuiltinTool::SearchKnowledge => "search_knowledge",
        }
    }
    fn schema(&self) -> Value {
        match self {
            BuiltinTool::ExecuteQuery => serde_json::json!({
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
            }),
            BuiltinTool::SearchKnowledge => serde_json::json!({
                "type": "function",
                "function": {
                    "name": "search_knowledge",
                    "description": "在当前连接绑定的知识库里按关键词检索业务说明、字段口径、SQL 模板等内容，辅助理解数据与生成查询。绑定到当前连接（或当前库）的知识库才会被检索。",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "connection": {"type": "string", "description": "连接名称"},
                            "query": {"type": "string", "description": "检索关键词，可多个词用空格分隔"},
                            "database": {"type": "string", "description": "可选，限定具体库名；省略则用连接默认库"}
                        },
                        "required": ["connection", "query"]
                    }
                }
            }),
        }
    }
    async fn call(&self, args: &Value, ctx: &ToolContext<'_>) -> (String, String) {
        match self {
            BuiltinTool::ExecuteQuery => exec_builtin(args, ctx.conns, ctx.current_db).await,
            BuiltinTool::SearchKnowledge => exec_search_kb(args, ctx).await,
        }
    }
}

/// Registry of tools available to an agent. Holds built-in tools (a scoped
/// subset per agent) plus externally-supplied MCP tool schemas; dispatch
/// routes `execute_query` to the built-in and `mcp__*` names to the MCP host.
pub struct ToolRegistry {
    builtins: Vec<BuiltinTool>,
    external_schemas: Vec<Value>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self {
            builtins: Vec::new(),
            external_schemas: Vec::new(),
        }
    }
    pub fn register(&mut self, tool: BuiltinTool) {
        self.builtins.push(tool);
    }
    pub fn add_external_schema(&mut self, schema: Value) {
        self.external_schemas.push(schema);
    }
    pub fn schemas(&self) -> Vec<Value> {
        let mut v: Vec<Value> = self
            .builtins
            .iter()
            .map(|t| t.schema())
            .filter(|s| !s.is_null())
            .collect();
        v.extend(self.external_schemas.iter().cloned());
        v
    }
    pub async fn call(&self, tc: &ToolCall, ctx: &ToolContext<'_>) -> (String, String) {
        for t in &self.builtins {
            if t.name() == tc.name {
                return t.call(&parse_args(tc), ctx).await;
            }
        }
        if let Some((server, tool)) = decode_mcp_tool(&tc.name) {
            if let Some(mgr) = ctx.mcp {
                return match mgr.call(&server, &tool, parse_args(tc)).await {
                    Ok(out) => (format!("mcp:{}/{}", server, tool), out),
                    Err(e) => (format!("mcp:{}/{} 失败", server, tool), e.to_string()),
                };
            }
        }
        ("未知工具".into(), format!("不支持的工具: {}", tc.name))
    }
}

/// Build the default registry: the built-in query tool plus every reachable
/// MCP server's tools. Mirrors the previous flat tool list but as a registry.
pub async fn build_registry(mcp: Option<&McpHostManager>) -> ToolRegistry {
    let mut reg = ToolRegistry::new();
    reg.register(BuiltinTool::ExecuteQuery);
    reg.register(BuiltinTool::SearchKnowledge);
    if let Some(m) = mcp {
        for schema in m.all_tool_schemas().await {
            reg.add_external_schema(schema);
        }
    }
    reg
}

/// Decode `mcp__<server>__<tool>` back into its parts.
pub fn decode_mcp_tool(name: &str) -> Option<(String, String)> {
    let rest = name.strip_prefix("mcp__")?;
    let mut it = rest.splitn(2, "__");
    let server = it.next()?.to_string();
    let tool = it.next()?.to_string();
    Some((server, tool))
}

/// Match a connection by name. The system prompt's "可用连接" list shows
/// each conn as "<name> (MySQL)" so the model sees the kind next to the
/// name. Some models then pass the kind-suffixed form straight back to
/// `execute_query` — e.g. `connection: "测试环境租户库 (MySQL)"` — which
/// would otherwise miss the strict equality check on `c.name`. Strip the
/// kind suffix and try again before giving up.
fn resolve_conn<'a>(conns: &'a [ConnectionConfig], name: &str) -> Option<&'a ConnectionConfig> {
    let trimmed = name.trim();
    if let Some(c) = conns.iter().find(|c| c.name == trimmed) {
        return Some(c);
    }
    // Tolerate "name (MySQL)" / "name (Redis)" / "name（MySQL）" — strip
    // the parenthesised kind, retry, and only then report not found.
    if let Some(open) = trimmed.find(['(', '（']) {
        let stripped = trimmed[..open].trim();
        if !stripped.is_empty() {
            if let Some(c) = conns.iter().find(|c| c.name == stripped) {
                return Some(c);
            }
        }
    }
    None
}

/// Built-in `execute_query` tool: runs SQL on MySQL or a command on Redis.
async fn exec_builtin(
    args: &Value,
    conns: &[ConnectionConfig],
    current_db: Option<&str>,
) -> (String, String) {
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

    let cfg = match resolve_conn(conns, &conn_name) {
        Some(c) => c,
        None => {
            return (
                "连接未找到".into(),
                format!("找不到连接 '{}'，请用 add 添加或检查名称", conn_name),
            )
        }
    };

    // Apply the user's composer-selected db (current_db) automatically. The
    // model is told the db in context_block but does not pass it on every
    // execute_query call, so we route it server-side. Falls through to the
    // connection's default database when current_db is None/empty.
    let effective_db: Option<String> = match current_db {
        Some(s) if !s.is_empty() => Some(s.to_string()),
        _ => None,
    };
    // If the user picked a different db than the conn's default, surface
    // it in the summary line so the UI/transcript can show what was
    // actually queried.
    let db_label = effective_db
        .as_deref()
        .filter(|d| !d.is_empty() && *d != cfg.database.as_str());

    match cfg.db_type {
        DbType::Mysql => match mysql::query(cfg, &query, effective_db.as_deref(), false).await {
            Ok(r) => {
                let summary = match r.affected {
                    Some(n) => {
                        let id = if r.last_insert_id.unwrap_or(0) > 0 {
                            format!(", 自增ID {}", r.last_insert_id.unwrap_or(0))
                        } else {
                            String::new()
                        };
                        format!("{}{}: 影响 {} 行{}", conn_name, db_label.unwrap_or(""), n, id)
                    }
                    None => format!(
                        "{}{}: {} 行",
                        conn_name,
                        db_label.unwrap_or(""),
                        r.rows.len()
                    ),
                };
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

/// Built-in `search_knowledge` tool (ADR-AI-6): keyword retrieval over the
/// knowledge-base docs bound to the named connection (and optional database).
/// The loader already enforces the binding filter; here we just filter the
/// returned docs by the query terms and return the matching fragments. This is
/// the fallback for large KBs whose passive (context) injection got truncated.
async fn exec_search_kb(args: &Value, ctx: &ToolContext<'_>) -> (String, String) {
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
    let db_arg = args
        .get("database")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    if query.trim().is_empty() {
        return ("参数缺失".into(), "请提供 query 关键词".into());
    }
    let cfg = match ctx.conns.iter().find(|c| c.name == conn_name) {
        Some(c) => c,
        None => {
            return (
                "连接未找到".into(),
                format!("找不到连接 '{}'，请用已知连接名", conn_name),
            )
        }
    };
    let db: Option<String> = db_arg.or_else(|| {
        if cfg.database.is_empty() {
            None
        } else {
            Some(cfg.database.clone())
        }
    });
    let docs = (ctx.kb_loader)(&cfg.id, db.as_deref());
    let result = search_kb_content(&docs, &query);
    ("知识库检索".into(), result)
}

/// Case-insensitive keyword match over doc contents. Returns each hit doc's
/// name plus a truncated body, capped so the tool result stays small.
fn search_kb_content(docs: &[(String, String)], query: &str) -> String {
    let q = query.to_lowercase();
    let words: Vec<&str> = q
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|w| !w.is_empty())
        .collect();
    if words.is_empty() {
        return "(查询为空)".into();
    }
    let mut out = String::new();
    let mut total = 0usize;
    const CAP: usize = 6000;
    const PER_DOC: usize = 4000;
    for (name, content) in docs {
        let lower = content.to_lowercase();
        if !words.iter().any(|w| lower.contains(w)) {
            continue;
        }
        if total >= CAP {
            break;
        }
        let take: String = content.chars().take(PER_DOC).collect();
        total += take.chars().count();
        out.push_str(&format!("### 知识库文档：{}\n{}\n\n", name, take));
    }
    if out.is_empty() {
        out.push_str("(知识库中没有匹配该关键词的内容)");
    }
    out
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

fn parse_args(tc: &ToolCall) -> Value {
    serde_json::from_str(&tc.arguments).unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_query_returns_hint() {
        assert_eq!(
            search_kb_content(&[("A".into(), "x".into())], ""),
            "(查询为空)"
        );
    }

    #[test]
    fn case_insensitive_match() {
        let out = search_kb_content(&[("Doc".into(), "Hello World".into())], "hello");
        assert!(out.contains("Doc"));
        assert!(out.contains("Hello World"));
    }

    #[test]
    fn no_match_returns_hint() {
        let out = search_kb_content(&[("Doc".into(), "apple".into())], "banana");
        assert_eq!(out, "(知识库中没有匹配该关键词的内容)");
    }

    #[test]
    fn per_doc_truncation_at_4000() {
        let big = "x".repeat(5000);
        let out = search_kb_content(&[("Big".into(), big)], "x");
        let body = out.strip_prefix("### 知识库文档：Big\n").unwrap();
        // per-doc cap is 4000 chars; the formatter appends "\n\n" after it
        let content = body.trim_end();
        assert!(content.len() <= 4000);
        assert!(content.len() > 3990);
    }

    #[test]
    fn total_cap_at_6000_omits_third() {
        let d1 = "a".repeat(3000);
        let d2 = "b".repeat(3000);
        let d3 = "c".repeat(3000);
        let docs = vec![("D1".into(), d1), ("D2".into(), d2), ("D3".into(), d3)];
        // "a b c" matches all three docs
        let out = search_kb_content(&docs, "a b c");
        assert!(out.contains("D1"));
        assert!(out.contains("D2"));
        assert!(!out.contains("D3"));
    }
}
