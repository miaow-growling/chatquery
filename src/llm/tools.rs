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
    /// The active session's bound connection ID.
    pub current_conn: Option<&'a str>,
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
            BuiltinTool::ExecuteQuery => {
                exec_builtin(args, ctx.conns, ctx.current_db, ctx.current_conn).await
            }
            BuiltinTool::SearchKnowledge => exec_search_kb(args, ctx).await,
        }
    }
}

/// A role's tool capability set. The registry hands each Agent only the
/// tools its role may call, so "Explorer is read-only" is enforced by what
/// the model can even *see* and *call* — not by asking it nicely in the prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolScope {
    /// Full access: read + write. For Orchestrator, Executor, and simple turns.
    Full,
    /// Read-only discovery. No statement that can mutate data may be
    /// executed, even if the model hallucinated one.
    ReadOnly,
}

impl ToolScope {
    pub fn allows_write(self) -> bool {
        matches!(self, ToolScope::Full)
    }
}

/// Helper to check whether an external MCP tool schema hints read-only capability.
pub fn mcp_schema_is_read_only(schema: &Value) -> bool {
    schema
        .get("annotations")
        .and_then(|a| a.get("readOnlyHint"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// Registry of tools available to an agent. Holds built-in tools (a scoped
/// subset per agent) plus externally-supplied MCP tool schemas; dispatch
/// routes `execute_query` to the built-in and `mcp__*` names to the MCP host.
pub struct ToolRegistry {
    builtins: Vec<BuiltinTool>,
    external_schemas: Vec<Value>,
    /// Capability ceiling for this registry. Enforced at dispatch, so a
    /// misbehaving or injected model cannot exceed it.
    pub scope: ToolScope,
}

impl Default for ToolRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self {
            builtins: Vec::new(),
            external_schemas: Vec::new(),
            scope: ToolScope::Full,
        }
    }
    pub fn with_scope(mut self, scope: ToolScope) -> Self {
        self.scope = scope;
        self
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

/// Build the default registry: the built-in query tool plus reachable
/// MCP server's tools filtered by the requested scope.
pub async fn build_registry(
    mcp: Option<&McpHostManager>,
    scope: ToolScope,
) -> ToolRegistry {
    let mut reg = ToolRegistry::new();
    reg.register(BuiltinTool::ExecuteQuery);
    reg.register(BuiltinTool::SearchKnowledge);
    if let Some(m) = mcp {
        for schema in m.all_tool_schemas().await {
            // ReadOnly 作用域下，不把未知副作用的外部工具暴露给模型；
            // 采用保守拒绝策略，仅当明确带有 readOnlyHint 为 true 时才暴露
            if scope == ToolScope::ReadOnly && !mcp_schema_is_read_only(&schema) {
                continue;
            }
            reg.add_external_schema(schema);
        }
    }
    reg.scope = scope;
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

/// Match a connection by name, id, or smart fuzzy resolution.
/// 兼容大模型可能传入的多种连接形态：
/// 1. 传空、"default"、"current" 时，自动回退到当前会话激活的连接；
/// 2. 精确连接名；
/// 3. 连接 ID（如 c18ceac36451a7d68）；
/// 4. 剥离 UI/日志格式中的数据库后缀（如 "华为云租户库04 · mycommunity_cszjxh" 或 "华为云租户库04: mycommunity_cszjxh"）；
/// 5. 剥离括号类型后缀（如 "华为云租户库04 (MySQL)" / "华为云租户库04（MySQL）"）；
/// 6. 大小写不敏感及包裹符号（反引号、引号）容错；
/// 7. 误将目标数据库名当作连接名（如 connection: "mycommunity_cszjxh"）；
/// 8. 会话当前连接兜底（当模型在单连接会话中胡乱推导连接名时）。
pub fn resolve_conn<'a>(
    conns: &'a [ConnectionConfig],
    name: &str,
    current_conn_id: Option<&str>,
) -> Option<&'a ConnectionConfig> {
    let raw = name.trim();
    let trimmed = raw
        .trim_matches('`')
        .trim_matches('"')
        .trim_matches('\'')
        .trim();

    // 1. 如果模型未传连接名、或传了空/default/current，优先使用当前会话已绑定的连接
    if trimmed.is_empty()
        || trimmed.eq_ignore_ascii_case("default")
        || trimmed.eq_ignore_ascii_case("current")
    {
        if let Some(cid) = current_conn_id {
            if let Some(c) = conns.iter().find(|c| c.id == cid) {
                return Some(c);
            }
        }
        if conns.len() == 1 {
            return conns.first();
        }
    }

    // 2. 精确匹配连接名
    if let Some(c) = conns.iter().find(|c| c.name == trimmed) {
        return Some(c);
    }

    // 3. 匹配连接 ID（模型有时会把 conn_id 当作参数传入）
    if let Some(c) = conns.iter().find(|c| c.id == trimmed) {
        return Some(c);
    }

    // 4. 剥离 UI/日志格式中的数据库后缀（例如 "华为云租户库04 · mycommunity_cszjxh" 或 "华为云租户库04: mycommunity_cszjxh"）
    for sep in &['·', ':', '/'] {
        if let Some(pos) = trimmed.find(*sep) {
            let prefix = trimmed[..pos].trim();
            if !prefix.is_empty() {
                if let Some(c) = conns.iter().find(|c| c.name == prefix || c.id == prefix) {
                    return Some(c);
                }
            }
        }
    }

    // 5. 剥离括号类型后缀（例如 "华为云租户库04 (MySQL)" / "华为云租户库04（MySQL）"）
    if let Some(open) = trimmed.find(['(', '（']) {
        let stripped = trimmed[..open].trim();
        if !stripped.is_empty() {
            if let Some(c) = conns.iter().find(|c| c.name == stripped || c.id == stripped) {
                return Some(c);
            }
        }
    }

    // 6. 大小写不敏感匹配
    if let Some(c) = conns.iter().find(|c| c.name.eq_ignore_ascii_case(trimmed)) {
        return Some(c);
    }

    // 7. 匹配数据库名：如果模型误将数据库名传为连接名（例如 connection: "mycommunity_cszjxh"）
    if let Some(c) = conns.iter().find(|c| !c.database.is_empty() && c.database.eq_ignore_ascii_case(trimmed)) {
        return Some(c);
    }

    // 8. 兜底：如果会话明确处于某个 active 连接上下文中，且输入无法匹配任何连接，回退到当前活动连接
    if let Some(cid) = current_conn_id {
        if let Some(c) = conns.iter().find(|c| c.id == cid) {
            return Some(c);
        }
    }

    None
}

/// Built-in `execute_query` tool: runs SQL on MySQL or a command on Redis.
async fn exec_builtin(
    args: &Value,
    conns: &[ConnectionConfig],
    current_db: Option<&str>,
    current_conn: Option<&str>,
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

    let cfg = match resolve_conn(conns, &conn_name, current_conn) {
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
    let target_label = match effective_db.as_deref().filter(|d| !d.is_empty()) {
        Some(d) => format!("{} · {}", conn_name, d),
        None => conn_name.clone(),
    };

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
                        format!("{}: 影响 {} 行{}", target_label, n, id)
                    }
                    None => format!(
                        "{}: {} 行",
                        target_label,
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
                    let raw_lines = if crate::mask::masking_enabled() {
                        let m = crate::mask::mask_redis_result(&r);
                        m.lines
                    } else {
                        r.lines
                    };
                    let detail = raw_lines
                        .iter()
                        .map(|l| truncate_line(l))
                        .collect::<Vec<_>>()
                        .join("\n");
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
    let cfg = match resolve_conn(ctx.conns, &conn_name, ctx.current_conn) {
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
    let result = crate::store::search_kb_text(&docs, &query);
    ("知识库检索".into(), result)
}

/// Maximum characters per table cell when formatting query results for the LLM.
/// Protects the LLM context window from being flooded by huge JSON payloads,
/// stack traces, or text blobs (inspired by DBX cell-level windowing).
pub const CELL_CHAR_LIMIT: usize = 300;

/// Maximum characters per Redis output line to protect LLM context.
pub const REDIS_LINE_CHAR_LIMIT: usize = 500;

fn truncate_cell(val: &str) -> String {
    let char_count = val.chars().count();
    if char_count <= CELL_CHAR_LIMIT {
        val.to_string()
    } else {
        let prefix: String = val.chars().take(CELL_CHAR_LIMIT).collect();
        format!("{}...[truncated {} chars]", prefix, char_count - CELL_CHAR_LIMIT)
    }
}

fn truncate_line(val: &str) -> String {
    let char_count = val.chars().count();
    if char_count <= REDIS_LINE_CHAR_LIMIT {
        val.to_string()
    } else {
        let prefix: String = val.chars().take(REDIS_LINE_CHAR_LIMIT).collect();
        format!("{}...[truncated {} chars]", prefix, char_count - REDIS_LINE_CHAR_LIMIT)
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
        let cells: Vec<String> = row.iter().map(|c| truncate_cell(c)).collect();
        s.push_str(&cells.join("\t"));
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
    use crate::store::search_kb_text as search_kb_content;

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

    #[test]
    fn format_result_table_truncates_huge_cells() {
        let cols = vec!["id".into(), "payload".into()];
        let huge_val = "x".repeat(500);
        let rows = vec![vec!["1".into(), huge_val]];
        let table = format_result_table(&cols, &rows);
        assert!(table.contains("...[truncated 200 chars]"));
        assert!(table.starts_with("id\tpayload\n"));
    }

    #[test]
    fn format_result_table_preserves_short_cells() {
        let cols = vec!["id".into(), "name".into()];
        let rows = vec![vec!["1".into(), "Alice".into()]];
        let table = format_result_table(&cols, &rows);
        assert_eq!(table, "id\tname\n1\tAlice\n");
    }

    #[test]
    fn test_resolve_conn_smart_matching() {
        let conns = vec![
            ConnectionConfig {
                id: "c18ceac36451a7d68".into(),
                name: "华为云租户库04".into(),
                db_type: DbType::Mysql,
                host: "127.0.0.1".into(),
                port: 3306,
                user: "root".into(),
                password: "".into(),
                database: "mycommunity_cszjxh".into(),
                ssl_mode: String::new(),
                ssl_ca: String::new(),
                client_cert: String::new(),
                client_key: String::new(),
                ssh_host: String::new(),
                ssh_port: 22,
                ssh_user: String::new(),
                ssh_auth_kind: String::new(),
                ssh_password: String::new(),
                ssh_private_key: String::new(),
                group_id: None,
            },
        ];

        // 1. Exact name match
        assert_eq!(resolve_conn(&conns, "华为云租户库04", None).unwrap().id, "c18ceac36451a7d68");
        // 2. ID match
        assert_eq!(resolve_conn(&conns, "c18ceac36451a7d68", None).unwrap().id, "c18ceac36451a7d68");
        // 3. UI label with database dot separator
        assert_eq!(resolve_conn(&conns, "华为云租户库04 · mycommunity_cszjxh", None).unwrap().id, "c18ceac36451a7d68");
        // 4. Suffix with type in parens
        assert_eq!(resolve_conn(&conns, "华为云租户库04 (MySQL)", None).unwrap().id, "c18ceac36451a7d68");
        assert_eq!(resolve_conn(&conns, "华为云租户库04（MySQL）", None).unwrap().id, "c18ceac36451a7d68");
        // 5. Quoted
        assert_eq!(resolve_conn(&conns, "`华为云租户库04`", None).unwrap().id, "c18ceac36451a7d68");
        // 6. Database name passed as connection
        assert_eq!(resolve_conn(&conns, "mycommunity_cszjxh", None).unwrap().id, "c18ceac36451a7d68");
        // 7. Empty or default with current_conn_id fallback
        assert_eq!(resolve_conn(&conns, "", Some("c18ceac36451a7d68")).unwrap().id, "c18ceac36451a7d68");
        assert_eq!(resolve_conn(&conns, "default", Some("c18ceac36451a7d68")).unwrap().id, "c18ceac36451a7d68");
        assert_eq!(resolve_conn(&conns, "unknown_name", Some("c18ceac36451a7d68")).unwrap().id, "c18ceac36451a7d68");
    }
}
